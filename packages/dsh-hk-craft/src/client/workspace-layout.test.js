'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { MAIN_SOURCE, PANE_SOURCE, PANEL_KEY, createPaneController } = require('./dsh-pane-host.js')
const { layoutKey, encodeLayout, decodeLayout } = require('./layout-store.js')
const {
  createLayout,
  openPane,
  split,
  resize,
  setView,
  leaves,
} = require('./layout-tree.js')

const FACTORY_PRESENT = [{ type: 'factory', name: 'conversation.content', scope: 'session-maybe' }]

/** @param {string} paneId @param {string} sessionId @param {string} [view] */
function pane(paneId, sessionId, view = 'chat') {
  return { paneId, sessionId, view }
}

/** Two workspace layouts: w1 one pane, w2 one pane. */
function twoWorkspaces() {
  return {
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
    w2: openPane(createLayout('w2'), pane('p2', 's3')),
  }
}

const TWO_WORKSPACES = [
  { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
  { workspaceId: 'w2', sessionIds: ['s3', 's4'] },
  { workspaceId: 'w3', sessionIds: [] },
]

/**
 * In-memory storage plus a helper that reads through the real codec, so a test
 * never asserts against its own hand-rolled payload shape.
 */
function memoryStorage(seed = {}) {
  const entries = new Map()
  for (const [workspaceId, layout] of Object.entries(seed)) {
    entries.set(layoutKey(workspaceId), encodeLayout(layout))
  }
  return {
    entries,
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null
    },
    setItem(key, value) {
      entries.set(key, value)
    },
    removeItem(key) {
      entries.delete(key)
    },
    raw(workspaceId) {
      return entries.get(layoutKey(workspaceId)) ?? null
    },
    has(workspaceId) {
      return entries.has(layoutKey(workspaceId))
    },
    read(workspaceId, options = {}) {
      return decodeLayout(this.raw(workspaceId), { workspaceId, ...options })
    },
  }
}

/**
 * A compact fake of the client services the pane controller uses, including
 * the workspace catalog (session → workspace) and a status map.
 */
function fakeCtx({ rows = {}, workspaces = TWO_WORKSPACES, workspacesPhase = 'ready', selectPanelFails = false } = {}) {
  const calls = { retain: [], selectPanel: [], create: [], interrupt: [] }
  const references = []
  let createdCount = 0
  const panelListeners = new Set()
  const panel = { activePanelId: null }
  const panelInfo = {
    getSnapshot: () => ({ activePanelId: panel.activePanelId }),
    subscribe(listener) {
      panelListeners.add(listener)
      return () => panelListeners.delete(listener)
    },
  }
  const layout = {
    panelInfo,
    selectPanel(panelId) {
      calls.selectPanel.push(panelId)
      if (selectPanelFails) throw new Error('panel not registered')
      panel.activePanelId = panelId
      for (const listener of [...panelListeners]) listener()
    },
  }
  const sessions = {
    list: { getSnapshot: () => ({ phase: 'ready', byId: rows }) },
    // Only `pane-close.js` reaches for these; recording them lets a delete test
    // prove it never interrupts a running turn.
    scope(sessionId) {
      calls.interrupt.push(sessionId)
      return { get: () => undefined }
    },
    binding(sessionId) {
      calls.interrupt.push(sessionId)
      return {}
    },
    retain(sessionId, options) {
      const reference = {
        sessionId,
        options,
        released: false,
        release() {
          this.released = true
        },
      }
      calls.retain.push({ sessionId, options })
      references.push(reference)
      return reference
    },
    async create(options = {}) {
      calls.create.push(options)
      createdCount += 1
      return `created-${createdCount}`
    },
  }
  const slots = {
    snapshot: (name) => (name === 'factory:conversation.content' ? FACTORY_PRESENT : []),
    onEntryError: () => () => {},
  }
  let phase = workspacesPhase
  const workspaceListeners = new Set()
  const workspacesService = {
    list: {
      getSnapshot: () => ({
        items: workspaces,
        archivedSessionIds: [],
        pinnedSessionIds: [],
        phase,
      }),
      subscribe(listener) {
        workspaceListeners.add(listener)
        return () => workspaceListeners.delete(listener)
      },
    },
  }
  return {
    ctx: { sessions, layout, slots, workspaces: workspacesService },
    calls,
    references,
    panel,
    setPanel(panelId) {
      panel.activePanelId = panelId
      for (const listener of [...panelListeners]) listener()
    },
    setWorkspacesPhase(next) {
      phase = next
      for (const listener of [...workspaceListeners]) listener()
    },
  }
}

/** Retained references still holding dsh's single "current session" slot. */
function liveMainView(fake) {
  return fake.references.filter(
    (reference) => reference.options?.source === MAIN_SOURCE && !reference.released,
  )
}

/** Retained pane references that are still alive. */
function livePaneRefs(fake) {
  return fake.references.filter(
    (reference) => reference.options?.source === PANE_SOURCE && !reference.released,
  )
}

/** A ready controller with an injected pane-id sequence and storage. */
function readyController({ storage, paneIds = [], ...options } = {}) {
  const ids = [...paneIds]
  const fake = fakeCtx(options)
  const controller = createPaneController(fake.ctx, {
    storage,
    nextPaneId: () => ids.shift(),
  })
  controller.markRegistered()
  return { fake, controller }
}

// ---------------------------------------------------------------------------
// One layout per workspace
// ---------------------------------------------------------------------------

test('each workspace keeps its own layout: switching shows the other tree and closes nothing', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.deepEqual(controller.getSnapshot().root, layouts.w1.root)
  assert.deepEqual(controller.getSnapshot().panes, layouts.w1.panes)

  assert.equal(controller.switchWorkspace('w2'), true)

  const state = controller.getSnapshot()
  assert.equal(state.workspaceId, 'w2')
  assert.deepEqual(state.root, layouts.w2.root)
  assert.deepEqual(state.panes, layouts.w2.panes)
  assert.equal(state.activePaneId, 'p2')
  assert.equal(state.sessionId, 's3')
  // Both workspaces' panes stay retained; only the visible focus holds mainView.
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId).sort(), ['s1', 's3'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  // Switching is a view change, not a panel navigation.
  assert.deepEqual(fake.calls.selectPanel, [PANEL_KEY])
  assert.equal(controller.paneReference('p1').sessionId, 's1')

  assert.equal(controller.switchWorkspace('w1'), true)
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s1'])
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId).sort(), ['s1', 's3'])
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  controller.dispose()
})

test('splitting in one workspace never rewrites the other workspace layout', async () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { controller } = readyController({ storage, paneIds: ['p3'] })

  // Load both workspaces, then work in w1 only.
  controller.switchWorkspace('w2')
  controller.switchWorkspace('w1')
  assert.equal(await controller.split('p1', 'row'), true)
  const w1 = controller.getSnapshot().layouts.w1
  assert.deepEqual(leaves(w1.root), ['p1', 'p3'])
  assert.deepEqual(controller.getSnapshot().layouts.w2, layouts.w2)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')

  assert.equal(controller.switchWorkspace('w2'), true)
  assert.deepEqual(controller.getSnapshot().root, layouts.w2.root)
  assert.equal(controller.getSnapshot().panes.p3, undefined)
  controller.dispose()
})

test('each workspace remembers its own focus, view and ratios across switches', () => {
  const w1 = resize(
    setView(split(openPane(createLayout('w1'), pane('p1', 's1')), 'p1', 'row', pane('p5', 's2')), 'p1', 'trajectory'),
    [],
    0.4,
  )
  const w2 = split(openPane(createLayout('w2'), pane('p2', 's3')), 'p2', 'row', pane('p4', 's4'))
  const storage = memoryStorage({ w1, w2 })
  const { controller } = readyController({ storage })

  controller.switchWorkspace('w1')
  controller.switchWorkspace('w2')

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(leaves(controller.getSnapshot().root), ['p2', 'p4'])
  assert.equal(controller.getSnapshot().activePaneId, 'p4')

  controller.switchWorkspace('w1')
  assert.equal(controller.getSnapshot().activePaneId, 'p5')
  assert.equal(controller.getSnapshot().panes.p1.view, 'trajectory')
  assert.equal(controller.getSnapshot().root.ratio, 0.4)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Boot restore
// ---------------------------------------------------------------------------

test('boot rebuilds the focused workspace tree, ratios, focus and per-pane view', () => {
  const one = openPane(createLayout('w1'), pane('p1', 's1'))
  const two = split(one, 'p1', 'row', pane('p2', 's2'))
  const three = resize(setView(two, 'p2', 'trajectory'), [], 0.65)
  const storage = memoryStorage({ w1: three })
  const { fake, controller } = readyController({ storage })

  assert.equal(controller.switchWorkspace('w1'), true)
  assert.equal(controller.activate(), true)

  const state = controller.getSnapshot()
  assert.deepEqual(state.root, three.root)
  assert.equal(state.root.ratio, 0.65)
  assert.deepEqual(state.panes, three.panes)
  assert.equal(state.panes.p2.view, 'trajectory')
  assert.equal(state.activePaneId, 'p2')
  assert.equal(state.sessionId, 's2')
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s2'])
  controller.dispose()
})

test('restore drops panes whose session is gone and writes the pruned tree back', () => {
  const layout = split(
    openPane(createLayout('w1'), pane('p1', 's1')),
    'p1',
    'row',
    pane('p2', 'deleted'),
  )
  const storage = memoryStorage({ w1: layout })
  const { fake, controller } = readyController({ storage })

  assert.equal(controller.switchWorkspace('w1'), true)

  assert.deepEqual(controller.getSnapshot().root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(Object.keys(controller.getSnapshot().panes), ['p1'])
  // Restoring while the panel is not showing retains nothing; opening the pane
  // view retains the surviving pane only.
  assert.equal(controller.activate(), true)
  assert.deepEqual(
    livePaneRefs(fake).map((reference) => reference.sessionId),
    ['s1'],
  )

  const persisted = storage.read('w1', { knownSessionIds: new Set(['s1']) })
  assert.deepEqual(persisted.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(Object.keys(persisted.panes), ['p1'])
  controller.dispose()
})

test('a fully dropped or corrupt stored layout shows the empty state instead of throwing', () => {
  const stale = openPane(createLayout('w1'), pane('p1', 'deleted'))
  const staleStorage = memoryStorage({ w1: stale })
  const first = readyController({ storage: staleStorage })

  assert.equal(first.controller.switchWorkspace('w1'), true)
  assert.equal(first.controller.getSnapshot().root, null)
  assert.deepEqual(first.controller.getSnapshot().panes, {})
  assert.equal(first.controller.getSnapshot().activePaneId, null)
  first.controller.dispose()

  const corrupt = memoryStorage()
  corrupt.setItem(layoutKey('w1'), '{not json')
  const second = readyController({ storage: corrupt })

  assert.equal(second.controller.switchWorkspace('w1'), true)
  assert.equal(second.controller.getSnapshot().root, null)
  assert.deepEqual(second.controller.getSnapshot().panes, {})
  second.controller.dispose()
})

test('a workspace with nothing stored starts empty without touching the others', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { controller } = readyController({ storage })

  assert.equal(controller.switchWorkspace('w1'), true)
  assert.deepEqual(controller.getSnapshot().layouts.w1, layouts.w1)
  assert.equal(controller.switchWorkspace('w3'), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w3')
  assert.equal(controller.getSnapshot().root, null)
  assert.deepEqual(controller.getSnapshot().panes, {})
  assert.deepEqual(controller.getSnapshot().layouts.w1, layouts.w1)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('every layout change persists under its own workspace key', () => {
  const storage = memoryStorage()
  const { controller } = readyController({ storage, paneIds: ['p2'] })

  controller.activate('s1')
  controller.setView('p1', 'trajectory')
  controller.resize([], 0.5)
  const state = controller.getSnapshot()

  assert.notEqual(storage.raw('w1'), null)
  assert.deepEqual(storage.read('w1'), state.layouts.w1)
  assert.equal(storage.raw('w2'), null)
  controller.dispose()
})

test('a failing or absent storage backend never breaks a layout change', () => {
  const throwing = {
    getItem() {
      throw new Error('storage disabled')
    },
    setItem() {
      throw new Error('quota exceeded')
    },
  }
  const first = readyController({ storage: throwing, paneIds: ['p1'] })
  assert.equal(first.controller.activate('s1'), true)
  assert.equal(first.controller.switchWorkspace('w2'), true)
  assert.equal(first.controller.getSnapshot().workspaceId, 'w2')
  first.controller.dispose()

  const second = readyController({ storage: undefined, paneIds: ['p1'] })
  assert.equal(second.controller.activate('s1'), true)
  assert.deepEqual(Object.keys(second.controller.getSnapshot().panes), ['p1'])
  second.controller.dispose()
})

test('stored layouts of different workspaces never overwrite each other', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { controller } = readyController({ storage })

  controller.switchWorkspace('w1')
  controller.switchWorkspace('w2')

  assert.deepEqual(storage.read('w1'), layouts.w1)
  assert.deepEqual(storage.read('w2'), layouts.w2)
  assert.equal(storage.entries.size, 2)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Pane identity and reference discipline
// ---------------------------------------------------------------------------

test('pane ids restored for different workspaces are made unique', () => {
  // Both workspaces independently generated `pane-1` in earlier sessions.
  const w1 = openPane(createLayout('w1'), pane('pane-1', 's1'))
  const w2 = openPane(createLayout('w2'), pane('pane-1', 's3'))
  const storage = memoryStorage({ w1, w2 })
  const { fake, controller } = readyController({ storage, paneIds: ['pane-renamed'] })

  controller.activate('s1')
  assert.equal(controller.switchWorkspace('w2'), true)

  const w2Panes = Object.keys(controller.getSnapshot().layouts.w2.panes)
  const w1Panes = Object.keys(controller.getSnapshot().layouts.w1.panes)
  assert.deepEqual(w2Panes, ['pane-renamed'])
  assert.deepEqual(w1Panes, ['pane-1'])
  assert.equal(controller.paneReference('pane-renamed').sessionId, 's3')
  assert.equal(controller.paneReference('pane-1').sessionId, 's1')
  assert.equal(controller.paneReference('pane-renamed').options.source, PANE_SOURCE)
  assert.deepEqual(
    livePaneRefs(fake).map((reference) => reference.sessionId).sort(),
    ['s1', 's3'],
  )
  // The renamed id is the one persisted, so the next boot stays collision-free.
  assert.deepEqual(Object.keys(storage.read('w2').panes), ['pane-renamed'])
  controller.dispose()
})

test('leaving and re-entering the pane view keeps every workspace layout', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })

  controller.activate('s1')
  controller.switchWorkspace('w2')
  controller.deactivate()

  assert.equal(controller.getSnapshot().active, false)
  assert.deepEqual(Object.keys(controller.getSnapshot().layouts).sort(), ['w1', 'w2'])
  assert.deepEqual(livePaneRefs(fake).length, 0)

  assert.equal(controller.reactivate(), true)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId).sort(), ['s1', 's3'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  controller.dispose()
})

test('dispose drops every workspace layout and reference', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })

  controller.activate('s1')
  controller.switchWorkspace('w2')
  controller.dispose()

  assert.deepEqual(controller.getSnapshot().layouts, {})
  assert.deepEqual(livePaneRefs(fake).length, 0)
  assert.deepEqual(liveMainView(fake).length, 0)
})

// ---------------------------------------------------------------------------
// Workspace derivation
// ---------------------------------------------------------------------------

test('activating a session from another workspace switches to that workspace', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { controller } = readyController({ storage })

  controller.activate('s1')
  assert.equal(controller.getSnapshot().workspaceId, 'w1')

  assert.equal(controller.activate('s3'), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(controller.getSnapshot().root, layouts.w2.root)
  assert.equal(controller.getSnapshot().sessionId, 's3')
  controller.dispose()
})

test('splitting a session mounted in another workspace focuses that workspace pane', async () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })

  controller.activate('s1')
  assert.equal(await controller.split('p1', 'row', { sessionId: 's3' }), false)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  controller.dispose()
})

test('the focused workspace falls back to the host workspace list while empty', () => {
  const { controller } = readyController({})

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.focusedWorkspaceId(), 'w1')
  controller.dispose()
})

test('a workspace catalog that is still loading keeps every stored pane', () => {
  const layout = split(openPane(createLayout('w1'), pane('p1', 's1')), 'p1', 'row', pane('p2', 's2'))
  const storage = memoryStorage({ w1: layout })
  const { controller } = readyController({ storage, workspacesPhase: 'loading' })

  assert.equal(controller.switchWorkspace('w1'), true)

  assert.deepEqual(leaves(controller.getSnapshot().root), ['p1', 'p2'])
  controller.dispose()
})

test('the prune re-runs when the workspace catalog becomes ready', () => {
  const layout = split(
    openPane(createLayout('w1'), pane('p1', 's1')),
    'p1',
    'row',
    pane('p2', 'deleted'),
  )
  const storage = memoryStorage({ w1: layout })
  const { controller, fake } = readyController({ storage, workspacesPhase: 'loading' })

  // The catalog is loading, so the first read must keep both panes.
  assert.equal(controller.activate('s1'), true)
  assert.deepEqual(leaves(controller.getSnapshot().root), ['p1', 'p2'])

  // The catalog becomes ready; the vanished session must now be dropped and the
  // pruned tree persisted, even though the workspace was already loaded.
  fake.setWorkspacesPhase('ready')

  assert.deepEqual(leaves(controller.getSnapshot().root), ['p1'])
  assert.deepEqual(Object.keys(controller.getSnapshot().panes), ['p1'])
  assert.deepEqual(leaves(storage.read('w1', { knownSessionIds: new Set(['s1']) }).root), ['p1'])
  controller.dispose()
})

test('switching to an unknown workspace id is refused', () => {
  const { controller } = readyController({ storage: memoryStorage() })

  assert.equal(controller.switchWorkspace(''), false)
  assert.equal(controller.switchWorkspace(undefined), false)
  assert.equal(controller.getSnapshot().workspaceId, null)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Deleting a workspace (ticket 03, spec §2)
//
// A delete only removes the registration: its layout and persisted key go, its
// pane references are released, and a visible workspace hands the view to its
// host-order neighbour. Running turns are not interrupted.
// ---------------------------------------------------------------------------

test('deleting the visible workspace drops its layout and key, releases its panes and moves to the next host workspace', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })
  controller.activate('s1')
  let emissions = 0
  controller.subscribe(() => {
    emissions += 1
  })

  assert.equal(controller.forgetWorkspace('w1', { order: ['w1', 'w2', 'w3'] }), true)

  const state = controller.getSnapshot()
  assert.equal(state.workspaceId, 'w2')
  assert.equal(state.layouts.w1, undefined, 'the deleted workspace layout is gone')
  assert.deepEqual(state.layouts.w2, layouts.w2, 'the neighbour tree is shown')
  assert.equal(state.sessionId, 's3')
  assert.equal(storage.has('w1'), false, 'the persisted key is cleared')
  assert.equal(controller.isWorkspaceEnabled('w1'), false, 'a deleted workspace is not enabled any more')
  assert.equal(controller.isWorkspaceEnabled('w2'), true, 'the neighbour it moved to is enabled')
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId), ['s3'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  // Deleting a registration is not closing panes: no interrupt, no panel nav.
  assert.deepEqual(fake.calls.interrupt, [])
  assert.deepEqual(fake.calls.selectPanel, [PANEL_KEY])
  assert.ok(emissions > 0, 'the controller publishes a new snapshot')
  controller.dispose()
})

test('deleting the last host workspace falls back to the previous one', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })
  controller.activate('s3')
  assert.equal(controller.getSnapshot().workspaceId, 'w2')

  assert.equal(controller.forgetWorkspace('w2', { order: ['w1', 'w2'] }), true)

  const state = controller.getSnapshot()
  assert.equal(state.workspaceId, 'w1')
  assert.equal(state.sessionId, 's1')
  assert.equal(storage.has('w2'), false)
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s1'])
  controller.dispose()
})

test('deleting the only workspace leaves no active workspace and no retained reference', () => {
  const only = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: only })
  const { fake, controller } = readyController({
    storage,
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
  })
  controller.activate('s1')

  assert.equal(controller.forgetWorkspace('w1', { order: ['w1'] }), true)

  const state = controller.getSnapshot()
  assert.equal(state.workspaceId, null)
  assert.deepEqual(state.layouts, {})
  assert.equal(state.root, null)
  assert.deepEqual(livePaneRefs(fake), [])
  assert.deepEqual(liveMainView(fake), [])
  assert.equal(storage.has('w1'), false)
  controller.dispose()
})

test('deleting a hidden workspace clears only its layout, key and references', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })
  controller.activate('s1')
  assert.equal(controller.switchWorkspace('w2'), true)
  assert.equal(controller.switchWorkspace('w1'), true)

  assert.equal(controller.forgetWorkspace('w2', { order: ['w1', 'w2'] }), true)

  const state = controller.getSnapshot()
  assert.equal(state.workspaceId, 'w1')
  assert.equal(state.sessionId, 's1')
  assert.equal(state.layouts.w2, undefined)
  assert.equal(storage.has('w2'), false)
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId), ['s1'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s1'])
  controller.dispose()
})

test('deleting a workspace that was never opened here only clears its stored key', () => {
  const stored = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: stored })
  const { fake, controller } = readyController({ storage })
  controller.activate('s3')
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  const before = controller.getSnapshot()

  assert.equal(controller.forgetWorkspace('w1', { order: ['w1', 'w2'] }), true)

  assert.equal(storage.has('w1'), false)
  assert.equal(controller.isWorkspaceEnabled('w1'), false, 'the ghost row cannot come back gray')
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(controller.getSnapshot().layouts, before.layouts)
  assert.deepEqual(fake.calls.interrupt, [])
  controller.dispose()
})

test('an unknown workspace id is a no-op', () => {
  const storage = memoryStorage()
  const { fake, controller } = readyController({ storage })
  controller.activate('s1')
  const before = controller.getSnapshot()

  assert.equal(controller.forgetWorkspace('missing', { order: ['w1', 'w2'] }), false)
  assert.equal(controller.forgetWorkspace('', { order: ['w1', 'w2'] }), false)
  assert.equal(controller.forgetWorkspace(undefined), false)

  assert.equal(controller.getSnapshot(), before, 'no snapshot is published for an unknown id')
  assert.equal(storage.has('w1'), true)
  assert.deepEqual(fake.calls.interrupt, [])
  controller.dispose()
})

// ---------------------------------------------------------------------------
// "Enabled" (ticket 02): ever opened in split
// ---------------------------------------------------------------------------

test('a workspace nobody opened in split is not enabled', () => {
  const { controller } = readyController({ storage: memoryStorage() })

  assert.equal(controller.isWorkspaceEnabled('w1'), false)
  assert.equal(controller.isWorkspaceEnabled('w2'), false)
  assert.equal(controller.isWorkspaceEnabled(''), false)
  assert.equal(controller.isWorkspaceEnabled(undefined), false)
  assert.equal(controller.isWorkspaceEnabled(null), false)
  controller.dispose()
})

test('opening a workspace in the pane view enables it and notifies the sidebar', () => {
  const storage = memoryStorage()
  const { controller } = readyController({ storage })
  const seen = []
  const unsubscribe = controller.subscribe(() => seen.push(controller.isWorkspaceEnabled('w1')))

  assert.equal(controller.activate('s1'), true)

  assert.equal(controller.isWorkspaceEnabled('w1'), true)
  assert.ok(seen.length > 0, 'the sidebar is notified so the light changes without a reload')
  assert.equal(seen[seen.length - 1], true, 'the last notification already sees the workspace enabled')
  assert.equal(controller.isWorkspaceEnabled('w2'), false, 'other workspaces are untouched')
  assert.notEqual(storage.raw('w1'), null, 'the first split write is what proves enablement')
  unsubscribe()
  controller.dispose()
})

test('switching to a workspace in split enables it even before a pane is opened', () => {
  const storage = memoryStorage()
  const { controller } = readyController({ storage })

  assert.equal(controller.switchWorkspace('w2'), true)

  assert.equal(controller.isWorkspaceEnabled('w2'), true)
  assert.notEqual(storage.raw('w2'), null)
  controller.dispose()
})

test('a persisted layout key keeps a workspace enabled after a restart', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { controller } = readyController({ storage })

  // Nothing is loaded in this fresh controller yet; the key alone is the proof.
  assert.equal(controller.isWorkspaceEnabled('w1'), true)
  assert.equal(controller.isWorkspaceEnabled('w2'), true)
  assert.equal(controller.isWorkspaceEnabled('w3'), false)
  controller.dispose()
})

test('a corrupt persisted key still counts as a workspace that was opened in split', () => {
  const storage = memoryStorage()
  storage.setItem(layoutKey('w1'), '{not json')
  const { controller } = readyController({ storage })

  assert.equal(controller.isWorkspaceEnabled('w1'), true)
  controller.dispose()
})

test('a broken storage backend never makes the enablement check throw', () => {
  const throwing = {
    getItem() {
      throw new Error('storage disabled')
    },
    setItem() {
      throw new Error('quota exceeded')
    },
  }
  const { controller } = readyController({ storage: throwing, paneIds: ['p1'] })

  assert.equal(controller.isWorkspaceEnabled('w2'), false)
  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.isWorkspaceEnabled('w1'), true, 'a loaded layout is enough')
  controller.dispose()
})
