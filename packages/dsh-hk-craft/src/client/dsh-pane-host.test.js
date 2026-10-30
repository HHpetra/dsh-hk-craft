'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CONTENT_FACTORY,
  PANE_SOURCE,
  MAIN_SOURCE,
  PANEL_KEY,
  probeConversationContent,
  findCurrentSession,
  derivePanePhase,
  createPaneController,
} = require('./dsh-pane-host.js')

/** Stand-in for the public `ctx.slots` face used by the probe. */
function fakeSlots(result) {
  const calls = []
  return {
    calls,
    snapshot(name) {
      calls.push(name)
      return result
    },
  }
}

test('probe finds the live conversation.content factory', () => {
  const slots = fakeSlots([{ type: 'factory', name: CONTENT_FACTORY, scope: 'session-maybe' }])
  const probe = probeConversationContent(slots)

  assert.equal(probe.ok, true)
  assert.equal(probe.status, 'present')
  assert.deepEqual(slots.calls, [`factory:${CONTENT_FACTORY}`])
})

test('probe reports a clear missing result instead of throwing', () => {
  const probe = probeConversationContent(fakeSlots([]))

  assert.equal(probe.ok, false)
  assert.equal(probe.status, 'missing')
})

test('probe treats a throw from the slots face as unavailable, not present', () => {
  const slots = {
    snapshot() {
      throw new Error('snapshot off')
    },
  }
  const probe = probeConversationContent(slots)

  assert.equal(probe.ok, false)
  assert.equal(probe.status, 'error')
  assert.match(probe.message, /snapshot off/)
})

test('probe stays optimistic when the shell exposes no snapshot capability', () => {
  const probe = probeConversationContent({})

  assert.equal(probe.ok, true)
  assert.equal(probe.status, 'unknown')
})

test('the explicitly chosen target defaults to the derived current session', () => {
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          idle: { id: 'idle', retainedBy: {} },
          current: { id: 'current', retainedBy: { mainView: 1 } },
          background: { id: 'background', retainedBy: { sidebarView: 1 } },
        },
      }),
    },
  }

  assert.equal(findCurrentSession(sessions), 'current')
  assert.equal(findCurrentSession({ list: { getSnapshot: () => ({ byId: {} }) } }), undefined)
})

test('pane phase follows the native Conversation phase derivation', () => {
  assert.deepEqual(derivePanePhase({ sessionId: undefined }), { phase: 'hero', hero: true })

  assert.deepEqual(
    derivePanePhase({
      sessionId: 's1',
      session: { blank: true, openState: 'open' },
      conversation: { activeTargets: new Set() },
      summaryBlank: true,
    }),
    { phase: 'hero', hero: true },
  )

  assert.deepEqual(
    derivePanePhase({
      sessionId: 's1',
      session: { blank: false, awaitingFirstTurn: false, running: false, promptAttempted: true },
      conversation: { activeTargets: new Set() },
      summaryBlank: false,
    }),
    { phase: 'active', hero: false },
  )

  assert.deepEqual(
    derivePanePhase({
      sessionId: 's1',
      session: { blank: true, openState: 'loading' },
      conversation: { activeTargets: new Set() },
      summaryBlank: false,
    }),
    { phase: 'settling', hero: false },
  )
})

/** Minimal `ctx` for the controller: sessions, layout, slots and workspaces. */
function fakeControllerCtx({
  rows = {},
  factorySnapshot = [],
  selectPanelFails = false,
  retainFails = false,
  retainFailsFor = {},
  createFails = false,
  created = [],
  workspaces = [],
} = {}) {
  const calls = { retain: [], selectPanel: [], create: [] }
  const references = []
  const createdIds = [...created]
  let createCount = 0
  const listeners = new Set()
  const entryErrorListeners = new Set()
  const panel = { activePanelId: null }
  const panelInfo = {
    getSnapshot: () => ({ activePanelId: panel.activePanelId }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const layout = {
    panelInfo,
    selectPanel(panelId) {
      calls.selectPanel.push(panelId)
      if (selectPanelFails) throw new Error('panel not registered')
      panel.activePanelId = panelId
      for (const listener of [...listeners]) listener()
    },
  }
  const sessions = {
    list: { getSnapshot: () => ({ byId: rows }) },
    retain(sessionId, options) {
      if (retainFails) throw new Error('session cannot be retained')
      if (retainFailsFor[sessionId] === true) throw new Error(`session ${sessionId} cannot be retained`)
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
      if (createFails) throw new Error('session cannot be created')
      const next = createdIds.shift()
      createCount += 1
      return next ?? `created-${createCount}`
    },
  }
  const slots = {
    snapshot(name) {
      return name === `factory:${CONTENT_FACTORY}` ? factorySnapshot : []
    },
    onEntryError(listener) {
      entryErrorListeners.add(listener)
      return () => entryErrorListeners.delete(listener)
    },
  }
  const workspacesService = {
    list: {
      getSnapshot: () => ({ items: workspaces, archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready' }),
    },
  }
  return {
    ctx: { sessions, layout, slots, workspaces: workspacesService },
    calls,
    references,
    panel,
    reportEntryError(key, entry, error) {
      for (const listener of [...entryErrorListeners]) listener(key, entry, error, { abdicated: false })
    },
    setPanel(panelId) {
      panel.activePanelId = panelId
      for (const listener of [...listeners]) listener()
    },
  }
}

const FACTORY_PRESENT = [{ type: 'factory', name: CONTENT_FACTORY, scope: 'session-maybe' }]

test('activating retains the chosen session for the pane and for main-view focus', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate('s1'), true)
  assert.deepEqual(fake.calls.retain, [
    { sessionId: 's1', options: { source: PANE_SOURCE } },
    { sessionId: 's1', options: { source: MAIN_SOURCE } },
  ])
  assert.deepEqual(fake.calls.selectPanel, [PANEL_KEY])
  assert.equal(fake.references[0].released, false)
  assert.equal(fake.references[1].released, false)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, 's1')

  controller.activate('s1')
  assert.equal(fake.calls.retain.length, 2)
  controller.dispose()
})

test('activating without a session still shows the pane with a hint and no reference', () => {
  const fake = fakeControllerCtx()
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate(), true)
  assert.deepEqual(fake.calls.retain, [])
  assert.deepEqual(fake.calls.selectPanel, [PANEL_KEY])
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, null)
  controller.dispose()
})

test('deactivating returns to the native panel and releases the retained reference', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  controller.deactivate()

  assert.deepEqual(fake.calls.selectPanel, [PANEL_KEY, null])
  assert.equal(fake.references[0].released, true)
  assert.equal(controller.getSnapshot().active, false)
  assert.equal(controller.getSnapshot().sessionId, null)
})

test('an external return to the native panel releases the pane reference', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  fake.setPanel(null)

  assert.equal(fake.references[0].released, true)
  assert.equal(controller.getSnapshot().active, false)
})

test('a failed panel switch reports an error and does not leak a reference', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, selectPanelFails: true })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate('s1'), false)
  assert.equal(fake.references[0].released, true)
  assert.match(controller.getSnapshot().error, /panel not registered/)
  assert.equal(controller.getSnapshot().active, false)
})

test('a failed retain keeps the native view and surfaces the error', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, retainFails: true })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate('s1'), false)
  assert.deepEqual(fake.calls.selectPanel, [])
  assert.match(controller.getSnapshot().error, /cannot be retained/)
  assert.equal(controller.getSnapshot().active, false)
})

test('activating before the main entry is registered is a visible no-op', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)

  assert.equal(controller.activate('s1'), false)
  assert.deepEqual(fake.calls.retain, [])
  assert.deepEqual(fake.calls.selectPanel, [])
  assert.match(controller.getSnapshot().error, /not registered yet/)
})

test('a missing conversation.content factory is surfaced but the pane still mounts', () => {
  const fake = fakeControllerCtx({ factorySnapshot: [] })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate('s1'), true)
  assert.equal(controller.getSnapshot().probe.ok, false)
  assert.equal(controller.getSnapshot().probe.status, 'missing')
})

test('a factory crash reported by the slots supervision is surfaced instead of a blank cell', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  fake.reportEntryError(`factory:${CONTENT_FACTORY}`, {}, new Error('render exploded'))

  assert.equal(controller.getSnapshot().probe.ok, false)
  assert.equal(controller.getSnapshot().probe.status, 'error')
  assert.match(controller.getSnapshot().probe.message, /render exploded/)
  assert.equal(controller.getSnapshot().active, true)
})

test('unrelated slot crashes do not disable the pane factory', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  fake.reportEntryError('sidebar.footer.action', {}, new Error('other entry'))

  assert.equal(controller.getSnapshot().probe.status, 'present')
})

test('dispose releases every reference and unsubscribes from the layout source', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  controller.dispose()

  assert.equal(fake.references[0].released, true)
  fake.setPanel(null)
  assert.equal(controller.getSnapshot().active, false)
})

// ---------------------------------------------------------------------------
// Multi-pane layout (ticket 05)
// ---------------------------------------------------------------------------

/** Retained references still holding dsh's single "current session" slot. */
function liveMainView(fake) {
  return fake.references.filter((reference) => reference.options?.source === MAIN_SOURCE && !reference.released)
}

/** Retained pane references that are still alive. */
function livePaneRefs(fake) {
  return fake.references.filter((reference) => reference.options?.source === PANE_SOURCE && !reference.released)
}

const WORKSPACE = [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }]

/** Stand-in for the `dsh-view-switch.js` adapter (ticket 07). */
function fakeViewSwitch({ trajectoryAvailable = true, failActivate = false } = {}) {
  const calls = []
  const listeners = new Set()
  let available = trajectoryAvailable
  let failing = failActivate
  return {
    calls,
    activate(sessionId, viewId) {
      if (failing) return { ok: false, error: 'view switch exploded' }
      calls.push({ sessionId, viewId })
      return { ok: true }
    },
    isTrajectoryAvailable: () => available,
    subscribeAvailability(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setAvailable(next) {
      available = next
      for (const listener of [...listeners]) listener()
    },
    failNext(next = true) {
      failing = next
    },
    listenerCount: () => listeners.size,
  }
}

/** Activate one pane with a session and return the ready controller. */
async function readyController(options = {}) {
  const ids = [...(options.paneIds ?? ['p1', 'p2', 'p3'])]
  const viewSwitch = options.viewSwitch ?? fakeViewSwitch()
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, workspaces: WORKSPACE, ...options })
  const controller = createPaneController(fake.ctx, { nextPaneId: () => ids.shift(), viewSwitch })
  controller.markRegistered()
  controller.activate('s1')
  return { fake, controller, viewSwitch }
}

test('splitting creates a new session beside the pane and moves the main view to it', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })

  assert.equal(await controller.split('p1', 'row'), true)

  const state = controller.getSnapshot()
  assert.deepEqual(state.root, {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', paneId: 'p1' },
    b: { kind: 'leaf', paneId: 'p2' },
  })
  assert.deepEqual(state.panes.p2, { paneId: 'p2', sessionId: 's2', view: 'chat' })
  assert.equal(state.activePaneId, 'p2')
  assert.equal(state.sessionId, 's2')
  assert.deepEqual(fake.calls.create, [{ workspaceId: 'w1' }])
  assert.deepEqual(
    fake.calls.retain.map((call) => [call.sessionId, call.options.source]),
    [
      ['s1', PANE_SOURCE],
      ['s1', MAIN_SOURCE],
      ['s2', PANE_SOURCE],
      ['s2', MAIN_SOURCE],
    ],
  )
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's2')
  controller.dispose()
})

test('focusing another pane releases the old main view and takes the new one', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(controller.focusPane('p1'), true)

  const live = liveMainView(fake)
  assert.equal(live.length, 1)
  assert.equal(live[0].sessionId, 's1')
  assert.equal(fake.references.filter((reference) => reference.options?.source === MAIN_SOURCE)[1].released, true)
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(controller.getSnapshot().sessionId, 's1')
  controller.dispose()
})

test('closing a pane releases both of its references and promotes the sibling', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(controller.closePane('p2'), true)

  assert.deepEqual(controller.getSnapshot().root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(Object.keys(controller.getSnapshot().panes), ['p1'])
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(livePaneRefs(fake).length, 1)
  assert.equal(livePaneRefs(fake)[0].sessionId, 's1')
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's1')
  controller.dispose()
})

test('closing the focused pane of three moves focus and the main view to the neighbour', async () => {
  const { fake, controller } = await readyController({ created: ['s2', 's3'] })
  await controller.split('p1', 'row')
  await controller.split('p2', 'col')

  // row(p1, col(p2, p3)); p3 is focused and bottom-right.
  assert.equal(controller.getSnapshot().activePaneId, 'p3')
  assert.equal(controller.closePane('p3'), true)

  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.getSnapshot().sessionId, 's2')
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's2')
  controller.dispose()
})

test('closing the last pane keeps the panel active with the empty state and no references', async () => {
  const { fake, controller } = await readyController()

  assert.equal(controller.closePane('p1'), true)

  const state = controller.getSnapshot()
  assert.equal(state.active, true)
  assert.equal(state.root, null)
  assert.deepEqual(state.panes, {})
  assert.equal(state.activePaneId, null)
  assert.equal(state.sessionId, null)
  assert.equal(livePaneRefs(fake).length, 0)
  assert.equal(liveMainView(fake).length, 0)
  controller.dispose()
})

test('replacing the focused session swaps its references and keeps the pane identity', async () => {
  const { fake, controller } = await readyController()

  assert.equal(controller.replaceFocusedSession('s9'), true)

  const state = controller.getSnapshot()
  assert.deepEqual(state.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(state.panes.p1, { paneId: 'p1', sessionId: 's9', view: 'chat' })
  assert.equal(state.sessionId, 's9')
  assert.deepEqual(
    fake.calls.retain.map((call) => [call.sessionId, call.options.source]),
    [
      ['s1', PANE_SOURCE],
      ['s1', MAIN_SOURCE],
      ['s9', PANE_SOURCE],
      ['s9', MAIN_SOURCE],
    ],
  )
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's9')
  controller.dispose()
})

test('replacing with a session already open elsewhere focuses that pane instead of mounting twice', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(controller.replaceFocusedSession('s1'), true)

  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.deepEqual(Object.keys(controller.getSnapshot().panes).sort(), ['p1', 'p2'])
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's1')
  controller.dispose()
})

test('/clear in a focused pane creates a conversation and swaps it into that pane', async () => {
  const { fake, controller } = await readyController()

  assert.equal(await controller.newInFocused('w1'), true)

  assert.deepEqual(fake.calls.create, [{ workspaceId: 'w1' }])
  assert.deepEqual(controller.getSnapshot().panes.p1, {
    paneId: 'p1',
    sessionId: 'created-1',
    view: 'chat',
  })
  assert.equal(controller.getSnapshot().root.paneId, 'p1')
  controller.dispose()
})

test('/clear with no pane creates the first pane instead of leaving the workspace empty', async () => {
  const { fake, controller } = await readyController()
  controller.closePane('p1')

  assert.equal(await controller.newInFocused('w1'), true)
  const activePaneId = controller.getSnapshot().activePaneId
  assert.equal(activePaneId, 'p2')
  assert.equal(controller.getSnapshot().panes[activePaneId].sessionId, 'created-1')
  assert.equal(liveMainView(fake).length, 1)
  controller.dispose()
})

test('/clear is refused while the pane panel is not showing', async () => {
  const { fake, controller } = await readyController()
  controller.deactivate()

  assert.equal(await controller.newInFocused('w1'), false)
  assert.deepEqual(fake.calls.create, [])
  controller.dispose()
})

test('splitting with an explicit session opens it without creating a new one', async () => {
  const { fake, controller } = await readyController()

  assert.equal(await controller.split('p1', 'col', { sessionId: 's9' }), true)

  assert.deepEqual(fake.calls.create, [])
  assert.deepEqual(controller.getSnapshot().panes.p2, { paneId: 'p2', sessionId: 's9', view: 'chat' })
  assert.deepEqual(controller.getSnapshot().root.a, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(controller.getSnapshot().root.b, { kind: 'leaf', paneId: 'p2' })
  controller.dispose()
})

test('splitting with a session that is already open focuses its pane and adds no pane', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(await controller.split('p2', 'row', { sessionId: 's1' }), false)
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 2)
  assert.deepEqual(fake.calls.create, [{ workspaceId: 'w1' }])
  controller.dispose()
})

test('a split whose new session cannot be retained is aborted, not half-built', async () => {
  const { fake, controller } = await readyController({ created: ['s2'], retainFailsFor: { s2: true } })

  assert.equal(await controller.split('p1', 'row'), false)

  assert.deepEqual(controller.getSnapshot().root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(Object.keys(controller.getSnapshot().panes), ['p1'])
  assert.match(controller.getSnapshot().error, /s2 cannot be retained/)
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's1')
  controller.dispose()
})

test('a split without a resolvable workspace reports an error and adds no pane', async () => {
  const { fake, controller } = await readyController({ workspaces: [] })

  assert.equal(await controller.split('p1', 'row'), false)

  assert.deepEqual(fake.calls.create, [])
  assert.deepEqual(Object.keys(controller.getSnapshot().panes), ['p1'])
  assert.match(controller.getSnapshot().error, /workspace/)
  controller.dispose()
})

test('a view change drives only that pane and keeps the layout a pure update', async () => {
  const { controller, viewSwitch } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(controller.setView('p1', 'trajectory'), true)
  assert.deepEqual(viewSwitch.calls, [{ sessionId: 's1', viewId: 'trajectory' }])
  assert.equal(controller.getSnapshot().panes.p1.view, 'trajectory')
  assert.equal(controller.getSnapshot().panes.p2.view, 'chat')

  assert.equal(controller.resize([], 0.8), true)
  assert.equal(controller.getSnapshot().root.ratio, 0.8)
  assert.equal(controller.resize([], 0.8), false)
  assert.equal(controller.resize(['missing'], 0.2), false)
  assert.equal(controller.setView('missing', 'chat'), false)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Per-pane conversation View switch (ticket 07)
// ---------------------------------------------------------------------------

test('switching a pane view never re-retains its session or touches the tree', async () => {
  const { fake, controller, viewSwitch } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  const reference = controller.paneReference('p1')
  const retained = fake.calls.retain.length
  const rootBefore = controller.getSnapshot().root

  assert.equal(controller.setView('p1', 'trajectory'), true)

  const state = controller.getSnapshot()
  assert.deepEqual(viewSwitch.calls, [{ sessionId: 's1', viewId: 'trajectory' }])
  assert.deepEqual(state.panes.p1, { paneId: 'p1', sessionId: 's1', view: 'trajectory' })
  assert.deepEqual(state.panes.p2, { paneId: 'p2', sessionId: 's2', view: 'chat' })
  // A View switch is not a session swap: same retained reference, same panes,
  // same tree — only the remembered view differs.
  assert.equal(controller.paneReference('p1'), reference)
  assert.equal(fake.calls.retain.length, retained)
  assert.deepEqual(state.root, rootBefore)
  assert.equal(state.sessionId, 's2')
  controller.dispose()
})

test('a disabled trajectory segment cannot switch a pane even when asked directly', async () => {
  const { controller, viewSwitch } = await readyController({
    viewSwitch: fakeViewSwitch({ trajectoryAvailable: false }),
  })

  assert.equal(controller.isTrajectoryAvailable(), false)
  assert.equal(controller.setView('p1', 'trajectory'), false)
  assert.deepEqual(viewSwitch.calls, [])
  assert.equal(controller.getSnapshot().panes.p1.view, 'chat')
  controller.dispose()
})

test('a failed View activation keeps the remembered view and surfaces the error', async () => {
  const { controller } = await readyController({ viewSwitch: fakeViewSwitch({ failActivate: true }) })

  assert.equal(controller.setView('p1', 'trajectory'), false)
  assert.equal(controller.getSnapshot().panes.p1.view, 'chat')
  assert.match(controller.getSnapshot().error, /view switch exploded/)
  controller.dispose()
})

test('mounting a pane re-asserts its remembered view on that session binding', async () => {
  const { controller, viewSwitch } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  controller.setView('p1', 'trajectory')
  viewSwitch.calls.length = 0

  assert.equal(controller.restoreViewFor('s1'), true)
  assert.equal(controller.restoreViewFor('s2'), true)
  assert.equal(controller.restoreViewFor('gone'), false)
  assert.deepEqual(viewSwitch.calls, [
    { sessionId: 's1', viewId: 'trajectory' },
    { sessionId: 's2', viewId: 'chat' },
  ])
  controller.dispose()
})

test('re-enabling developer tools re-applies the pane trajectory memory', async () => {
  const { controller, viewSwitch } = await readyController()
  controller.setView('p1', 'trajectory')
  viewSwitch.calls.length = 0

  viewSwitch.setAvailable(false)
  assert.equal(controller.isTrajectoryAvailable(), false)
  assert.deepEqual(viewSwitch.calls, [])

  viewSwitch.setAvailable(true)
  assert.deepEqual(viewSwitch.calls, [{ sessionId: 's1', viewId: 'trajectory' }])

  controller.dispose()
  assert.equal(viewSwitch.listenerCount(), 0)
})

test('deactivating keeps the layout and releases references; activating restores them', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  const layoutBefore = controller.getSnapshot()

  controller.deactivate()

  assert.equal(controller.getSnapshot().active, false)
  assert.equal(controller.getSnapshot().sessionId, null)
  assert.deepEqual(controller.getSnapshot().root, layoutBefore.root)
  assert.equal(livePaneRefs(fake).length, 0)
  assert.equal(liveMainView(fake).length, 0)

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.getSnapshot().sessionId, 's2')
  assert.equal(livePaneRefs(fake).length, 2)
  assert.equal(liveMainView(fake).length, 1)
  controller.dispose()
})

test('an external return to the native panel keeps the layout but drops references', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  fake.setPanel(null)

  assert.equal(controller.getSnapshot().active, false)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 2)
  assert.equal(livePaneRefs(fake).length, 0)
  assert.equal(liveMainView(fake).length, 0)
})

test('every pane exposes its retained reference for rendering', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(controller.paneReference('p1').sessionId, 's1')
  assert.equal(controller.paneReference('p2').sessionId, 's2')
  assert.equal(controller.paneReference('p3'), undefined)
  assert.equal(controller.focusedPane().paneId, 'p2')
  assert.equal(controller.currentReference().sessionId, 's2')
  controller.dispose()
})

test('dispose releases every pane reference in a multi-pane layout', async () => {
  const { fake, controller } = await readyController({ created: ['s2', 's3'] })
  await controller.split('p1', 'row')
  await controller.split('p2', 'col')

  controller.dispose()

  assert.equal(livePaneRefs(fake).length, 0)
  assert.equal(liveMainView(fake).length, 0)
  assert.equal(controller.getSnapshot().active, false)
})

test('closing a pane by its session is how the conversation fallbacks escape', async () => {
  const { controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  assert.equal(controller.closePaneBySession('s1'), true)
  assert.deepEqual(Object.keys(controller.getSnapshot().panes), ['p2'])
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.closePaneBySession('gone'), false)
  controller.dispose()
})

test('/clear can open the first pane from the empty state without a session', async () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, workspaces: WORKSPACE })
  const controller = createPaneController(fake.ctx, { nextPaneId: () => 'p9' })
  controller.markRegistered()
  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().root, null)

  assert.equal(await controller.newInFocused(), true)

  assert.deepEqual(fake.calls.create, [{ workspaceId: 'w1' }])
  assert.equal(controller.getSnapshot().activePaneId, 'p9')
  assert.equal(controller.getSnapshot().panes.p9.sessionId, 'created-1')
  assert.equal(liveMainView(fake).length, 1)
  controller.dispose()
})
