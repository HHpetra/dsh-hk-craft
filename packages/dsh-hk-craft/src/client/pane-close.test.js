'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloseFlow } = require('./pane-close.js')

/**
 * A session face whose binding reports what the test wants.
 *
 * `outcome` is the `session.cancel()` answer: `{ ok: true }`, `{ ok: false, error }`,
 * a promise, or a function returning one.
 */
function sessionsWith({ outcome = { ok: true }, failWith = null } = {}) {
  const calls = []
  const answer = () => {
    if (failWith !== null) return Promise.reject(failWith)
    return Promise.resolve(typeof outcome === 'function' ? outcome() : outcome)
  }
  return {
    calls,
    binding(sessionId) {
      calls.push(['binding', sessionId])
      return {
        session: {
          cancel() {
            calls.push(['cancel', sessionId])
            return answer()
          },
        },
      }
    },
    scope() {
      throw new Error('the binding route must be preferred when it exists')
    },
  }
}

/**
 * The close holder with every callback it takes, so each test only states the
 * part it is about.
 */
function withFlow({ running = false, close = true, sessions, interruptTimeoutMs } = {}) {
  const patches = []
  const calls = { close: [], interrupt: [] }
  const panes = new Map([
    ['p1', { paneId: 'p1', sessionId: 's1', view: 'chat' }],
    ['p2', { paneId: 'p2', sessionId: 's2', view: 'chat' }],
  ])
  const face = sessions ?? sessionsWith()
  // Keep the routes a test cares about visible without restating every method.
  const sessionFace = {
    binding: face.binding,
    scope:
      face.scope ??
      ((sessionId) => ({
        get: () => ({
          cancel() {
            calls.interrupt.push(sessionId)
            return Promise.resolve({ ok: true })
          },
        }),
      })),
  }
  const flow = createCloseFlow({
    sessions: sessionFace,
    getSnapshot: () => ({ active: true }),
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
    ...(interruptTimeoutMs === undefined ? {} : { interruptTimeoutMs }),
  })
  return { flow, patches, calls, face }
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

test('confirm stops the turn through the session binding, then closes the pane', async () => {
  const { flow, calls, face } = withFlow({ running: true })
  flow.request('p1')

  assert.equal(await flow.confirm(), true)
  assert.deepEqual(face.calls, [
    ['binding', 's1'],
    ['cancel', 's1'],
  ])
  assert.deepEqual(calls.close, ['p1'])
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
  flow.dispose()
})

test('without a binding the scoped conversation face is the interrupt route', async () => {
  const interrupted = []
  const { flow, calls } = withFlow({
    running: true,
    sessions: {
      scope: (sessionId) => ({
        get: () => ({
          cancel() {
            interrupted.push(sessionId)
            return Promise.resolve({ ok: true })
          },
        }),
      }),
    },
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), true)
  assert.deepEqual(interrupted, ['s1'])
  assert.deepEqual(calls.close, ['p1'])
  flow.dispose()
})

test('a Host that reports no attached session closes the pane instead of trapping it', async () => {
  // The client can hold a stale `running` bit; the Host answers that no Agent is
  // attached, so there is no turn left to stop.
  const { flow, calls } = withFlow({
    running: true,
    sessions: sessionsWith({
      outcome: { ok: false, error: { code: 'session/not-found', message: 'session "s1" not found (not attached)' } },
    }),
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), true)
  assert.deepEqual(calls.close, ['p1'])
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
  flow.dispose()
})

test('a refused interrupt keeps the pane and reports the reason', async () => {
  const { flow, calls } = withFlow({
    running: true,
    sessions: sessionsWith({
      outcome: { ok: false, error: { code: 'session/agent-busy', message: 'owned by subagent routing' } },
    }),
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), false)
  assert.deepEqual(calls.close, [])
  assert.match(flow.snapshotPatch().closeError, /owned by subagent routing/)
  // The dialog stays open with the same pane, so the user can retry, cancel, or
  // close without stopping the turn.
  assert.equal(flow.snapshotPatch().pendingClose?.paneId, 'p1')
  assert.equal(flow.snapshotPatch().closeBusy, false)
  flow.dispose()
})

test('force closes the staged pane without stopping its turn', async () => {
  const { flow, calls } = withFlow({
    running: true,
    sessions: sessionsWith({
      outcome: { ok: false, error: { code: 'session/agent-busy', message: 'owned by subagent routing' } },
    }),
  })
  flow.request('p1')
  await flow.confirm()

  assert.equal(flow.force(), true)
  assert.deepEqual(calls.close, ['p1'])
  assert.deepEqual(flow.snapshotPatch(), { pendingClose: null, closeBusy: false, closeError: null })
  flow.dispose()
})

test('force is refused before anything is staged', () => {
  const { flow, calls } = withFlow({ running: true })

  assert.equal(flow.force(), false)
  assert.deepEqual(calls.close, [])
  flow.dispose()
})

test('a Host that never answers hands control back instead of staying busy', async () => {
  const { flow } = withFlow({
    running: true,
    interruptTimeoutMs: 20,
    sessions: sessionsWith({ outcome: () => new Promise(() => {}) }),
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), false)
  assert.equal(flow.snapshotPatch().closeBusy, false)
  assert.match(flow.snapshotPatch().closeError, /did not answer/)
  assert.equal(flow.snapshotPatch().pendingClose?.paneId, 'p1')
  flow.dispose()
})

test('a transport failure rejects into a reported close error, not a rejection', async () => {
  const { flow, calls } = withFlow({
    running: true,
    sessions: sessionsWith({ failWith: new Error('gateway/closed: socket closed') }),
  })
  flow.request('p1')

  assert.equal(await flow.confirm(), false)
  assert.match(flow.snapshotPatch().closeError, /socket closed/)
  assert.deepEqual(calls.close, [])
  flow.dispose()
})

test('a pane that went inactive during the interrupt is not closed from a hidden panel', async () => {
  // `active` is read from the kernel, which flips it when split mode is hidden.
  const live = { active: true }
  const patches = []
  const closed = []
  const flow = createCloseFlow({
    sessions: {
      binding: () => ({
        session: {
          cancel: () => {
            live.active = false
            return Promise.resolve({ ok: true })
          },
        },
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

test('cancel dismisses the dialog while the interrupt is in flight, and the late answer closes nothing', async () => {
  let finish = () => {}
  const { flow, calls } = withFlow({
    running: true,
    sessions: sessionsWith({
      outcome: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true })
        }),
    }),
  })
  flow.request('p1')
  const pending = flow.confirm()
  assert.equal(flow.snapshotPatch().closeBusy, true)

  assert.equal(flow.cancel(), true)
  assert.equal(flow.snapshotPatch().pendingClose, null)
  assert.equal(flow.snapshotPatch().closeBusy, false)

  finish()
  assert.equal(await pending, false)
  assert.deepEqual(calls.close, [])
  flow.dispose()
})

test('an interrupt that lands after the dialog was dismissed closes nothing', async () => {
  let finish = () => {}
  const { flow, calls } = withFlow({
    running: true,
    sessions: sessionsWith({
      outcome: () => new Promise((resolve) => {
        finish = () => resolve({ ok: true })
      }),
    }),
  })
  flow.request('p1')
  const pending = flow.confirm()
  // A workspace switch (or teardown) drops the staged close while the Host is
  // still answering; the reply must not reconcile an inactive/other pane.
  flow.clear()
  finish()

  assert.equal(await pending, false)
  assert.deepEqual(calls.close, [])
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
