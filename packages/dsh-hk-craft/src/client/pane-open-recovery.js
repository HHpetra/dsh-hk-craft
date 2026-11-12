'use strict'

/**
 * Recovery policy for a pane whose Session never finished opening its history.
 *
 * Upstream (`@deepseek-ai/dsh-api-session-controller` 0.2.2-rc.1,
 * `Session.doOpen`) publishes `openState: "loading"` before it opens the
 * session's event stream and only leaves that state on two paths: a successful
 * open (`"open"`) or a *Remote* failure (`"error"`). Every other failure — a
 * carrier loss, a socket that closes before it opens, a replaced connection
 * generation — is rethrown, and the `finally` block only notifies. The
 * Session then sits in `"loading"` for the rest of the client generation: the
 * Chat view keeps rendering its `chat.loadingHistory` hint ("载入历史…") and
 * nothing retries, because `open()` is only called by a new `retain()`.
 *
 * Native dsh opens one Session's history (the current one), so a boot-time
 * carrier hiccup costs it a reload. This plugin keeps every pane of every
 * loaded workspace retained and opens them all at once on a restart, which
 * makes that hole reachable in ordinary use: the default workspace's pane is
 * the first thing opened, at the busiest moment of the start.
 *
 * This module owns only the decision — what to do, and when — so the kernel
 * (`dsh-pane-host.js`) can stay a transaction and the policy stays testable in
 * Node without a dsh runtime. A `retry-open` is a fresh `sessions.retain()`,
 * which calls the Session's own `open()` again (`openPromise` is cleared after
 * a rejection); a `resync` is the Session's own rebuild, for an open that is
 * still in flight and may never answer.
 *
 * See `docs/upstream-contracts.md#session-history-open-openstate` and
 * [ADR-0022](../../../../docs/adr/0022-recover-a-stuck-history-open.md).
 */

/**
 * The one state that means "the shell is still opening this history". A
 * missing or non-string `openState` (an older shell, a fake in a test) is not
 * this state: the watch then has nothing to heal.
 */
const LOADING = 'loading'

/** Defaults, also the budgets a caller may narrow through `policy`. */
const DEFAULT_POLICY = Object.freeze({
  /** How long a Session may keep reporting `loading` before the watch acts. */
  stallMs: 1200,
  /** Retries of `Session.open()` through a fresh retain, per session. */
  maxOpenRetries: 6,
  /** Retries of `Session.resync()` for an open that is still in flight. */
  maxResyncs: 1,
})

/**
 * The Session's own open state, or undefined when this shell does not publish
 * one.
 *
 * @param {any} session `reference.binding.session`
 * @returns {string|undefined}
 */
function openStateOf(session) {
  if (session === null || typeof session !== 'object') return undefined
  const state = session.openState
  return typeof state === 'string' ? state : undefined
}

/**
 * Whether the Session's open is still pending (as opposed to already failed).
 *
 * `openPromise` is a Session field on the pinned train: `null` between attempts
 * and after a failure, the in-flight promise while `doOpen` is waiting. A shell
 * that does not publish it reads as "not pending", which retries `open()`
 * instead of rebuilding the stream — the cheaper of the two actions.
 *
 * @param {any} session
 * @returns {boolean}
 */
function openPending(session) {
  if (session === null || typeof session !== 'object') return false
  const pending = session.openPromise
  return pending !== null && pending !== undefined
}

/**
 * A fresh watch entry for one Session.
 *
 * @param {number} now
 * @returns {{since: number, openRetries: number, resyncs: number, givenUp: boolean}}
 */
function startEntry(now) {
  return { since: now, openRetries: 0, resyncs: 0, givenUp: false }
}

/**
 * Decide the next recovery step for one watched Session.
 *
 * The entry is the watch's only memory: it carries when the current stall
 * window started, how much of each budget was spent, and whether the watch gave
 * up (a given-up entry stays put so the same failure is not retried forever; it
 * is dropped as soon as the Session leaves `loading`).
 *
 * @param {{since: number, openRetries: number, resyncs: number, givenUp: boolean}|undefined| null} entry
 * @param {any} session `reference.binding.session`
 * @param {number} now epoch milliseconds
 * @param {typeof DEFAULT_POLICY} [policy]
 * @returns {{action: 'idle'|'wait'|'retry-open'|'resync'|'give-up', entry: ReturnType<typeof startEntry>|null}}
 *   `idle` is the only action that drops the watch (the Session left
 *   `loading`); every other action carries the entry the caller stores. A
 *   given-up entry keeps reporting `wait`: it is still watched, so a recovery
 *   is noticed, but no budget is spent again.
 */
function decideOpenRecovery(entry, session, now, policy = DEFAULT_POLICY) {
  if (openStateOf(session) !== LOADING) return { action: 'idle', entry: null }
  if (entry === undefined || entry === null) return { action: 'wait', entry: startEntry(now) }
  if (entry.givenUp === true) return { action: 'wait', entry }
  if (!(now - entry.since >= policy.stallMs)) return { action: 'wait', entry }

  if (openPending(session)) {
    if (entry.resyncs < policy.maxResyncs) {
      return {
        action: 'resync',
        entry: {
          since: now,
          openRetries: entry.openRetries,
          resyncs: entry.resyncs + 1,
          givenUp: false,
        },
      }
    }
    return { action: 'give-up', entry: { ...entry, since: now, givenUp: true } }
  }

  if (entry.openRetries < policy.maxOpenRetries) {
    return {
      action: 'retry-open',
      entry: {
        since: now,
        openRetries: entry.openRetries + 1,
        resyncs: entry.resyncs,
        givenUp: false,
      },
    }
  }
  return { action: 'give-up', entry: { ...entry, since: now, givenUp: true } }
}

module.exports = {
  LOADING,
  DEFAULT_POLICY,
  openStateOf,
  openPending,
  decideOpenRecovery,
}
