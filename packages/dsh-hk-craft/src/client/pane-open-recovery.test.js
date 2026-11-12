'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LOADING,
  DEFAULT_POLICY,
  openStateOf,
  openPending,
  decideOpenRecovery,
} = require('./pane-open-recovery.js')

/** A Session-shaped object with only the fields the policy reads. */
function session(openState, openPromise = null) {
  return { openState, openPromise }
}

/** Run `count` decisions `stallMs` apart, feeding each entry into the next. */
function steps(startSession, count, { policy = DEFAULT_POLICY, firstNow = 0 } = {}) {
  const actions = []
  let entry
  let now = firstNow
  for (let index = 0; index < count; index += 1) {
    const result = decideOpenRecovery(entry, startSession, now, policy)
    actions.push(result.action)
    entry = result.entry ?? undefined
    now += policy.stallMs
  }
  return { actions, entry }
}

test('a Session that is not loading is never watched', () => {
  for (const state of ['cold', 'open', 'error', undefined, null, 42]) {
    assert.deepEqual(decideOpenRecovery(undefined, { openState: state }, 0), {
      action: 'idle',
      entry: null,
    })
  }
  assert.deepEqual(decideOpenRecovery(undefined, undefined, 0), { action: 'idle', entry: null })
})

test('a loading Session is first watched, then left alone inside the stall window', () => {
  const first = decideOpenRecovery(undefined, session(LOADING), 1000)
  assert.equal(first.action, 'wait')
  assert.deepEqual(first.entry, { since: 1000, openRetries: 0, resyncs: 0, givenUp: false })

  const early = decideOpenRecovery(first.entry, session(LOADING), 1000 + DEFAULT_POLICY.stallMs - 1)
  assert.equal(early.action, 'wait')
  assert.equal(early.entry.since, 1000, 'the stall window is not restarted by an early probe')
})

test('an open that already failed is retried through a fresh retain, then given up', () => {
  // `openPromise` is null once `doOpen` rejected, which is the permanent
  // "载入历史…" state: the shell never calls `open()` again on its own.
  const { actions, entry } = steps(session(LOADING), DEFAULT_POLICY.maxOpenRetries + 2)
  assert.deepEqual(actions, [
    'wait',
    ...Array.from({ length: DEFAULT_POLICY.maxOpenRetries }, () => 'retry-open'),
    'give-up',
  ])
  assert.equal(entry.givenUp, true, 'a given-up entry stops spending the budget')
  // It stays watched, so a late recovery is noticed, but nothing acts again.
  assert.deepEqual(decideOpenRecovery(entry, session(LOADING), 10 ** 6), {
    action: 'wait',
    entry,
  })
})

test('retries are spaced by the stall window instead of firing on every probe', () => {
  let entry = decideOpenRecovery(undefined, session(LOADING), 0).entry
  const retries = []
  for (let now = 0; now <= DEFAULT_POLICY.stallMs * 4; now += 100) {
    const result = decideOpenRecovery(entry, session(LOADING), now)
    entry = result.entry ?? undefined
    if (result.action === 'retry-open') retries.push(now)
  }
  assert.deepEqual(retries, [DEFAULT_POLICY.stallMs, DEFAULT_POLICY.stallMs * 2, DEFAULT_POLICY.stallMs * 3, DEFAULT_POLICY.stallMs * 4])
})

test('an open that is still in flight is rebuilt once, then given up', () => {
  // A hung `openPromise` cannot be retried by calling `open()` again (it
  // returns the same pending promise), so the policy escalates to `resync`.
  const pending = session(LOADING, Promise.resolve())
  const { actions } = steps(pending, DEFAULT_POLICY.maxResyncs + 2)
  assert.deepEqual(actions, ['wait', 'resync', 'give-up'])
})

test('a pending open is never handed to a plain retry', () => {
  const { actions } = steps(session(LOADING, Promise.resolve()), 1)
  assert.deepEqual(actions, ['wait'])
})

test('a Session that leaves loading drops out of the watch', () => {
  const entry = decideOpenRecovery(undefined, session(LOADING), 0).entry
  assert.deepEqual(decideOpenRecovery(entry, session('open'), 5000), { action: 'idle', entry: null })
  // Leaving and re-entering loading starts a fresh budget, so a later hiccup is
  // not punished for an earlier one.
  const reopened = decideOpenRecovery(undefined, session(LOADING), 6000)
  assert.deepEqual(reopened.entry, { since: 6000, openRetries: 0, resyncs: 0, givenUp: false })
})

test('the policy budgets are injectable', () => {
  const policy = { stallMs: 10, maxOpenRetries: 1, maxResyncs: 0 }
  const { actions } = steps(session(LOADING), 3, { policy })
  assert.deepEqual(actions, ['wait', 'retry-open', 'give-up'])
  const pendingSteps = steps(session(LOADING, Promise.resolve()), 2, { policy })
  assert.deepEqual(pendingSteps.actions, ['wait', 'give-up'], 'no resync budget means no rebuild')
})

test('openStateOf and openPending ignore malformed sessions', () => {
  assert.equal(openStateOf(undefined), undefined)
  assert.equal(openStateOf(null), undefined)
  assert.equal(openStateOf('loading'), undefined)
  assert.equal(openStateOf({ openState: 1 }), undefined)
  assert.equal(openPending(undefined), false)
  assert.equal(openPending({ openPromise: null }), false)
  assert.equal(openPending({ openPromise: Promise.resolve() }), true)
})
