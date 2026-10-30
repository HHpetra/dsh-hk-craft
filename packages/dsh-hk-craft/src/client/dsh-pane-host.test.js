'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CONTENT_FACTORY,
  PANE_SOURCE,
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

/** Minimal `ctx` for the controller: sessions, layout and a live panel source. */
function fakeControllerCtx({ rows = {}, factorySnapshot = [], selectPanelFails = false, retainFails = false } = {}) {
  const calls = { retain: [], selectPanel: [] }
  const references = []
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
  return {
    ctx: { sessions, layout, slots },
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

test('activating retains the chosen session once and selects the pane panel', () => {
  const fake = fakeControllerCtx({ factorySnapshot: FACTORY_PRESENT })
  const controller = createPaneController(fake.ctx)
  controller.markRegistered()

  assert.equal(controller.activate('s1'), true)
  assert.deepEqual(fake.calls.retain, [{ sessionId: 's1', options: { source: PANE_SOURCE } }])
  assert.deepEqual(fake.calls.selectPanel, [PANEL_KEY])
  assert.equal(fake.references[0].released, false)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().sessionId, 's1')

  controller.activate('s1')
  assert.equal(fake.calls.retain.length, 1)
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
