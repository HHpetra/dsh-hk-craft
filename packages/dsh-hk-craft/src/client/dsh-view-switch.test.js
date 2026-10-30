'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CHAT_VIEW,
  TRAJECTORY_VIEW,
  createViewSwitch,
  effectiveView,
  viewSegments,
} = require('./dsh-view-switch.js')

/** Stand-in for the public `ctx.uiConversation` face (the View activation seam). */
function fakeUiConversation({ reject = [] } = {}) {
  const calls = []
  return {
    calls,
    binding(sessionId) {
      if (reject.includes(sessionId)) {
        throw new Error(`uiConversation.binding: unknown session "${sessionId}"`)
      }
      return {
        activate(viewId) {
          calls.push({ sessionId, viewId })
        },
      }
    },
  }
}

/** Stand-in for `ctx.configForms.developerTools.enabled` (the dsh availability gate). */
function fakeDeveloperTools(initial = true) {
  let enabled = initial
  const listeners = new Set()
  return {
    enabled: {
      getSnapshot: () => enabled,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    setEnabled(next) {
      enabled = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

/** @returns {any} a ctx carrying whichever dsh faces the test provides */
function switchCtx({ uiConversation, developerTools } = {}) {
  return {
    uiConversation,
    configForms: developerTools === undefined ? undefined : { developerTools },
  }
}

test('activating a pane view goes through the public uiConversation binding', () => {
  const uiConversation = fakeUiConversation()
  const viewSwitch = createViewSwitch(switchCtx({ uiConversation }))

  assert.deepEqual(viewSwitch.activate('s1', TRAJECTORY_VIEW), { ok: true })
  assert.deepEqual(viewSwitch.activate('s1', CHAT_VIEW), { ok: true })
  assert.deepEqual(uiConversation.calls, [
    { sessionId: 's1', viewId: 'trajectory' },
    { sessionId: 's1', viewId: 'chat' },
  ])
})

test('activating an unknown or inactive session fails without throwing', () => {
  const uiConversation = fakeUiConversation({ reject: ['gone'] })
  const viewSwitch = createViewSwitch(switchCtx({ uiConversation }))

  const result = viewSwitch.activate('gone', TRAJECTORY_VIEW)

  assert.equal(result.ok, false)
  assert.match(result.error, /unknown session/)
  assert.deepEqual(uiConversation.calls, [])
})

test('activation fails cleanly when the shell exposes no uiConversation service', () => {
  const viewSwitch = createViewSwitch(switchCtx())

  const result = viewSwitch.activate('s1', CHAT_VIEW)

  assert.equal(result.ok, false)
  assert.match(result.error, /uiConversation/)
})

test('trajectory availability mirrors the developer-tools gate dsh uses', () => {
  const developerTools = fakeDeveloperTools(true)
  const viewSwitch = createViewSwitch(switchCtx({ developerTools }))

  assert.equal(viewSwitch.isTrajectoryAvailable(), true)

  developerTools.setEnabled(false)
  assert.equal(viewSwitch.isTrajectoryAvailable(), false)
})

test('availability stays false until the developer-tools value is accepted', () => {
  const viewSwitch = createViewSwitch(switchCtx())

  // dsh's DeveloperToolsPreference reads `value?.enabled ?? false`; ui-conversation
  // skips the trajectory View while that gate is false.
  assert.equal(viewSwitch.isTrajectoryAvailable(), false)
})

test('availability subscribers are forwarded to the developer-tools store and released', () => {
  const developerTools = fakeDeveloperTools(false)
  const viewSwitch = createViewSwitch(switchCtx({ developerTools }))
  let notifications = 0
  const unsubscribe = viewSwitch.subscribeAvailability(() => {
    notifications += 1
  })

  developerTools.setEnabled(true)
  assert.equal(notifications, 1)
  assert.equal(viewSwitch.isTrajectoryAvailable(), true)

  unsubscribe()
  assert.equal(developerTools.listenerCount(), 0)
  developerTools.setEnabled(false)
  assert.equal(notifications, 1)
})

test('subscribing availability without a developer-tools face is a safe no-op', () => {
  const viewSwitch = createViewSwitch(switchCtx())
  const unsubscribe = viewSwitch.subscribeAvailability(() => {})
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
})

test('a disabled trajectory segment reads as chat, using the same availability rule', () => {
  assert.equal(effectiveView(TRAJECTORY_VIEW, true), TRAJECTORY_VIEW)
  assert.equal(effectiveView(TRAJECTORY_VIEW, false), CHAT_VIEW)
  assert.equal(effectiveView(CHAT_VIEW, false), CHAT_VIEW)

  assert.deepEqual(viewSegments(true), [
    { id: CHAT_VIEW, disabled: false },
    { id: TRAJECTORY_VIEW, disabled: false },
  ])
  assert.deepEqual(viewSegments(false), [
    { id: CHAT_VIEW, disabled: false },
    { id: TRAJECTORY_VIEW, disabled: true },
  ])
})
