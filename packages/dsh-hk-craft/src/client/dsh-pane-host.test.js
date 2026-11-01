'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CONTENT_FACTORY,
  PANE_SOURCE,
  MAIN_SOURCE,
  CONVERSATION_KEY,
  MAIN_PANEL_PRIORITY,
  probeConversationContent,
  derivePanePhase,
  createPaneController,
} = require('./dsh-pane-host.js')
const { interruptSession } = require('./pane-close.js')
const { PANE_SETTINGS_KEY, PANE_SETTINGS_VERSION } = require('./pane-budget.js')
const { createLayout, openPane, split: splitLayout, resize: resizeLayout, leaves } = require('./layout-tree.js')
const { encodeLayout, layoutKey } = require('./layout-store.js')

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

test('interruptSession uses the same scoped conversation.cancel as the stop button', async () => {
  const calls = []
  const sessions = {
    scope(sessionId) {
      calls.push(['scope', sessionId])
      return {
        get(name) {
          assert.equal(name, 'conversation')
          return {
            cancel() {
              calls.push(['cancel'])
              return Promise.resolve({ ok: true })
            },
          }
        },
      }
    },
  }

  await interruptSession(sessions, 's1')
  assert.deepEqual(calls, [['scope', 's1'], ['cancel']])
})

test('interruptSession falls back to the session cancel binding', async () => {
  const calls = []
  const sessions = {
    scope: () => ({ get: () => undefined }),
    binding(sessionId) {
      return {
        session: {
          cancel() {
            calls.push(sessionId)
            return Promise.resolve({ ok: true })
          },
        },
      }
    },
  }

  await interruptSession(sessions, 's1')
  assert.deepEqual(calls, ['s1'])
})

test('interruptSession turns a binding failure result into a rejection', async () => {
  const sessions = {
    scope: () => ({ get: () => undefined }),
    binding: () => ({
      session: {
        cancel: () => Promise.resolve({ ok: false, error: { code: 'session/not-running', message: 'no turn' } }),
      },
    }),
  }

  await assert.rejects(() => interruptSession(sessions, 's1'), /no turn/)
})

test('interruptSession reports a missing public route instead of silently succeeding', async () => {
  await assert.rejects(() => interruptSession({}, 's1'), /public interrupt/)
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

test('a pane derives the live phase without ui-conversation own hook', () => {
  // A pane gets the Session standard props only; `conversation` is
  // ui-conversation's private hook. Treating its absence as "no Session" made
  // every pane read as blank and therefore as the Factory's `hero` (or
  // `settling`) state, whose composer stack is not the pinned seat.
  assert.deepEqual(
    derivePanePhase({
      sessionId: 's1',
      session: { blank: false, awaitingFirstTurn: false, running: false, openState: 'open' },
      summaryBlank: false,
    }),
    { phase: 'active', hero: false },
  )

  assert.deepEqual(
    derivePanePhase({
      sessionId: 's1',
      session: { blank: true, awaitingFirstTurn: false, running: false, promptAttempted: false, openState: 'open' },
      summaryBlank: true,
    }),
    { phase: 'hero', hero: true },
  )

  assert.deepEqual(
    derivePanePhase({
      sessionId: 's1',
      session: { blank: true, awaitingFirstTurn: false, running: false, openState: 'loading' },
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
  interruptFails = false,
  deferredInterrupts = null,
} = {}) {
  const calls = { retain: [], selectPanel: [], create: [], interrupt: [] }
  let interruptFailure = interruptFails
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
    scope(sessionId) {
      return {
        get(name) {
          if (name !== 'conversation') return undefined
          return {
            cancel() {
              calls.interrupt.push({ sessionId, route: 'conversation' })
              if (deferredInterrupts !== null) {
                return new Promise((resolve, reject) => {
                  deferredInterrupts.push({ resolve, reject })
                })
              }
              if (interruptFailure) return Promise.reject(new Error('interrupt failed'))
              return Promise.resolve({ ok: true })
            },
          }
        },
      }
    },
    binding(sessionId) {
      return {
        session: {
          cancel() {
            calls.interrupt.push({ sessionId, route: 'binding' })
            if (interruptFailure) return Promise.resolve({ ok: false, error: { message: 'interrupt failed' } })
            return Promise.resolve({ ok: true })
          },
        },
      }
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
    rows,
    panel,
    setInterruptFailure(value) {
      interruptFailure = value
    },
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
  assert.deepEqual(fake.calls.selectPanel, [])
  assert.equal(fake.panel.activePanelId, null)
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
  assert.deepEqual(fake.calls.selectPanel, [])
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, null)
  controller.dispose()
})

test('an external panel change keeps split mode and the pane references', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  fake.setPanel('settings')
  fake.setPanel(null)

  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, 's1')
  assert.equal(fake.references[0].released, false)
  assert.equal(fake.references[1].released, false)
  assert.deepEqual(fake.calls.selectPanel, [])
  controller.dispose()
})

test('a failed retain stays in split mode, drops the reference and surfaces the error', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, retainFails: true })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate('s1'), false)
  assert.deepEqual(fake.calls.selectPanel, [])
  assert.deepEqual(fake.calls.retain, [])
  assert.match(controller.getSnapshot().error, /cannot be retained/)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, null)
  controller.dispose()
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

test('dispose releases every reference and does not select a panel', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.activate('s1')

  controller.dispose()

  assert.equal(fake.references[0].released, true)
  assert.equal(fake.references[1].released, true)
  assert.deepEqual(fake.calls.selectPanel, [])
  fake.setPanel(null)
  assert.equal(controller.getSnapshot().active, false)
})

/** A stand-in for `uiSession.adapter.current`. `setKey` notifies subscribers. */
function sessionCurrent() {
  const listeners = new Set()
  let key = null
  return {
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
}

test('toggleRightbar flips the sidebar service and publishes expanded', () => {
  const fake = fakeControllerCtx()
  const controller = createPaneController(fake.ctx)
  let expanded = false
  const calls = []
  controller.attachRightbar({
    isExpanded: () => expanded,
    toggleExpanded() {
      calls.push('toggle')
      expanded = !expanded
    },
  })

  assert.equal(controller.getSnapshot().rightbarAvailable, true)
  assert.equal(controller.getSnapshot().rightbarExpanded, false)
  assert.equal(controller.toggleRightbar(), true)
  assert.deepEqual(calls, ['toggle'])
  assert.equal(controller.getSnapshot().rightbarExpanded, true)

  controller.attachRightbar(null)
  assert.equal(controller.getSnapshot().rightbarAvailable, false)
  assert.equal(controller.getSnapshot().rightbarExpanded, false)
  assert.equal(controller.toggleRightbar(), false)
  controller.dispose()
})

test('a rightbar toggle failure is reported and does not claim success', () => {
  const fake = fakeControllerCtx()
  const controller = createPaneController(fake.ctx)
  controller.attachRightbar({
    isExpanded: () => {
      throw new Error('no surface')
    },
    toggleExpanded() {
      throw new Error('rightbar down')
    },
  })

  assert.equal(controller.getSnapshot().rightbarAvailable, true)
  assert.equal(controller.getSnapshot().rightbarExpanded, false)
  assert.equal(controller.toggleRightbar(), false)
  assert.match(controller.getSnapshot().error, /rightbar down/)
  controller.dispose()
})

test('a current session that no pane holds replaces the focused pane', async () => {
  const { controller } = await readyController()
  const current = sessionCurrent()
  controller.attachSessionSelection(current)

  current.setKey('s9')

  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(controller.getSnapshot().sessionId, 's9')
  assert.equal(controller.getSnapshot().panes.p1.sessionId, 's9')
  controller.dispose()
})

test('a current session that a pane already holds focuses that pane', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  const current = sessionCurrent()
  controller.attachSessionSelection(current)
  const retainsBefore = fake.calls.retain.length

  current.setKey('s1')

  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(controller.getSnapshot().sessionId, 's1')
  assert.equal(liveMainView(fake)[0].sessionId, 's1')
  assert.ok(fake.calls.retain.length > retainsBefore)
  controller.dispose()
})

test('a current session with no focused pane opens that session', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  assert.equal(controller.activate(), true)
  const current = sessionCurrent()
  controller.attachSessionSelection(current)

  current.setKey('s9')

  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, 's9')
  const pane = controller.getSnapshot().panes[controller.getSnapshot().activePaneId]
  assert.equal(pane.sessionId, 's9')
  controller.dispose()
})

test('retaining mainView does not re-enter current routing', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const current = sessionCurrent()
  const retain = fake.ctx.sessions.retain.bind(fake.ctx.sessions)
  fake.ctx.sessions.retain = (sessionId, options) => {
    const reference = retain(sessionId, options)
    if (options?.source === MAIN_SOURCE) current.setKey(sessionId)
    return reference
  }
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()
  controller.attachSessionSelection(current)

  assert.equal(controller.activate('s1'), true)

  assert.equal(fake.calls.retain.length, 2)
  assert.equal(controller.getSnapshot().sessionId, 's1')
  assert.deepEqual(
    fake.calls.retain.map((call) => call.options.source),
    [PANE_SOURCE, MAIN_SOURCE],
  )
  controller.dispose()
})

test('current changes are ignored until split mode is active', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  const current = sessionCurrent()
  controller.attachSessionSelection(current)

  current.setKey('s9')

  assert.equal(controller.getSnapshot().active, false)
  assert.deepEqual(fake.calls.retain, [])
  controller.dispose()
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
  assert.deepEqual(fake.calls.interrupt, [])
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Closing a running pane interrupts its conversation (ticket 09)
// ---------------------------------------------------------------------------

/** Rows with `s1` mid-turn, which is what makes a close ask for confirmation. */
function runningRows() {
  return { s1: { id: 's1', running: true } }
}

test('closing a running pane asks first and leaves the session and its refs untouched', async () => {
  const { fake, controller } = await readyController({ rows: runningRows() })

  assert.equal(controller.closePane('p1'), false)

  const state = controller.getSnapshot()
  assert.deepEqual(state.pendingClose, { paneId: 'p1', sessionId: 's1' })
  assert.deepEqual(state.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(Object.keys(state.panes), ['p1'])
  assert.equal(state.sessionId, 's1')
  assert.deepEqual(fake.calls.interrupt, [])
  assert.equal(livePaneRefs(fake).length, 1)
  assert.equal(liveMainView(fake).length, 1)
  controller.dispose()
})

test('cancelling the close confirmation changes nothing', async () => {
  const { fake, controller } = await readyController({ rows: runningRows() })
  controller.closePane('p1')

  assert.equal(controller.cancelClose(), true)

  const state = controller.getSnapshot()
  assert.equal(state.pendingClose, null)
  assert.equal(state.closeError, null)
  assert.deepEqual(state.root, { kind: 'leaf', paneId: 'p1' })
  assert.equal(state.sessionId, 's1')
  assert.deepEqual(fake.calls.interrupt, [])
  assert.equal(livePaneRefs(fake).length, 1)
  controller.dispose()
})

test('confirming interrupts the turn once, then releases the pane and keeps the history row', async () => {
  const { fake, controller } = await readyController({ rows: runningRows() })
  controller.closePane('p1')

  assert.equal(await controller.confirmClose(), true)

  const state = controller.getSnapshot()
  assert.deepEqual(fake.calls.interrupt, [{ sessionId: 's1', route: 'conversation' }])
  assert.equal(state.pendingClose, null)
  assert.equal(state.closeBusy, false)
  assert.equal(state.root, null)
  assert.deepEqual(state.panes, {})
  assert.equal(livePaneRefs(fake).length, 0)
  assert.equal(liveMainView(fake).length, 0)
  // Release is a client-reference teardown, not a delete: the row /resume reads
  // is still in the host list snapshot.
  assert.equal(fake.rows.s1.running, true)
  assert.equal(await controller.confirmClose(), false)
  assert.deepEqual(fake.calls.interrupt, [{ sessionId: 's1', route: 'conversation' }])
  controller.dispose()
})

test('a second confirm while the interrupt is in flight is ignored', async () => {
  const deferred = []
  const { fake, controller } = await readyController({
    rows: runningRows(),
    deferredInterrupts: deferred,
  })
  controller.closePane('p1')

  const first = controller.confirmClose()
  assert.equal(controller.getSnapshot().closeBusy, true)
  assert.equal(await controller.confirmClose(), false)
  assert.deepEqual(fake.calls.interrupt, [{ sessionId: 's1', route: 'conversation' }])

  deferred[0].resolve({ ok: true })
  assert.equal(await first, true)
  assert.equal(controller.getSnapshot().closeBusy, false)
  assert.equal(controller.getSnapshot().root, null)
  controller.dispose()
})

test('a failed interrupt keeps the pane mounted, its references and the dialog error visible', async () => {
  const { fake, controller } = await readyController({
    rows: runningRows(),
    interruptFails: true,
  })
  controller.closePane('p1')

  assert.equal(await controller.confirmClose(), false)

  const state = controller.getSnapshot()
  assert.match(state.closeError, /interrupt failed/)
  assert.equal(state.closeBusy, false)
  assert.deepEqual(state.pendingClose, { paneId: 'p1', sessionId: 's1' })
  assert.deepEqual(state.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(Object.keys(state.panes), ['p1'])
  assert.equal(livePaneRefs(fake).length, 1)
  assert.equal(liveMainView(fake).length, 1)

  // The user can retry after the transient failure, and that retry closes it.
  fake.setInterruptFailure(false)
  assert.equal(await controller.confirmClose(), true)
  assert.equal(controller.getSnapshot().root, null)
  assert.deepEqual(fake.calls.interrupt, [
    { sessionId: 's1', route: 'conversation' },
    { sessionId: 's1', route: 'conversation' },
  ])
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

test('/clear is refused before split mode is active', async () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, workspaces: WORKSPACE })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.getSnapshot().active, false)
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

test('a disabled trajectory View cannot switch a pane even when asked directly', async () => {
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

test('another panel does not leave split mode; activate keeps the focused pane', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  const layoutBefore = controller.getSnapshot()

  fake.setPanel('settings')

  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, 's2')
  assert.deepEqual(controller.getSnapshot().root, layoutBefore.root)
  assert.equal(livePaneRefs(fake).length, 2)
  assert.equal(liveMainView(fake).length, 1)

  assert.equal(controller.activate(), true)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(controller.getSnapshot().sessionId, 's2')
  assert.equal(livePaneRefs(fake).length, 2)
  assert.equal(liveMainView(fake).length, 1)
  assert.deepEqual(fake.calls.selectPanel, [])
  controller.dispose()
})

test('an external panel change keeps the layout and the pane references', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  fake.setPanel(null)

  assert.equal(controller.getSnapshot().active, true)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 2)
  assert.equal(livePaneRefs(fake).length, 2)
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's2')
  controller.dispose()
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

// ---------------------------------------------------------------------------
// Per-workspace scope and the staged close (tickets 08 / 09 together)
// ---------------------------------------------------------------------------

const TWO_WORKSPACES = [
  { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
  { workspaceId: 'w2', sessionIds: ['s3'] },
]

test('switching workspace dismisses the staged close of the workspace being left', async () => {
  const fake = fakeControllerCtx({
    factorySnapshot: FACTORY_PRESENT,
    workspaces: TWO_WORKSPACES,
    rows: { s1: { id: 's1', running: true } },
  })
  const controller = createPaneController(fake.ctx, { nextPaneId: () => 'p1' })
  controller.markRegistered()
  controller.activate('s1')

  assert.equal(controller.closePane('p1'), false)
  assert.deepEqual(controller.getSnapshot().pendingClose, { paneId: 'p1', sessionId: 's1' })

  assert.equal(controller.switchWorkspace('w2'), true)

  assert.equal(controller.getSnapshot().pendingClose, null)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(controller.getSnapshot().layouts.w1.panes.p1, {
    paneId: 'p1',
    sessionId: 's1',
    view: 'chat',
  })
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Strip actions (ticket 06)
// ---------------------------------------------------------------------------

test('focusPaneAt focuses the strip position, using the strip projection', async () => {
  const { controller } = await readyController({ created: ['s2', 's3'] })
  await controller.split('p1', 'row')
  await controller.split('p2', 'col')

  // row(p1, col(p2, p3)): p3 is focused.
  assert.equal(controller.getSnapshot().activePaneId, 'p3')

  assert.equal(controller.focusPaneAt(1), true)
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(controller.focusPaneAt(3), true)
  assert.equal(controller.getSnapshot().activePaneId, 'p3')

  assert.equal(controller.focusPaneAt(4), false)
  assert.equal(controller.focusPaneAt(0), false)
  assert.equal(controller.focusPaneAt(1.5), false)
  controller.dispose()
})

test('+ splits the focused pane 50/50 and gives it the new conversation', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })

  assert.equal(await controller.newPane(), true)

  const state = controller.getSnapshot()
  assert.deepEqual(state.root, {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', paneId: 'p1' },
    b: { kind: 'leaf', paneId: 'p2' },
  })
  assert.equal(state.panes.p2.sessionId, 's2')
  assert.equal(state.activePaneId, 'p2')
  assert.deepEqual(fake.calls.create, [{ workspaceId: 'w1' }])
  controller.dispose()
})

test('+ evens the row by pane count and drops a dragged ratio', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4'],
    paneIds: ['p1', 'p2', 'p3', 'p4'],
  })
  await controller.split('p1', 'row')
  assert.equal(controller.resize([], 0.7), true)
  await controller.split('p2', 'row')

  assert.equal(await controller.newPane(), true)

  const state = controller.getSnapshot()
  assert.equal(state.root.ratio, 1 / 4)
  assert.equal(state.root.b.ratio, 1 / 3)
  assert.equal(state.root.b.b.ratio, 1 / 2)
  assert.deepEqual(state.root.a, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(state.root.b.a, { kind: 'leaf', paneId: 'p2' })
  assert.deepEqual(state.root.b.b.a, { kind: 'leaf', paneId: 'p3' })
  assert.deepEqual(state.root.b.b.b, { kind: 'leaf', paneId: 'p4' })
  assert.equal(state.activePaneId, 'p4')
  assert.equal(state.panes.p4.sessionId, 's4')
  assert.equal(fake.calls.create.length, 3)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// The pane budget (sidebar-style split limit, default 4, 0 = unlimited)
// ---------------------------------------------------------------------------

/** @returns {{getItem: Function, setItem: Function, removeItem: Function}} */
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

test('the default four-pane budget refuses a fifth pane and frees up after a close', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4', 's5'],
    paneIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')
  await controller.split('p3', 'row')

  assert.equal(controller.getSnapshot().maxPanes, 4)
  assert.equal(controller.splitBlock(), 'budget')
  const creates = fake.calls.create.length
  assert.equal(await controller.newPane(), false)
  assert.equal(await controller.split('p2', 'row'), false)
  assert.equal(fake.calls.create.length, creates)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 4)

  assert.equal(controller.closePane('p4'), true)
  assert.equal(controller.splitBlock(), undefined)
  assert.equal(await controller.newPane(), true)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 4)
  controller.dispose()
})

test('a limit of 0 removes the pane budget', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4', 's5'],
    paneIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')
  await controller.split('p3', 'row')

  assert.equal(controller.setMaxPanes(0), 0)
  assert.equal(controller.getSnapshot().maxPanes, 0)
  assert.equal(controller.splitBlock(), undefined)
  assert.equal(await controller.newPane(), true)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 5)
  controller.dispose()
})

test('the pane limit persists in the settings key and is re-read by a new controller', async () => {
  const storage = memoryStorage()
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT, workspaces: WORKSPACE })
  const first = createPaneController(fake.ctx, { storage, nextPaneId: () => 'p1' })
  first.setMaxPanes(2)

  const raw = storage.getItem(PANE_SETTINGS_KEY)
  assert.deepEqual(JSON.parse(raw), { version: PANE_SETTINGS_VERSION, maxPanes: 2 })

  const second = createPaneController(fake.ctx, { storage, nextPaneId: () => 'p1' })
  assert.equal(second.getSnapshot().maxPanes, 2)
  first.dispose()
  second.dispose()
})

test('an invalid pane limit falls back to the default and lowering it never closes panes', async () => {
  const { controller } = await readyController({
    created: ['s2', 's3'],
    paneIds: ['p1', 'p2', 'p3'],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')

  assert.equal(controller.setMaxPanes(-3), 4)
  assert.equal(controller.setMaxPanes(1.5), 4)
  assert.equal(controller.setMaxPanes('four'), 4)
  assert.equal(controller.getSnapshot().maxPanes, 4)

  assert.equal(controller.setMaxPanes(2), 2)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 3)
  assert.equal(controller.splitBlock(), 'budget')
  controller.dispose()
})

test('a session already open is focused when the pane budget is spent', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4'],
    paneIds: ['p1', 'p2', 'p3', 'p4'],
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4'] }],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')
  await controller.split('p3', 'row')
  assert.equal(controller.splitBlock(), 'budget')
  assert.equal(controller.getSnapshot().activePaneId, 'p4')

  const creates = fake.calls.create.length
  assert.equal(controller.focusPane('p1'), true)
  assert.equal(controller.getSnapshot().activePaneId, 'p1')

  assert.equal(await controller.openInNewPane('s2'), false)
  assert.equal(controller.getSnapshot().activePaneId, 'p2')

  assert.equal(await controller.split('p4', 'row', { sessionId: 's1' }), false)
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 4)
  assert.equal(fake.calls.create.length, creates)
  controller.dispose()
})

test('an empty workspace opens its first pane without spending the split budget', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3'],
    paneIds: ['p1', 'p2', 'p3'],
  })
  assert.equal(controller.closePane('p1'), true)
  assert.equal(controller.setMaxPanes(1), 1)
  assert.equal(controller.splitBlock(), undefined)

  assert.equal(await controller.newPane(), true)

  const state = controller.getSnapshot()
  assert.equal(state.root.kind, 'leaf')
  assert.equal(Object.keys(state.panes).length, 1)
  assert.equal(controller.splitBlock(), 'budget')
  const creates = fake.calls.create.length
  assert.equal(await controller.newPane(), false)
  assert.equal(fake.calls.create.length, creates)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 1)
  controller.dispose()
})

test('each workspace spends its own pane budget', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4', 's5', 's6'],
    paneIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4'] },
      { workspaceId: 'w2', sessionIds: ['s5', 's6'] },
    ],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')
  await controller.split('p3', 'row')
  assert.equal(controller.splitBlock('w1'), 'budget')

  assert.equal(controller.switchWorkspace('w2'), true)
  assert.equal(controller.splitBlock(), undefined)
  assert.equal(controller.splitBlock('w1'), 'budget')

  assert.equal(await controller.newPane(), true)
  assert.equal(controller.getSnapshot().root.kind, 'leaf')
  assert.equal(await controller.newPane(), true)
  assert.equal(controller.getSnapshot().root.dir, 'row')
  assert.equal(controller.getSnapshot().root.ratio, 0.5)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 2)
  assert.equal(Object.keys(controller.getSnapshot().layouts.w1.panes).length, 4)

  const creates = fake.calls.create.length
  assert.equal(await controller.split('p1', 'row'), false)
  assert.equal(fake.calls.create.length, creates)
  assert.equal(Object.keys(controller.getSnapshot().layouts.w1.panes).length, 4)
  controller.dispose()
})

test('overlapping splits cannot create a pane past the cap', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4'],
    paneIds: ['p1', 'p2', 'p3', 'p4'],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')

  const creates = fake.calls.create.length
  const first = controller.newPane()
  assert.equal(controller.splitBlock(), 'budget')
  const second = controller.newPane()

  assert.equal(await first, true)
  assert.equal(await second, false)
  assert.equal(fake.calls.create.length, creates + 1)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 4)
  controller.dispose()
})

test('overlapping splits still fill every remaining slot under the cap', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4'],
    paneIds: ['p1', 'p2', 'p3', 'p4'],
  })
  await controller.split('p1', 'row')

  const creates = fake.calls.create.length
  const first = controller.newPane()
  assert.equal(controller.splitBlock(), undefined)
  const second = controller.newPane()
  assert.equal(controller.splitBlock(), 'budget')
  const third = controller.newPane()

  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(await third, false)
  assert.equal(fake.calls.create.length, creates + 2)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 4)
  controller.dispose()
})

test('a split that already cleared the budget still lands when the cap drops while the session is creating', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3'],
    paneIds: ['p1', 'p2', 'p3'],
  })
  assert.equal(controller.setMaxPanes(2), 2)

  const attempted = []
  const originalCreate = fake.ctx.sessions.create.bind(fake.ctx.sessions)
  let finishCreate
  fake.ctx.sessions.create = (options) => {
    attempted.push(options)
    // A second create must not hang the test if the cap fails to refuse it.
    if (attempted.length > 1) return Promise.resolve('extra')
    return new Promise((resolve, reject) => {
      finishCreate = () => originalCreate(options).then(resolve, reject)
    })
  }

  const first = controller.newPane()
  assert.equal(controller.splitBlock(), 'budget')
  assert.equal(controller.setMaxPanes(1), 1)
  assert.equal(controller.getSnapshot().maxPanes, 1)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 1)

  const second = controller.newPane()
  assert.equal(await second, false)
  assert.equal(attempted.length, 1)
  assert.equal(fake.calls.create.length, 0)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 1)

  finishCreate()
  assert.equal(await first, true)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 2)
  assert.equal(controller.getSnapshot().panes.p2.sessionId, 's2')
  assert.equal(controller.splitBlock(), 'budget')
  assert.equal(attempted.length, 1)
  assert.equal(fake.calls.create.length, 1)
  controller.dispose()
})

test('a second new conversation is ignored while an empty workspace is still opening its first pane', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4'],
    paneIds: ['p1', 'p2', 'p3', 'p4'],
  })
  assert.equal(controller.closePane('p1'), true)

  const attempted = []
  const originalCreate = fake.ctx.sessions.create.bind(fake.ctx.sessions)
  let releaseCreate
  fake.ctx.sessions.create = (options) => {
    attempted.push(options)
    if (attempted.length > 1) return originalCreate(options)
    return new Promise((resolve, reject) => {
      releaseCreate = () => originalCreate(options).then(resolve, reject)
    })
  }

  const opening = controller.newPane()
  const againByPane = controller.newPane()
  const againByFocused = controller.newInFocused('w1')

  assert.equal(attempted.length, 1)
  assert.equal(fake.calls.create.length, 0)
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 0)
  assert.equal(controller.getSnapshot().root, null)

  releaseCreate()
  await opening
  await againByPane
  await againByFocused

  const opened = controller.getSnapshot()
  assert.equal(Object.keys(opened.panes).length, 1)
  assert.equal(fake.calls.create.length, 1)
  assert.equal(attempted.length, 1)
  assert.deepEqual(opened.root, { kind: 'leaf', paneId: 'p2' })
  assert.equal(opened.panes.p2.sessionId, 's2')
  assert.equal(opened.activePaneId, 'p2')

  await controller.newInFocused('w1')
  const replaced = controller.getSnapshot()
  assert.equal(Object.keys(replaced.panes).length, 1)
  assert.equal(fake.calls.create.length, 2)
  assert.deepEqual(replaced.root, { kind: 'leaf', paneId: 'p2' })
  assert.equal(replaced.panes.p2.sessionId, 's3')

  await controller.newPane()
  const split = controller.getSnapshot()
  assert.equal(Object.keys(split.panes).length, 2)
  assert.equal(fake.calls.create.length, 3)
  assert.deepEqual(split.root, {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', paneId: 'p2' },
    b: { kind: 'leaf', paneId: 'p3' },
  })
  assert.equal(split.panes.p2.sessionId, 's3')
  assert.equal(split.panes.p3.sessionId, 's4')
  assert.equal(split.activePaneId, 'p3')
  controller.dispose()
})

test('an empty workspace\'s first session lands in that workspace only while it is still empty', async () => {
  const replaced = await readyController({
    created: ['s-created'],
    paneIds: ['p1', 'p2', 'p3'],
  })
  assert.equal(replaced.controller.closePane('p1'), true)

  const replacedCreate = replaced.fake.ctx.sessions.create.bind(replaced.fake.ctx.sessions)
  let releaseReplaced
  replaced.fake.ctx.sessions.create = (options) =>
    new Promise((resolve, reject) => {
      releaseReplaced = () => replacedCreate(options).then(resolve, reject)
    })

  const openingReplaced = replaced.controller.newInFocused('w1')
  assert.equal(replaced.controller.activate('s1'), true)
  const waitingReplaced = replaced.controller.getSnapshot()
  assert.equal(waitingReplaced.workspaceId, 'w1')
  assert.equal(Object.keys(waitingReplaced.panes).length, 1)
  assert.deepEqual(waitingReplaced.root, { kind: 'leaf', paneId: 'p2' })
  assert.equal(waitingReplaced.activePaneId, 'p2')
  assert.equal(waitingReplaced.panes.p2.sessionId, 's1')
  assert.equal(waitingReplaced.sessionId, 's1')
  assert.equal(replaced.fake.calls.create.length, 0)

  releaseReplaced()
  assert.equal(await openingReplaced, false)

  const kept = replaced.controller.getSnapshot()
  assert.equal(kept.workspaceId, 'w1')
  assert.equal(Object.keys(kept.panes).length, 1)
  assert.deepEqual(kept.root, { kind: 'leaf', paneId: 'p2' })
  assert.equal(kept.activePaneId, 'p2')
  assert.equal(kept.sessionId, 's1')
  assert.deepEqual(kept.panes.p2, { paneId: 'p2', sessionId: 's1', view: 'chat' })
  assert.equal(kept.layouts.w1.workspaceId, 'w1')
  assert.equal(Object.keys(kept.layouts.w1.panes).length, 1)
  assert.deepEqual(replaced.fake.calls.create, [{ workspaceId: 'w1' }])
  assert.equal(
    Object.values(kept.layouts.w1.panes).some((pane) => pane.sessionId === 's-created'),
    false,
  )
  replaced.controller.dispose()

  const switched = await readyController({
    created: ['s-landed'],
    paneIds: ['p1', 'p2', 'p3'],
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['s1'] },
      { workspaceId: 'w2', sessionIds: ['s3'] },
    ],
  })
  assert.equal(switched.controller.activate('s3'), true)
  assert.equal(switched.controller.switchWorkspace('w1'), true)
  assert.equal(switched.controller.closePane('p1'), true)

  const switchedCreate = switched.fake.ctx.sessions.create.bind(switched.fake.ctx.sessions)
  let releaseSwitched
  switched.fake.ctx.sessions.create = (options) =>
    new Promise((resolve, reject) => {
      releaseSwitched = () => switchedCreate(options).then(resolve, reject)
    })

  const openingSwitched = switched.controller.newPane()
  assert.equal(switched.controller.switchWorkspace('w2'), true)
  const waitingSwitched = switched.controller.getSnapshot()
  assert.equal(waitingSwitched.workspaceId, 'w2')
  assert.equal(waitingSwitched.activePaneId, 'p2')
  assert.equal(waitingSwitched.sessionId, 's3')
  assert.equal(waitingSwitched.layouts.w1.root, null)
  assert.equal(Object.keys(waitingSwitched.layouts.w1.panes).length, 0)
  assert.equal(switched.fake.calls.create.length, 0)

  releaseSwitched()
  assert.equal(await openingSwitched, true)

  const landed = switched.controller.getSnapshot()
  assert.equal(landed.workspaceId, 'w2')
  assert.equal(Object.keys(landed.panes).length, 1)
  assert.deepEqual(landed.root, { kind: 'leaf', paneId: 'p2' })
  assert.equal(landed.activePaneId, 'p2')
  assert.equal(landed.sessionId, 's3')
  assert.deepEqual(landed.panes.p2, { paneId: 'p2', sessionId: 's3', view: 'chat' })
  assert.equal(Object.keys(landed.layouts.w2.panes).length, 1)
  assert.equal(landed.layouts.w1.workspaceId, 'w1')
  assert.equal(Object.keys(landed.layouts.w1.panes).length, 1)
  assert.deepEqual(landed.layouts.w1.root, { kind: 'leaf', paneId: 'p3' })
  assert.equal(landed.layouts.w1.activePaneId, 'p3')
  assert.deepEqual(landed.layouts.w1.panes.p3, { paneId: 'p3', sessionId: 's-landed', view: 'chat' })
  assert.equal(
    Object.values(landed.layouts.w2.panes).some((pane) => pane.sessionId === 's-landed'),
    false,
  )
  assert.deepEqual(switched.fake.calls.create, [{ workspaceId: 'w1' }])
  switched.controller.dispose()
})

test('a refused open in a new pane does not switch into the full workspace', async () => {
  const { fake, controller } = await readyController({
    created: ['s2', 's3', 's4'],
    paneIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4', 's9'] },
      { workspaceId: 'w2', sessionIds: ['s5'] },
    ],
  })
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')
  await controller.split('p3', 'row')
  assert.equal(controller.switchWorkspace('w2'), true)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')

  const creates = fake.calls.create.length
  assert.equal(await controller.openInNewPane('s9'), false)
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.match(controller.getSnapshot().error, /pane limit/)
  assert.equal(Object.keys(controller.getSnapshot().layouts.w1.panes).length, 4)
  assert.equal(fake.calls.create.length, creates)

  // An already-mounted session still focuses, including the workspace switch.
  assert.equal(await controller.openInNewPane('s2'), false)
  assert.equal(controller.getSnapshot().workspaceId, 'w1')
  assert.equal(controller.getSnapshot().activePaneId, 'p2')
  assert.equal(fake.calls.create.length, creates)
  controller.dispose()
})

test('a restored layout wider than the cap stays operable and cannot grow', async () => {
  let layout = openPane(createLayout('w1'), { paneId: 'p1', sessionId: 's1', view: 'chat' })
  layout = splitLayout(layout, 'p1', 'row', { paneId: 'p2', sessionId: 's2', view: 'chat' })
  layout = splitLayout(layout, 'p2', 'col', { paneId: 'p3', sessionId: 's3', view: 'chat' })
  layout = splitLayout(layout, 'p3', 'row', { paneId: 'p4', sessionId: 's4', view: 'chat' })
  layout = splitLayout(layout, 'p4', 'row', { paneId: 'p5', sessionId: 's5', view: 'chat' })
  layout = resizeLayout(layout, [], 0.7)

  const storage = memoryStorage({
    [layoutKey('w1')]: encodeLayout(layout),
    [PANE_SETTINGS_KEY]: JSON.stringify({ version: PANE_SETTINGS_VERSION, maxPanes: 4 }),
  })
  const fake = fakeControllerCtx({
    factorySnapshot: FACTORY_PRESENT,
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4', 's5'] }],
  })
  const controller = createPaneController(fake.ctx, { storage, nextPaneId: () => 'extra' })
  controller.markRegistered()
  assert.equal(controller.switchWorkspace('w1'), true)
  assert.equal(controller.activate(), true)

  assert.deepEqual(leaves(controller.getSnapshot().root), ['p1', 'p2', 'p3', 'p4', 'p5'])
  assert.equal(controller.getSnapshot().root.ratio, 0.7)
  assert.equal(controller.getSnapshot().root.b.dir, 'col')
  assert.equal(controller.focusPane('p1'), true)
  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(controller.resize(['b'], 0.4), true)
  assert.equal(controller.getSnapshot().root.b.dir, 'col')
  assert.equal(controller.getSnapshot().root.b.ratio, 0.4)
  assert.equal(controller.getSnapshot().root.ratio, 0.7)
  assert.equal(controller.splitBlock(), 'budget')

  const creates = fake.calls.create.length
  assert.equal(await controller.newPane(), false)
  assert.equal(fake.calls.create.length, creates)
  assert.deepEqual(leaves(controller.getSnapshot().root), ['p1', 'p2', 'p3', 'p4', 'p5'])
  controller.dispose()
})

test('a failed settings write keeps the in-memory cap and reports the failure', async () => {
  let fail = true
  const values = new Map()
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem(key, value) {
      if (fail) throw new Error('quota')
      values.set(key, value)
    },
  }
  const fake = fakeControllerCtx({
    factorySnapshot: FACTORY_PRESENT,
    workspaces: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3'] }],
    created: ['s2', 's3'],
  })
  const ids = ['p1', 'p2', 'p3', 'p4']
  const controller = createPaneController(fake.ctx, {
    storage,
    nextPaneId: () => ids.shift(),
    viewSwitch: fakeViewSwitch(),
  })
  controller.markRegistered()
  controller.activate('s1')
  await controller.split('p1', 'row')
  await controller.split('p2', 'row')

  assert.equal(controller.setMaxPanes(2), 2)
  assert.equal(controller.getSnapshot().maxPanes, 2)
  assert.equal(controller.getSnapshot().maxPanesError, 'quota')
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 3)
  assert.equal(controller.splitBlock(), 'budget')
  const creates = fake.calls.create.length
  assert.equal(await controller.newPane(), false)
  assert.equal(fake.calls.create.length, creates)

  const unread = createPaneController(fake.ctx, { storage, nextPaneId: () => 'p9' })
  assert.equal(unread.getSnapshot().maxPanes, 4)

  fail = false
  assert.equal(controller.setMaxPanes(3), 3)
  assert.equal(controller.getSnapshot().maxPanesError, null)
  const reread = createPaneController(fake.ctx, { storage, nextPaneId: () => 'p9' })
  assert.equal(reread.getSnapshot().maxPanes, 3)

  const missing = { getItem: () => null }
  const bare = createPaneController(fake.ctx, { storage: missing, nextPaneId: () => 'p1' })
  assert.equal(bare.setMaxPanes(6), 6)
  assert.equal(bare.getSnapshot().maxPanes, 6)
  assert.equal(bare.getSnapshot().maxPanesError, '')

  controller.dispose()
  unread.dispose()
  reread.dispose()
  bare.dispose()
})

test('+ aborts instead of writing a pane when the controller is disposed mid-create', async () => {
  const { fake, controller } = await readyController()
  let resolveCreate
  fake.ctx.sessions.create = () =>
    new Promise((resolve) => {
      resolveCreate = resolve
    })

  const pending = controller.newPane()
  controller.dispose()
  resolveCreate('s9')

  assert.equal(await pending, false)
  assert.deepEqual(controller.getSnapshot().panes, {})
})

test('+ from the empty state opens the first pane instead of doing nothing', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  controller.closePane('p1')

  assert.equal(await controller.newPane(), true)

  const activePaneId = controller.getSnapshot().activePaneId
  assert.equal(activePaneId, 'p2')
  assert.equal(controller.getSnapshot().panes[activePaneId].sessionId, 's2')
  assert.equal(liveMainView(fake).length, 1)
  controller.dispose()
})

test('paneIndexOf reports the strip position used by the /resume badge', async () => {
  const { controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  // row(p1, p2): p1 is position 1, p2 position 2.
  assert.equal(controller.paneIndexOf('s1'), 1)
  assert.equal(controller.paneIndexOf('s2'), 2)
  assert.equal(controller.paneIndexOf('not-open'), null)
  assert.equal(controller.paneIndexOf(''), null)
  controller.dispose()
})

test('Ctrl+Enter opens a chosen conversation in a new pane beside the focused one', async () => {
  const { fake, controller } = await readyController()

  assert.equal(await controller.openInNewPane('s9'), true)

  const state = controller.getSnapshot()
  assert.deepEqual(state.root.a, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(state.root.b, { kind: 'leaf', paneId: 'p2' })
  assert.deepEqual(state.panes.p2, { paneId: 'p2', sessionId: 's9', view: 'chat' })
  assert.equal(state.activePaneId, 'p2')
  assert.deepEqual(fake.calls.create, [])
  assert.equal(liveMainView(fake)[0].sessionId, 's9')
  controller.dispose()
})

test('Ctrl+Enter on a conversation already open focuses its pane instead of duplicating it', async () => {
  const { controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  assert.equal(controller.getSnapshot().activePaneId, 'p2')

  assert.equal(await controller.openInNewPane('s1'), false)

  assert.equal(controller.getSnapshot().activePaneId, 'p1')
  assert.equal(Object.keys(controller.getSnapshot().panes).length, 2)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Dragging one strip entry onto another swaps the pane contents (ticket 10)
// ---------------------------------------------------------------------------

test('swapping two panes exchanges sessions and views, keeping the tree and the focus', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  assert.equal(controller.setView('p1', 'trajectory'), true)
  const rootBefore = controller.getSnapshot().root

  assert.equal(controller.swapPanes('p1', 'p2'), true)

  const state = controller.getSnapshot()
  assert.deepEqual(state.panes.p1, { paneId: 'p1', sessionId: 's2', view: 'chat' })
  assert.deepEqual(state.panes.p2, { paneId: 'p2', sessionId: 's1', view: 'trajectory' })
  // Pane ids, leaf positions, ratios and focus are untouched; only contents move.
  assert.equal(state.root, rootBefore)
  assert.equal(state.activePaneId, 'p2')
  assert.equal(state.sessionId, 's1')
  assert.equal(state.workspaceId, 'w1')
  // dsh's derived "current session" follows the focused pane's new content.
  assert.equal(liveMainView(fake).length, 1)
  assert.equal(liveMainView(fake)[0].sessionId, 's1')
  assert.equal(livePaneRefs(fake).length, 2)
  controller.dispose()
})

test('a swap acquires both pane references before releasing either session', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')

  // Record every retain/release from now on, including the releases of the
  // references the split created above.
  const events = []
  const observe = (reference) => {
    const release = reference.release.bind(reference)
    reference.release = () => {
      events.push(`release:${reference.sessionId}:${reference.options.source}`)
      release()
    }
    return reference
  }
  for (const reference of fake.references) observe(reference)
  const retain = fake.ctx.sessions.retain
  fake.ctx.sessions.retain = (sessionId, options) => {
    events.push(`retain:${sessionId}:${options.source}`)
    return observe(retain(sessionId, options))
  }

  assert.equal(controller.swapPanes('p1', 'p2'), true)

  // A session must never hit a zero retain count between its old and new pane:
  // releasing first would tear down dsh's client generation and lose the
  // scroll position / composer draft the split view exists to preserve.
  assert.ok(events.indexOf('retain:s2:hkcraftPane') < events.indexOf('release:s1:hkcraftPane'))
  assert.ok(events.indexOf('retain:s1:hkcraftPane') < events.indexOf('release:s2:hkcraftPane'))
  assert.equal(livePaneRefs(fake).length, 2)
  assert.equal(liveMainView(fake).length, 1)
  controller.dispose()
})

test('swapping a pane with itself or an unknown pane is a no-op', async () => {
  const { fake, controller } = await readyController({ created: ['s2'] })
  await controller.split('p1', 'row')
  const before = controller.getSnapshot()
  const retains = fake.calls.retain.length

  assert.equal(controller.swapPanes('p1', 'p1'), false)
  assert.equal(controller.swapPanes('p1', 'missing'), false)
  assert.equal(controller.swapPanes('missing', 'p1'), false)

  assert.equal(controller.getSnapshot(), before)
  assert.equal(fake.calls.retain.length, retains)
  controller.dispose()
})

test('swapping panes of two different workspaces is refused', async () => {
  const fake = fakeControllerCtx({
    factorySnapshot: FACTORY_PRESENT,
    workspaces: TWO_WORKSPACES,
    created: ['s3'],
  })
  const ids = ['p1', 'p2']
  const controller = createPaneController(fake.ctx, { nextPaneId: () => ids.shift() })
  controller.markRegistered()
  controller.activate('s1')
  assert.equal(await controller.newInFocused('w2'), true)
  assert.deepEqual(Object.keys(controller.getSnapshot().layouts).sort(), ['w1', 'w2'])

  const before = controller.getSnapshot()
  assert.equal(controller.swapPanes('p1', 'p2'), false)

  assert.equal(controller.getSnapshot(), before)
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Empty-state recent conversations (ticket 10)
// ---------------------------------------------------------------------------

test('recentConversations projects the current workspace through the /resume data path', async () => {
  const fake = fakeControllerCtx({
    factorySnapshot: FACTORY_PRESENT,
    workspaces: WORKSPACE,
    rows: {
      s1: { id: 's1', title: 'Alpha', updatedAt: 2 },
      s2: { id: 's2', title: 'Beta', updatedAt: 1 },
    },
  })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  const rows = await controller.recentConversations('w1')
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.title, row.workspaceId]),
    [
      ['s1', 'Alpha', 'w1'],
      ['s2', 'Beta', 'w1'],
    ],
  )
  // No explicit workspace: the empty state has no focused pane, so the same
  // first-catalog-workspace fallback the new-conversation button uses applies.
  assert.deepEqual(await controller.recentConversations(), rows)
  assert.deepEqual(await controller.recentConversations('missing'), [])
  controller.dispose()
})
