'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloseFlow } = require('./pane-close.js')

/**
 * The close holder with every callback it takes, so each test only states the
 * part it is about.
 */
function withFlow({ running = false, close = true, sessions, active = true } = {}) {
  const patches = []
  const calls = { close: [], interrupt: [] }
  const panes = new Map([
    ['p1', { paneId: 'p1', sessionId: 's1', view: 'chat' }],
    ['p2', { paneId: 'p2', sessionId: 's2', view: 'chat' }],
  ])
  const flow = createCloseFlow({
    sessions: sessions ?? {
      scope: (sessionId) => ({
        get: () => ({
          cancel() {
            calls.interrupt.push(sessionId)
            return Promise.resolve({ ok: true })
          },
        }),
      }),
    },
    getSnapshot: () => ({ active }),
    publish: (patch) => patches.push(patch ?? {}),
    isDisposed: () => false,
    locatePane: (paneId) => (panes.has(paneId) ? { workspaceId: 'w1', pane: panes.get(paneId) } : null),
    locateSession: (sessionId) => {
      for (const pane of panes.values()) {
        if (pane.sessionId === sessionId) return { paneId: pane.paneId }
      }
      return null
    },
    rowOf: (sessionId) => (sessionId === 's1' ? { id: 's1', title: 'One' } : undefined),
    isSessionRunning: () => running,
    closePane: (paneId) => {
      calls.close.push(paneId)
      return close
    },
  })
  return { flow, patches, calls }
}

test('an idle pane closes immediately and leaves nothing staged', () => {
  const { flow, calls } = withFlow({ running: false })

  assert.equal(flow.request('p1'), true)
  assert.deepEqual(calls.close, ['p1'])
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
  flow.dispose()
})

test('a running pane is only staged, with the title the dialog shows', () => {
  const { flow, patches } = withFlow({ running: true })

  assert.equal(flow.request('p1'), false)
  assert.deepEqual(flow.snapshotPatch(), {
    pendingClose: { paneId: 'p1', sessionId: 's1', title: 'One' },
    closeBusy: false,
    closeError: null,
  })
  assert.equal(patches.length, 1)
  // Nothing was interrupted or closed by the request itself.
  flow.dispose()
})

test('a session with no catalog title is staged without one', () => {
  const { flow } = withFlow({ running: true })
  flow.request('p2')

  assert.deepEqual(flow.snapshotPatch().pendingClose, { paneId: 'p2', sessionId: 's2' })
  flow.dispose()
})

test('an unknown pane is refused instead of staging a close', () => {
  const { flow, patches } = withFlow({ running: true })

  assert.equal(flow.request('nope'), false)
  assert.equal(patches.length, 0)
  flow.dispose()
})

test('bySession finds the pane that holds the conversation', () => {
  const { flow, calls } = withFlow({ running: false })

  assert.equal(flow.bySession('s2'), true)
  assert.deepEqual(calls.close, ['p2'])
  assert.equal(flow.bySession('gone'), false)
  flow.dispose()
})

test('confirm interrupts first, then closes the staged pane', async () => {
  const { flow, calls } = withFlow({ running: true })
  flow.request('p1')

  assert.equal(await flow.confirm(), true)
  assert.deepEqual(calls.interrupt, ['s1'])
  assert.deepEqual(calls.close, ['p1'])
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
  flow.dispose()
})

test('a failed interrupt keeps the pane mounted and reports the reason', async () => {
  const { flow, calls } = withFlow({
    running: true,
    sessions: {
      scope: () => ({
        get: () => ({
          cancel: () => Promise.reject(new Error('no turn to cancel')),
        }),
      }),
    },
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), false)
  assert.deepEqual(calls.close, [])
  assert.match(flow.snapshotPatch().closeError, /no turn to cancel/)
  // The dialog stays open with the same pane, so the user can retry or cancel.
  assert.equal(flow.snapshotPatch().pendingClose?.paneId, 'p1')
  flow.dispose()
})

test('a pane that went inactive during the interrupt is not closed from a hidden panel', async () => {
  // `active` is read from the kernel, which flips it when split mode is hidden.
  const live = { active: true }
  const patches = []
  const closed = []
  const flow = createCloseFlow({
    sessions: {
      scope: () => ({
        get: () => ({
          cancel: () => {
            live.active = false
            return Promise.resolve({ ok: true })
          },
        }),
      }),
    },
    getSnapshot: () => ({ active: live.active }),
    publish: (patch) => patches.push(patch ?? {}),
    isDisposed: () => false,
    locatePane: () => ({ workspaceId: 'w1', pane: { paneId: 'p1', sessionId: 's1' } }),
    locateSession: () => ({ paneId: 'p1' }),
    rowOf: () => undefined,
    isSessionRunning: () => true,
    closePane: (paneId) => {
      closed.push(paneId)
      return true
    },
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), false)
  assert.deepEqual(closed, [])
  assert.equal(flow.snapshotPatch().closeBusy, false)
  flow.dispose()
})

test('cancel dismisses the dialog but refuses while the interrupt is in flight', async () => {
  const { flow } = withFlow({
    running: true,
    sessions: {
      scope: () => ({
        get: () => ({
          cancel: () => new Promise(() => {}),
        }),
      }),
    },
  })
  flow.request('p1')
  assert.equal(flow.cancel(), true)
  assert.equal(flow.snapshotPatch().pendingClose, null)

  flow.request('p1')
  void flow.confirm()
  assert.equal(flow.snapshotPatch().closeBusy, true)
  assert.equal(flow.cancel(), false)
  flow.dispose()
})

test('a cleared or disposed flow publishes nothing more', () => {
  const { flow, patches } = withFlow({ running: true })
  flow.request('p1')
  const staged = patches.length

  flow.clear()
  flow.clear()
  assert.equal(patches.length, staged + 1)
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })

  flow.dispose()
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
})

test('a structural close that fails leaves the staged close alone', () => {
  const { flow } = withFlow({ running: false, close: false })

  assert.equal(flow.request('p1'), false)
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
  flow.dispose()
})