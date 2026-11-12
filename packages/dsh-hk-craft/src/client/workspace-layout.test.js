'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { MAIN_SOURCE, PANE_SOURCE, createPaneController } = require('./dsh-pane-host.js')
const {
  layoutKey,
  LAYOUT_KEY_PREFIX,
  encodeLayout,
  decodeLayout,
  writeActiveWorkspace,
} = require('./layout-store.js')
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
function fakeCtx({
  rows = {},
  workspaces = TWO_WORKSPACES,
  workspacesPhase = 'ready',
  sessionsPhase = 'ready',
  selectPanelFails = false,
  retainThrowsUnknown = false,
  sessionObjects = {},
} = {}) {
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
  let sessionPhase = sessionsPhase
  let sessionRows = rows
  const sessionListeners = new Set()
  const sessions = {
    list: {
      getSnapshot: () => ({ phase: sessionPhase, byId: sessionRows }),
      subscribe(listener) {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
    },
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
      // Upstream `SessionManager.resolveTarget` throws for an id the session
      // list has not published yet, which is the state during a cold start.
      if (retainThrowsUnknown && sessionRows[sessionId] === undefined) {
        calls.retain.push({ sessionId, options })
        throw new Error(`sessions.retain: unknown session ${sessionId}`)
      }
      // `ClientSessions.retain` opens the Session's history as the reference is
      // built, which is what the plugin's open watch retries through.
      const session = sessionObjects[sessionId]
      if (session !== undefined && typeof session.open === 'function') session.open()
      const reference = {
        sessionId,
        options,
        binding: { sessionId, session },
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
    setSessions(nextRows, nextPhase = 'ready') {
      sessionRows = nextRows
      sessionPhase = nextPhase
      for (const listener of [...sessionListeners]) listener()
    },
  }
}

/** Wait for real timers: the open watch is a poll and takes a few ticks. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
function readyController({ storage, paneIds = [], controllerOptions = {}, ...options } = {}) {
  const ids = [...paneIds]
  const fake = fakeCtx(options)
  const controller = createPaneController(fake.ctx, {
    storage,
    nextPaneId: () => ids.shift(),
    ...controllerOptions,
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
  // Switching workspaces stays in split mode and never selects a panel.
  assert.deepEqual(fake.calls.selectPanel, [])
  assert.equal(controller.layout.paneReference('p1').sessionId, 's1')

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
  assert.equal(await controller.budget.split('p1', 'row'), true)
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

test('a restored pane whose session the list has not published yet recovers when it arrives', () => {
  // The real `sessions.retain` throws `unknown session <id>` for an id the
  // session list does not hold yet (`SessionManager.resolveTarget`), and the
  // plugin restores its panes before that first list lands. The pane then has no
  // retained reference and the view renders the "no conversation selected"
  // fallback; the layout itself never changes again, so nothing used to retry
  // the acquire and the pane stayed empty for the whole process.
  const layout = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: layout })
  const { fake, controller } = readyController({
    storage,
    rows: {},
    sessionsPhase: 'pending',
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
    retainThrowsUnknown: true,
  })

  assert.equal(controller.activate(), false, 'the too-early retain cannot succeed')
  const early = controller.getSnapshot()
  assert.equal(early.active, true, 'the restored tree is still the view')
  assert.deepEqual(Object.keys(early.panes), ['p1'])
  assert.match(early.error, /unknown session s1/)
  assert.equal(early.restoringPanes, true, 'the pane is opening, not permanently empty')
  assert.equal(controller.layout.paneReference('p1'), undefined)

  fake.setSessions({ s1: { id: 's1', title: 'Pane', blank: false, updatedAt: 10 } }, 'ready')

  const recovered = controller.getSnapshot()
  assert.equal(recovered.error, null, 'the list arriving is a retry, not a permanent failure')
  assert.equal(recovered.restoringPanes, false)
  assert.equal(controller.layout.paneReference('p1')?.sessionId, 's1')
  assert.deepEqual(
    livePaneRefs(fake).map((reference) => reference.sessionId),
    ['s1'],
  )
  assert.deepEqual(
    liveMainView(fake).map((reference) => reference.sessionId),
    ['s1'],
  )
  controller.dispose()
})

test('a plugin reload keeps the conversation on screen instead of the stale shell current', () => {
  const layout = openPane(createLayout('w1'), pane('p1', 'live'))
  const storage = memoryStorage({ w1: layout })
  const rows = {
    live: { id: 'live', blank: false, updatedAt: 50 },
    old: { id: 'old', blank: false, retainedBy: { mainView: 1 }, updatedAt: 1 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['live', 'old'] }]
  const first = readyController({ storage, rows, workspaces })
  assert.equal(first.controller.activate('live'), true)
  first.controller.dispose()

  // A reload applies a fresh controller over the same storage. dsh still holds
  // the native selection from before the split view (the idle `old` row), so
  // `catalog.current()` names a conversation the plugin was not showing. Both
  // rows are idle: the running/idle guard of ADR-0019 cannot help here.
  const second = readyController({ storage, rows, workspaces })
  assert.equal(second.controller.activate(), true)

  assert.equal(second.controller.getSnapshot().workspaceId, 'w1')
  assert.equal(second.controller.getSnapshot().activePaneId, 'p1')
  assert.equal(second.controller.getSnapshot().sessionId, 'live')
  assert.equal(second.controller.getSnapshot().panes.p1.sessionId, 'live')
  second.controller.dispose()
})

test('a restore without an active-workspace hint still keeps the stored focus', () => {
  // The first run after an upgrade has the layout key but not the new
  // active-workspace key. The shell current names the older native selection in
  // the same workspace; the stored focus must still win.
  const storage = memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 'live')) })
  const rows = {
    live: { id: 'live', blank: false, running: true, updatedAt: 50 },
    old: { id: 'old', blank: false, retainedBy: { mainView: 1 }, updatedAt: 1 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['live', 'old'] }]
  const { controller } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.getSnapshot().sessionId, 'live')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'live')
  controller.dispose()
})

test('a plugin reload restores the workspace it was showing, not the shell current workspace', () => {
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 'live')),
    w2: openPane(createLayout('w2'), pane('p2', 'old')),
  })
  const rows = {
    live: { id: 'live', blank: false, running: true, updatedAt: 50 },
    old: { id: 'old', blank: false, retainedBy: { mainView: 1 }, updatedAt: 1 },
  }
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['live'] },
    { workspaceId: 'w2', sessionIds: ['old'] },
  ]
  const first = readyController({ storage, rows, workspaces })
  assert.equal(first.controller.activate('live'), true)
  first.controller.dispose()

  const second = readyController({ storage, rows, workspaces })
  assert.equal(second.controller.activate(), true)

  assert.equal(second.controller.getSnapshot().workspaceId, 'w1')
  assert.equal(second.controller.getSnapshot().activePaneId, 'p1')
  assert.equal(second.controller.getSnapshot().sessionId, 'live')
  second.controller.dispose()
})

test('a shell restore that retains mainView on an older conversation does not replace the restored pane', () => {
  // ui-workspace `restoreSelection` calls `replaceMain` once both catalogs are
  // ready, which retains `mainView` on the saved selection. That count grows
  // after this plugin has already restored the pane the user was looking at.
  // The growth is the same signal as 新会话, but the saved selection is a
  // conversation that has already started, so it must not take the pane.
  const storage = memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 'live')) })
  const rows = {
    live: { id: 'live', blank: false, updatedAt: 50 },
    old: { id: 'old', blank: false, updatedAt: 1 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['live', 'old'] }]
  const { controller, fake } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().sessionId, 'live')

  fake.setSessions({
    live: { id: 'live', blank: false, updatedAt: 50, retainedBy: { mainView: 1 } },
    old: { id: 'old', blank: false, updatedAt: 1, retainedBy: { mainView: 1 } },
  })

  assert.equal(controller.getSnapshot().sessionId, 'live')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'live')
  controller.dispose()
})

test('a shell restore whose summary is still blank does not replace the restored pane when metadata says it started', () => {
  // A host reconnect can publish the saved selection as `blank: true` until
  // `sessionListMetadata` arrives. That stale bit is not a 新会话.
  const storage = memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 'live')) })
  const rows = {
    live: { id: 'live', blank: false, updatedAt: 50 },
    old: { id: 'old', blank: true, updatedAt: 1 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['live', 'old'] }]
  const { controller, fake } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)

  fake.setSessions({
    live: { id: 'live', blank: false, updatedAt: 50, retainedBy: { mainView: 1 } },
    old: {
      id: 'old',
      blank: true,
      updatedAt: 1,
      retainedBy: { mainView: 1 },
      projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 1 } },
    },
  })

  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'live')
  controller.dispose()
})

test('a blank 新会话 that gains mainView during startup still replaces the focused pane', () => {
  const storage = memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 'live')) })
  const rows = {
    live: { id: 'live', blank: false, updatedAt: 50 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['live', 'fresh'] }]
  const { controller, fake } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)

  fake.setSessions({
    live: { id: 'live', blank: false, updatedAt: 50, retainedBy: { mainView: 1 } },
    fresh: { id: 'fresh', blank: true, updatedAt: 60, retainedBy: { mainView: 1 } },
  })

  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'fresh')
  controller.dispose()
})

test('after startup settles, opening an existing conversation through mainView still replaces the pane', async () => {
  const storage = memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 'live')) })
  const rows = {
    live: { id: 'live', blank: false, updatedAt: 50 },
    old: { id: 'old', blank: false, updatedAt: 1 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['live', 'old'] }]
  const { controller, fake } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)
  await new Promise((resolve) => setImmediate(resolve))

  fake.setSessions({
    live: { id: 'live', blank: false, updatedAt: 50, retainedBy: { mainView: 1 } },
    old: { id: 'old', blank: false, updatedAt: 1, retainedBy: { mainView: 1 } },
  })

  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'old')
  controller.dispose()
})

test('a plugin reload keeps a restored blank conversation instead of opening older history', () => {
  const storage = memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 'draft')) })
  assert.equal(writeActiveWorkspace(storage, 'w1'), true)
  const rows = {
    draft: { id: 'draft', blank: true, updatedAt: 5 },
    old: { id: 'old', blank: false, updatedAt: 10 },
  }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['draft', 'old'] }]
  const { controller } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)

  assert.equal(controller.getSnapshot().sessionId, 'draft')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'draft')
  controller.dispose()
})

test('a remembered workspace the ready catalog no longer lists is forgotten, not shown', () => {
  const ghost = openPane(createLayout('gone'), pane('p1', 'lost'))
  const storage = memoryStorage({ gone: ghost })
  assert.equal(writeActiveWorkspace(storage, 'gone'), true)
  const rows = { s1: { id: 's1', blank: false, updatedAt: 10 } }
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['s1'] }]
  const { controller, fake } = readyController({ storage, rows, workspaces })

  assert.equal(controller.activate(), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.getSnapshot().sessionId, 's1')
  assert.equal(storage.has('gone'), false, 'the ghost layout key is removed')
  assert.deepEqual(
    livePaneRefs(fake).map((reference) => reference.sessionId),
    ['s1'],
    'the ghost pane is released',
  )
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

const CONVERSATION_ROWS = {
  s1: { id: 's1', blank: false, updatedAt: 1 },
  s3: { id: 's3', blank: false, updatedAt: 10 },
  s4: { id: 's4', blank: false, updatedAt: 20 },
}

test('switching to a workspace with no panes shows its latest conversation', () => {
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
  })
  const { controller } = readyController({ storage, rows: CONVERSATION_ROWS })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.getSnapshot().sessionId, 's1')

  assert.equal(controller.switchWorkspace('w2'), true)

  const state = controller.getSnapshot()
  assert.equal(state.workspaceId, 'w2')
  assert.equal(state.sessionId, 's4')
  assert.equal(state.layouts.w1.panes.p1.sessionId, 's1')
  controller.dispose()
})

test('switching workspace leaves a foreign conversation and shows one that belongs there', () => {
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
    w2: openPane(createLayout('w2'), pane('p2', 's1')),
  })
  const { controller } = readyController({ storage, rows: CONVERSATION_ROWS })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().sessionId, 's4')
  assert.equal(controller.getSnapshot().layouts.w1.panes.p1.sessionId, 's1')
  controller.dispose()
})

test('switching workspace keeps a conversation that workspace already has open', () => {
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
    w2: openPane(createLayout('w2'), pane('p2', 's3')),
  })
  const { controller } = readyController({ storage, rows: CONVERSATION_ROWS })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().sessionId, 's3')
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 's3')
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('every layout change persists under its own workspace key', () => {
  const storage = memoryStorage()
  const { controller } = readyController({ storage, paneIds: ['p2'] })

  controller.activate('s1')
  controller.view.setView('p1', 'trajectory')
  controller.layout.resize([], 0.5)
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
  assert.equal(
    [...storage.entries.keys()].filter((key) => key.startsWith(LAYOUT_KEY_PREFIX)).length,
    2,
  )
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
  assert.equal(controller.layout.paneReference('pane-renamed').sessionId, 's3')
  assert.equal(controller.layout.paneReference('pane-1').sessionId, 's1')
  assert.equal(controller.layout.paneReference('pane-renamed').options.source, PANE_SOURCE)
  assert.deepEqual(
    livePaneRefs(fake).map((reference) => reference.sessionId).sort(),
    ['s1', 's3'],
  )
  // The renamed id is the one persisted, so the next boot stays collision-free.
  assert.deepEqual(Object.keys(storage.read('w2').panes), ['pane-renamed'])
  controller.dispose()
})

test('a current session held in another workspace focuses that workspace pane', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { controller } = readyController({ storage })
  controller.activate('s1')
  controller.switchWorkspace('w2')
  controller.switchWorkspace('w1')
  const listeners = new Set()
  let key = null
  controller.attachSessionSelection({
    getSnapshot: () => ({ key }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })

  key = 's3'
  for (const listener of listeners) listener()

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.getSnapshot().sessionId, 's3')
  assert.deepEqual(controller.getSnapshot().layouts.w1, layouts.w1)
  controller.dispose()
})

test('opening another panel keeps split mode, every workspace layout and its references', () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })

  controller.activate('s1')
  controller.switchWorkspace('w2')
  fake.setPanel('settings')

  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(Object.keys(controller.getSnapshot().layouts).sort(), ['w1', 'w2'])
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId).sort(), ['s1', 's3'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  assert.deepEqual(fake.calls.selectPanel, [])

  assert.equal(controller.reactivate(), true)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId).sort(), ['s1', 's3'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  assert.deepEqual(fake.calls.selectPanel, [])
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
  const { fake, controller } = readyController({ storage })

  controller.activate('s1')
  assert.equal(controller.getSnapshot().workspaceId, 'w1')

  assert.equal(controller.activate('s3'), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(controller.getSnapshot().root, layouts.w2.root)
  assert.equal(controller.getSnapshot().sessionId, 's3')
  // The session was already the stored focus of that workspace. Switching still
  // has to retain its panes and move mainView; the snapshot alone is not enough.
  assert.deepEqual(livePaneRefs(fake).map((reference) => reference.sessionId).sort(), ['s1', 's3'])
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  controller.dispose()
})

test('a restored pane id is not renamed onto another pane in the same layout', () => {
  // w1 was saved alone, so its first pane is `pane-1`. w2 was saved in another
  // session that also started at `pane-1` and then split to `pane-2`. Loading w2
  // second must rename only the collision, not onto w2's own `pane-2`.
  const w1 = openPane(createLayout('w1'), pane('pane-1', 's1'))
  const w2 = split(
    openPane(createLayout('w2'), pane('pane-1', 's3')),
    'pane-1',
    'row',
    pane('pane-2', 's4'),
  )
  const storage = memoryStorage({ w1, w2 })
  const { controller } = readyController({ storage })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)

  const layout = controller.getSnapshot().layouts.w2
  const sessions = leaves(layout.root).map((paneId) => layout.panes[paneId]?.sessionId).sort()
  assert.deepEqual(sessions, ['s3', 's4'])
  assert.equal(new Set(leaves(layout.root)).size, 2)
  assert.equal(layout.panes['pane-1'], undefined)
  assert.equal(controller.getSnapshot().layouts.w1.panes['pane-1'].sessionId, 's1')
  controller.dispose()
})

test('splitting a session mounted in another workspace focuses that workspace pane', async () => {
  const layouts = twoWorkspaces()
  const storage = memoryStorage(layouts)
  const { fake, controller } = readyController({ storage })

  controller.activate('s1')
  assert.equal(await controller.budget.split('p1', 'row', { sessionId: 's3' }), false)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.deepEqual(liveMainView(fake).map((reference) => reference.sessionId), ['s3'])
  controller.dispose()
})

test('the focused workspace falls back to the host workspace list while empty', () => {
  const { controller } = readyController({})

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.layout.focusedWorkspaceId(), 'w1')
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

test('startup keeps a stored pane when the workspace catalog is ready before its sessions are listed', () => {
  // Restart publishes workspace membership before the session list. An empty
  // membership at that moment is "not loaded yet", not "these panes are gone".
  const layout = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: layout })
  const workspaces = [
    { workspaceId: 'w1', sessionIds: [] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ]
  const { controller, fake } = readyController({
    storage,
    sessionsPhase: 'pending',
    workspaces,
    rows: {},
  })

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 's1')
  assert.equal(storage.read('w1').panes.p1.sessionId, 's1')

  workspaces[0].sessionIds = ['s1']
  fake.setSessions({ s1: { id: 's1', title: 'Kept', blank: false, updatedAt: 4 } })

  assert.equal(controller.getSnapshot().panes.p1.sessionId, 's1')
  assert.equal(storage.read('w1').panes.p1.sessionId, 's1')
  controller.dispose()
})

test('the workspace shown at startup waits for the session catalog before saying it has no history', async () => {
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ]
  const { controller, fake } = readyController({
    sessionsPhase: 'pending',
    workspaces,
    rows: {},
    paneIds: ['p-boot'],
  })

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.getSnapshot().sessionId, null)

  let resolved = false
  const pending = controller.recentConversations('w1').then((rows) => {
    resolved = true
    return rows
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resolved, false, 'an unready session catalog is not an empty history')

  fake.setSessions({
    s1: { id: 's1', title: 'History', blank: false, updatedAt: 10 },
    s3: { id: 's3', title: 'Other', blank: false, updatedAt: 20 },
  })

  const rows = await pending
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['s1'],
  )
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.getSnapshot().sessionId, 's1')
  controller.dispose()
})

test('a pane whose history never opened is reopened instead of staying on 载入历史…', async () => {
  // Upstream `Session.doOpen` leaves `openState` in "loading" when its event
  // stream fails on a transport error (carrier lost at boot, socket closed
  // before it opened), and nothing in the shell calls `open()` again: the Chat
  // view then shows "载入历史…" for the rest of the client generation. A fresh
  // `retain()` is the shell's own retry trigger.
  const stuck = {
    openState: 'loading',
    openPromise: null,
    opens: 0,
    recovered: false,
    open() {
      this.opens += 1
      if (this.recovered) this.openState = 'open'
    },
  }
  const layout = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: layout })
  const { controller, fake } = readyController({
    storage,
    rows: { s1: { id: 's1', blank: false, updatedAt: 10 } },
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
    sessionObjects: { s1: stuck },
    controllerOptions: {
      openWatchIntervalMs: 5,
      openRecovery: { stallMs: 10, maxOpenRetries: 3, maxResyncs: 1 },
    },
  })

  assert.equal(controller.activate(), true)
  assert.equal(stuck.openState, 'loading', 'the first open failed and left loading behind')
  assert.equal(fake.calls.retain.filter((call) => call.options?.source === 'hkcraftOpenRetry').length, 0)
  // The transport is healthy again by the time the watch looks.
  stuck.recovered = true

  await delay(60)

  assert.equal(stuck.openState, 'open', 'the watch reopened the history')
  const retries = fake.calls.retain.filter((call) => call.options?.source === 'hkcraftOpenRetry')
  assert.equal(retries.length, 1, 'one retry is enough once the open succeeds')
  assert.equal(controller.layout.paneReference('p1')?.sessionId, 's1')
  assert.deepEqual(
    livePaneRefs(fake).filter((reference) => !reference.released).map((ref) => ref.sessionId),
    ['s1'],
    'the retry reference is released again; the pane keeps its own',
  )
  controller.dispose()
})

test('an open that keeps failing is retried a bounded number of times', async () => {
  const stuck = { openState: 'loading', openPromise: null, opens: 0, open() { this.opens += 1 } }
  const layout = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: layout })
  const { controller, fake } = readyController({
    storage,
    rows: { s1: { id: 's1', blank: false, updatedAt: 10 } },
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
    sessionObjects: { s1: stuck },
    controllerOptions: {
      openWatchIntervalMs: 5,
      openRecovery: { stallMs: 5, maxOpenRetries: 2, maxResyncs: 0 },
    },
  })

  controller.activate()
  await delay(80)

  const retries = () =>
    fake.calls.retain.filter((call) => call.options?.source === 'hkcraftOpenRetry').length
  assert.equal(retries(), 2, 'the budget is spent exactly once per allowed retry')
  const settled = retries()
  await delay(60)
  assert.equal(retries(), settled, 'a given-up session is not retried again')
  controller.dispose()
})

test('an open that is still in flight is rebuilt through the Session resync', async () => {
  // `open()` returns the same pending promise, so a hung open needs the
  // Session's own rebuild rather than another retain.
  const resynced = []
  const hanging = {
    openState: 'loading',
    openPromise: Promise.resolve(),
    open() {},
    resync() {
      resynced.push('resync')
      this.openState = 'open'
      this.openPromise = null
    },
  }
  const layout = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: layout })
  const { fake, controller } = readyController({
    storage,
    rows: { s1: { id: 's1', blank: false, updatedAt: 10 } },
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
    sessionObjects: { s1: hanging },
    controllerOptions: {
      openWatchIntervalMs: 5,
      openRecovery: { stallMs: 10, maxOpenRetries: 3, maxResyncs: 1 },
    },
  })

  controller.activate()
  await delay(60)

  assert.deepEqual(resynced, ['resync'])
  assert.equal(
    fake.calls.retain.filter((call) => call.options?.source === 'hkcraftOpenRetry').length,
    0,
    'a pending open is never handed to a plain retry',
  )
  controller.dispose()
})

test('the open watch never touches a session that reports no open state', async () => {
  const plain = { opens: 0, open() { this.opens += 1 } }
  const layout = openPane(createLayout('w1'), pane('p1', 's1'))
  const storage = memoryStorage({ w1: layout })
  const { controller, fake } = readyController({
    storage,
    rows: { s1: { id: 's1', blank: false, updatedAt: 10 } },
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
    sessionObjects: { s1: plain },
    controllerOptions: { openWatchIntervalMs: 5 },
  })

  controller.activate()
  const opensAfterActivate = plain.opens
  await delay(40)

  assert.equal(plain.opens, opensAfterActivate, 'only the pane retention opened it')
  assert.equal(fake.calls.retain.filter((call) => call.options?.source === 'hkcraftOpenRetry').length, 0)
  controller.dispose()
})

test('startup opens history once a ready catalog corrects stale blanks', () => {
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['s1'] }]
  const { controller, fake } = readyController({
    sessionsPhase: 'pending',
    workspaces,
    rows: {},
    paneIds: ['p-boot'],
  })

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().sessionId, null)

  // The first ready snapshot can still mark every conversation blank. That is
  // not "this workspace has no history"; the metadata correction arrives next.
  fake.setSessions({
    s1: { id: 's1', title: 'History', blank: true, updatedAt: 10 },
  })
  assert.equal(controller.getSnapshot().sessionId, null)

  fake.setSessions({
    s1: {
      id: 's1',
      title: 'History',
      blank: true,
      updatedAt: 10,
      projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 10 } },
    },
  })

  assert.equal(controller.getSnapshot().sessionId, 's1')
  controller.dispose()
})

test('a new conversation opened while blanks are still stale stays put when history arrives', async () => {
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['s1'] }]
  const { controller, fake } = readyController({
    sessionsPhase: 'pending',
    workspaces,
    rows: {},
    paneIds: ['p-new'],
  })
  controller.activate()
  fake.setSessions({
    s1: { id: 's1', title: 'History', blank: true, updatedAt: 10 },
  })
  assert.equal(controller.getSnapshot().sessionId, null)

  assert.equal(await controller.budget.newInFocused('w1'), true)
  assert.equal(controller.getSnapshot().sessionId, 'created-1')

  // The new row is published before the workspace list links it. That tick
  // must not close the pane, and it must not swap in the older conversation.
  fake.setSessions({
    s1: { id: 's1', title: 'History', blank: false, updatedAt: 10 },
    'created-1': { id: 'created-1', blank: true, updatedAt: 11 },
  })

  assert.equal(controller.getSnapshot().sessionId, 'created-1')
  assert.equal(controller.getSnapshot().panes['p-new'].sessionId, 'created-1')
  controller.dispose()
})

test('a workspace switch made before the session catalog is ready is the one that receives history', async () => {
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ]
  const { controller, fake } = readyController({
    sessionsPhase: 'pending',
    workspaces,
    rows: {},
    paneIds: ['p-boot', 'p-w2'],
  })

  assert.equal(controller.activate(), true)
  assert.equal(controller.switchWorkspace('w2'), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().sessionId, null)

  fake.setSessions({
    s1: { id: 's1', title: 'Default history', blank: false, updatedAt: 1 },
    s3: { id: 's3', title: 'Other history', blank: false, updatedAt: 2 },
  })

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().sessionId, 's3')
  controller.dispose()
})

test('a membership gap does not drop a running conversation onto an older one', () => {
  const layout = split(openPane(createLayout('w1'), pane('p1', 'old')), 'p1', 'row', pane('p2', 'live'))
  const storage = memoryStorage({ w1: layout })
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['old', 'live'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ]
  const rows = {
    old: { id: 'old', blank: false, running: false, updatedAt: 1 },
    live: { id: 'live', blank: false, running: true, updatedAt: 50 },
    s3: { id: 's3', blank: false, running: false, updatedAt: 2 },
  }
  const { controller, fake } = readyController({ storage, workspaces, rows })

  assert.equal(controller.activate('live'), true)
  assert.equal(controller.getSnapshot().sessionId, 'live')

  // The host reindexes cwd asynchronously and can publish a workspace view
  // that omits the conversation currently running. That snapshot is not a delete.
  workspaces[0].sessionIds = ['old']
  fake.setSessions(rows)

  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.getSnapshot().sessionId, 'live')
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 'live')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'old')
  controller.dispose()
})

test('the first restore keeps a running conversation the ready catalog omitted', () => {
  const layout = split(openPane(createLayout('w1'), pane('p1', 'old')), 'p1', 'row', pane('p2', 'live'))
  const storage = memoryStorage({ w1: layout })
  const { controller } = readyController({
    storage,
    workspaces: [{ workspaceId: 'w1', sessionIds: ['old'] }],
    rows: {
      old: { id: 'old', blank: false, running: false, updatedAt: 1 },
      live: { id: 'live', blank: false, running: true, updatedAt: 50 },
    },
  })

  assert.equal(controller.activate('old'), true)
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 'live')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'old')
  assert.equal(storage.read('w1').panes.p2.sessionId, 'live')
  controller.dispose()
})

test('the first restore still drops a finished conversation the catalog no longer lists', () => {
  const layout = split(openPane(createLayout('w1'), pane('p1', 'old')), 'p1', 'row', pane('p2', 'gone'))
  const storage = memoryStorage({ w1: layout })
  const { controller } = readyController({
    storage,
    workspaces: [{ workspaceId: 'w1', sessionIds: ['old'] }],
    rows: {
      old: { id: 'old', blank: false, running: false, updatedAt: 1 },
      gone: { id: 'gone', blank: false, running: false, updatedAt: 2 },
    },
  })

  assert.equal(controller.activate('old'), true)
  assert.equal(controller.getSnapshot().panes.p2, undefined)
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 'old')
  assert.equal(storage.read('w1').panes.p2, undefined)
  controller.dispose()
})

test('a running session from another workspace does not keep this workspace terminal', () => {
  // The right bar starts the terminal in the focused Session's directory.
  // A running turn used to stay in the pane after a workspace switch even
  // when the catalog assigns that Session to the workspace just left, so
  // every workspace opened its terminal in that one directory.
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
    w2: openPane(createLayout('w2'), pane('p2', 's1')),
  })
  const rows = {
    s1: { id: 's1', blank: false, running: true, updatedAt: 1, cwd: 'C:\\w1' },
    s3: { id: 's3', blank: false, running: false, updatedAt: 10, cwd: 'C:\\w2' },
    s4: { id: 's4', blank: false, running: false, updatedAt: 20, cwd: 'C:\\w2' },
  }
  const { controller } = readyController({ storage, rows })
  const listeners = new Set()
  let key = 's1'
  const opened = []
  const current = {
    getSnapshot: () => ({ key }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setKey(next) {
      key = next
      for (const listener of listeners) listener()
    },
  }
  // Sticky: openSession is attempted, but current stays on s1 while that
  // Session still holds a mainView the shell did not drop.
  controller.attachWorkspace({
    openSession(sessionId) {
      opened.push(sessionId)
    },
  })
  controller.attachSessionSelection(current)

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().sessionId, 's4')
  assert.notEqual(controller.getSnapshot().panes.p2.sessionId, 's1')

  current.setKey('s1')
  assert.equal(controller.getSnapshot().workspaceId, 'w2', 'the unchanged current must not navigate back')
  assert.equal(controller.getSnapshot().sessionId, 's4')

  const terminals = []
  controller.panel.attach({
    isExpanded: () => false,
    toggleExpanded() {},
    screen() {
      return { sessionId: controller.getSnapshot().sessionId, surface: {} }
    },
    openTabIn(sessionId, kind) {
      terminals.push([sessionId, kind, rows[sessionId]?.cwd])
    },
    openTab(kind) {
      terminals.push(['mounted', kind, rows[key]?.cwd])
    },
  })

  assert.equal(controller.openVisibleTool('terminal'), true)
  assert.deepEqual(terminals, [['s4', 'terminal', 'C:\\w2']])
  assert.equal(opened.includes('s1'), false)
  controller.dispose()
})

test('switching workspace does not replace a running conversation that is not started yet', () => {
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
    w2: openPane(createLayout('w2'), pane('p2', 'draft')),
  })
  const rows = {
    ...CONVERSATION_ROWS,
    draft: { id: 'draft', blank: true, running: true, updatedAt: 5 },
  }
  const { controller } = readyController({
    storage,
    rows,
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
      { workspaceId: 'w2', sessionIds: ['draft', 's3', 's4'] },
      { workspaceId: 'w3', sessionIds: [] },
    ],
  })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)

  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(controller.getSnapshot().sessionId, 'draft')
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 'draft')
  controller.dispose()
})

test('switching workspace keeps a blank draft that is not running', () => {
  const storage = memoryStorage({
    w1: openPane(createLayout('w1'), pane('p1', 's1')),
    w2: openPane(createLayout('w2'), pane('p2', 'draft')),
  })
  const rows = {
    ...CONVERSATION_ROWS,
    draft: { id: 'draft', blank: true, running: false, updatedAt: 5 },
  }
  const { controller } = readyController({
    storage,
    rows,
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
      { workspaceId: 'w2', sessionIds: ['draft', 's3', 's4'] },
      { workspaceId: 'w3', sessionIds: [] },
    ],
  })

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)
  assert.equal(controller.getSnapshot().sessionId, 'draft')
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 'draft')

  assert.equal(controller.switchWorkspace('w1'), true)
  assert.equal(controller.switchWorkspace('w2'), true)
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 'draft')
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
// Deleting a workspace
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
  // Deleting a registration is not closing panes and does not select a panel.
  assert.deepEqual(fake.calls.interrupt, [])
  assert.deepEqual(fake.calls.selectPanel, [])
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
// "Enabled": ever opened in split
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

// ---------------------------------------------------------------------------
// Cold start: no navigation until the restore settles (#12)
// ---------------------------------------------------------------------------

/**
 * A shell current the controller can move, plus the native reveal it follows.
 * The controller reads `uiWorkspace` through the plain ctx fallback when the
 * fake has no `get`, which is what this module's fakeCtx provides.
 *
 * @param {string} [initialKey]
 */
function movableCurrent(initialKey = 'native-old') {
  let key = initialKey
  const opened = []
  const listeners = new Set()
  const current = {
    opened,
    getSnapshot: () => ({ key }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setKey(next) {
      key = next
      for (const listener of [...listeners]) listener()
    },
  }
  const uiWorkspace = {
    openSession(sessionId) {
      opened.push(sessionId)
      key = sessionId
      for (const listener of [...listeners]) listener()
    },
  }
  return { current, uiWorkspace }
}

/** Rows for the restored pane session and the shell's own native selection. */
function bootRows() {
  return {
    s1: { id: 's1', title: 'Pane', blank: false, updatedAt: 20 },
    'native-old': { id: 'native-old', title: 'Native', blank: false, updatedAt: 1 },
  }
}

/**
 * A shell current whose first `openSession` calls are refused.
 *
 * `sessions.retain` throws while the session list has not published a restored
 * id, so the shell's own navigation can refuse even though the plugin already
 * shows the conversation.
 *
 * @param {string} [initialKey]
 * @param {{refusals?: number}} [options]
 */
function refusingCurrent(initialKey = 'native-old', { refusals = 1 } = {}) {
  let key = initialKey
  let remaining = refusals
  const attempts = []
  const opened = []
  const listeners = new Set()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  const current = {
    opened,
    getSnapshot: () => ({ key }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const uiWorkspace = {
    openSession(sessionId) {
      attempts.push(sessionId)
      if (remaining > 0) {
        remaining -= 1
        throw new Error(`sessions.retain: unknown session ${sessionId}`)
      }
      opened.push(sessionId)
      key = sessionId
      notify()
    },
  }
  return { current, uiWorkspace, attempts }
}

/** One restored workspace with a single pane showing `s1`. */
function restoredSinglePane() {
  return memoryStorage({ w1: openPane(createLayout('w1'), pane('p1', 's1')) })
}

/** Boot a controller with one restored pane and a movable shell current. */
function bootWithCurrent({ shellKey = 'native-old', catalogPhase = 'pending', controllerOptions } = {}) {
  const { fake, controller } = readyController({
    storage: restoredSinglePane(),
    rows: bootRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 'native-old'] }],
    workspacesPhase: catalogPhase,
    controllerOptions,
  })
  const shell = movableCurrent(shellKey)
  fake.ctx.uiWorkspace = shell.uiWorkspace
  controller.attachSessionSelection(shell.current)
  return { fake, controller, shell }
}

test('the cold start does not move the shell current while the catalogs are still loading', () => {
  const boot = bootWithCurrent()

  assert.equal(boot.controller.activate(), true)
  assert.equal(boot.controller.getSnapshot().sessionId, 's1', 'the restore still shows its own pane')
  assert.deepEqual(boot.shell.current.opened, [], 'navigation waits for the restore to settle')
  boot.controller.dispose()
})

test('the shell current published at startup does not replace the restored pane', () => {
  // Catalogs are already ready, so the cold start settles inside `activate`.
  // dsh then points current at the selection it saved, which is an older
  // conversation than the pane. That notification is not a user navigation.
  const boot = bootWithCurrent({ catalogPhase: 'ready' })

  assert.equal(boot.controller.activate(), true)
  assert.equal(boot.controller.getSnapshot().sessionId, 's1')

  boot.shell.current.setKey('native-old')

  assert.equal(boot.controller.getSnapshot().sessionId, 's1')
  assert.equal(boot.controller.getSnapshot().panes.p1.sessionId, 's1')
  boot.controller.dispose()
})

test('the settled cold start reveals the restored pane exactly once', () => {
  const boot = bootWithCurrent()

  assert.equal(boot.controller.activate(), true)
  assert.deepEqual(boot.shell.current.opened, [])

  boot.fake.setWorkspacesPhase('ready')

  assert.deepEqual(boot.shell.current.opened, ['s1'])
  boot.controller.dispose()
})

test('an attached workspace face reveals even when the root context cannot see it', () => {
  // Cordis only exposes a service inside the `inject` scope that asked for it,
  // so `ctx.get('uiWorkspace')` from the pane kernel is undefined in the real
  // shell. The client entry attaches the face; without it every reveal was a
  // silent no-op and the right bar stayed on the startup workspace.
  const { fake, controller } = readyController({
    storage: restoredSinglePane(),
    rows: bootRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 'native-old'] }],
    workspacesPhase: 'pending',
  })
  const shell = movableCurrent('native-old')
  assert.equal(fake.ctx.uiWorkspace, undefined, 'the root context exposes no uiWorkspace')
  controller.attachWorkspace(shell.uiWorkspace)
  controller.attachSessionSelection(shell.current)

  assert.equal(controller.activate(), true)
  assert.deepEqual(shell.current.opened, [], 'the cold start still waits for the catalog')

  fake.setWorkspacesPhase('ready')
  assert.deepEqual(shell.current.opened, ['s1'])
  assert.equal(shell.current.getSnapshot().key, 's1')
  controller.dispose()
})

test('detaching the workspace face stops the reveal it enabled', () => {
  const boot = bootWithCurrent()
  delete boot.fake.ctx.uiWorkspace
  const detach = boot.controller.attachWorkspace(boot.shell.uiWorkspace)
  detach()

  assert.equal(boot.controller.activate(), true)
  boot.fake.setWorkspacesPhase('ready')

  assert.deepEqual(boot.shell.current.opened, [])
  boot.controller.dispose()
})

test('the reveal calls openSession through the face, never detached', () => {
  // `uiWorkspace.openSession` is a prototype method that reads
  // `this.replaceMain`; extracting it and calling it bare throws instead of
  // moving the current session.
  const { controller } = readyController({
    storage: restoredSinglePane(),
    rows: bootRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 'native-old'] }],
  })
  const shell = movableCurrent('native-old')
  controller.attachSessionSelection(shell.current)
  assert.equal(controller.activate(), true)
  assert.deepEqual(shell.current.opened, [], 'no face is attached yet')

  const calls = []
  const instance = {
    replaceMain(sessionId) {
      calls.push(sessionId)
    },
    openSession(sessionId) {
      this.replaceMain(sessionId)
    },
  }
  controller.attachWorkspace(instance)

  assert.equal(controller.revealFocusedSession(), true)
  assert.deepEqual(calls, ['s1'])
  controller.dispose()
})

test('a shell current that already names the pane is not revealed again after settling', () => {
  const boot = bootWithCurrent({ shellKey: 's1' })

  assert.equal(boot.controller.activate(), true)
  boot.fake.setWorkspacesPhase('ready')

  assert.deepEqual(boot.shell.current.opened, [])
  boot.controller.dispose()
})

test('a user focus during the cold-start window reveals immediately', () => {
  const boot = bootWithCurrent()

  assert.equal(boot.controller.activate(), true)
  assert.equal(boot.controller.revealFocusedSession(), true)

  assert.deepEqual(boot.shell.current.opened, ['s1'])
  boot.controller.dispose()
})

test('a reveal that ran before the shell current was readable is replayed when it attaches', () => {
  // `uiWorkspace` and `uiSession` resolve independently. When the restore
  // settles first, the reveal cannot read `uiSession.current` and does
  // nothing; nothing else used to ask again, so the right bar stayed on the
  // startup Session and its terminal opened in that workspace.
  const { controller } = readyController({
    storage: restoredSinglePane(),
    rows: bootRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 'native-old'] }],
  })
  const shell = refusingCurrent('native-old', { refusals: 0 })
  controller.attachWorkspace(shell.uiWorkspace)

  assert.equal(controller.activate(), true)
  assert.deepEqual(shell.attempts, [], 'the reveal has no current to compare with yet')

  controller.attachSessionSelection(shell.current)

  assert.deepEqual(shell.attempts, ['s1'], 'the bar follows the pane once current is readable')
  assert.equal(shell.current.getSnapshot().key, 's1')
  controller.dispose()
})

test('a reveal the shell refuses is retried once it can move', async () => {
  // A cold start can ask the shell to show a restored Session before its list
  // publishes that id; `sessions.retain` throws instead of navigating. The
  // refusal must not be remembered as settled, or the bar never follows the
  // pane and a tool opened from it uses the startup workspace's directory.
  const { controller } = readyController({
    storage: restoredSinglePane(),
    rows: bootRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 'native-old'] }],
  })
  const shell = refusingCurrent('native-old', { refusals: 1 })
  controller.attachWorkspace(shell.uiWorkspace)
  controller.attachSessionSelection(shell.current)

  assert.equal(controller.activate(), true)
  assert.deepEqual(shell.attempts, ['s1'], 'the settled cold start asks once')
  assert.deepEqual(shell.current.opened, [], 'the shell refused the not-yet-publishable Session')
  assert.equal(shell.current.getSnapshot().key, 'native-old')

  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.deepEqual(shell.current.opened, ['s1'], 'the bounded follow-up moves current when it can')
  assert.equal(shell.current.getSnapshot().key, 's1')
  controller.dispose()
})

test('a cold start that reveals before the session list publishes it recovers when the list lands', () => {
  // The regression this test pins: the restore runs while the session list is
  // still empty (`complete()` only checks the two phases), the settlement
  // reveals the restored session and the shell refuses it. The pane reference
  // is re-acquired when the list arrives; the reveal used to be remembered as
  // settled, so the right bar stayed on the startup Session, and a terminal
  // opened from it ran in that workspace.
  const { fake, controller } = readyController({
    storage: restoredSinglePane(),
    rows: {},
    sessionsPhase: 'ready',
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 'native-old'] }],
    retainThrowsUnknown: true,
  })
  const shell = refusingCurrent('native-old', { refusals: 1 })
  controller.attachWorkspace(shell.uiWorkspace)
  controller.attachSessionSelection(shell.current)

  assert.equal(controller.activate(), false, 'the too-early pane retain cannot succeed')
  fake.setSessions(bootRows(), 'ready')

  assert.equal(shell.attempts[0], 's1', 'the settlement asked for the restored Session')
  assert.deepEqual(shell.current.opened, ['s1'], 'the list landing retries the refused reveal')
  assert.equal(shell.current.getSnapshot().key, 's1')
  controller.dispose()
})

test('a catalog that never reports ready still lets the deadline reveal the pane', async () => {
  const boot = bootWithCurrent({ controllerOptions: { bootRevealTimeoutMs: 5 } })

  assert.equal(boot.controller.activate(), true)
  assert.deepEqual(boot.shell.current.opened, [])

  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.deepEqual(boot.shell.current.opened, ['s1'], 'the deadline opens the reveal gate')
  boot.controller.dispose()
})

test('disposing before the deadline cancels the pending reveal', async () => {
  const boot = bootWithCurrent({ controllerOptions: { bootRevealTimeoutMs: 5 } })

  assert.equal(boot.controller.activate(), true)
  boot.controller.dispose()

  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.deepEqual(boot.shell.current.opened, [])
})

// ---------------------------------------------------------------------------
// Cold start: focused pane first (#13, option B)
// ---------------------------------------------------------------------------

/** A two-pane layout whose focus is the second pane. */
function twoPaneLayout() {
  return split(openPane(createLayout('w1'), pane('p1', 's1')), 'p1', 'row', pane('p2', 's2'))
}

/** Rows for both panes of `twoPaneLayout`. */
function twoPaneRows() {
  return {
    s1: { id: 's1', title: 'One', blank: false, updatedAt: 1 },
    s2: { id: 's2', title: 'Two', blank: false, updatedAt: 2 },
  }
}

test('a restored multi-pane layout retains the focused pane before the rest', () => {
  const frames = []
  const { fake, controller } = readyController({
    storage: memoryStorage({ w1: twoPaneLayout() }),
    rows: twoPaneRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }],
    controllerOptions: { scheduleFrame: (fn) => frames.push(fn) },
  })

  assert.equal(controller.activate(), true)

  const retained = fake.calls.retain
    .filter((call) => call.options.source === PANE_SOURCE)
    .map((call) => call.sessionId)
  assert.deepEqual(retained, ['s2', 's1'], 'the focused pane opens first')
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.getSnapshot().mountFocusedOnly, true, 'the first frame shows only the focused pane')

  const frame = frames.shift()
  assert.equal(typeof frame, 'function')
  frame()

  assert.equal(controller.getSnapshot().mountFocusedOnly, false, 'the next frame mounts every pane')
  assert.equal(controller.activate(), true, 'a later activation does not re-arm the window')
  assert.equal(controller.getSnapshot().mountFocusedOnly, false)
  controller.dispose()
})

test('an explicit activation mounts every pane at once', () => {
  const frames = []
  const { controller } = readyController({
    storage: memoryStorage({ w1: twoPaneLayout() }),
    rows: twoPaneRows(),
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }],
    controllerOptions: { scheduleFrame: (fn) => frames.push(fn) },
  })

  assert.equal(controller.activate('s1'), true)

  assert.equal(controller.getSnapshot().mountFocusedOnly, false, 'a user action is not a cold start')
  assert.deepEqual(frames, [])
  controller.dispose()
})