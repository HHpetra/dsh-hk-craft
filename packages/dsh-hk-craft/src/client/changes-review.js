'use strict'

/**
 * Open a turn's changes review on the pane that showed the card.
 *
 * Upstream (`@deepseek-ai/dsh-client-ui-deliverables` 0.2.1-rc.5) renders
 * "这轮改动的内容已不可用" only when the summary read is `missing`. The card
 * loads `/api/changes.summary` for its own session and lists files only when
 * that read succeeds. The review tab then loads the same route with the
 * right bar's on-screen session and only the `seq` from
 * `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>`.
 * `openResource` places the tab in `sidebarRight.mounted`, which follows
 * `uiSession.current`. That current sticks to `ui-workspace`'s `mainView`,
 * so in split view it can name a session other than the pane. The host has
 * no summary for the pane's `seq` under that other session, and the tab
 * shows the missing copy. Revealing the address's session first makes the
 * tab's read the one the card already displayed.
 *
 * The seat adopts a session's store when it renders, which is after
 * `openSession` returns. Until `mounted` is that session, the open waits.
 */

/** Resource-address prefix of one turn's review tab. Same string the card builds. */
const CHANGES_REVIEW_ADDRESS = 'dsh-resource://changes-review/session/'

/** How many turns to wait for the revealed session's right-bar surface. */
const MAX_ATTEMPTS = 8

/**
 * The pane session a changes-review address names, or null for any other address.
 *
 * The parse matches the upstream `parseChangesReviewAddress`: three segments,
 * a numeric event sequence, and a turn of at least 1. A bad address must not
 * be treated as a session id.
 *
 * @param {string} address
 * @returns {string|null}
 */
function changesReviewSessionId(address) {
  if (typeof address !== 'string' || !address.startsWith(CHANGES_REVIEW_ADDRESS)) return null
  const parts = address.slice(CHANGES_REVIEW_ADDRESS.length).split('/')
  if (parts.length !== 3) return null
  const [sessionId, seq, turn] = parts
  if (sessionId === '' || !/^\d+$/.test(seq) || !/^[1-9]\d*$/.test(turn)) return null
  try {
    const decoded = decodeURIComponent(sessionId)
    return decoded === '' ? null : decoded
  } catch {
    return null
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNoSurface(error) {
  return error instanceof Error && error.message.includes('no session surface is mounted')
}

/**
 * @param {any} sidebarRight
 * @returns {string|null}
 */
function mountedSessionId(sidebarRight) {
  try {
    const value = sidebarRight?.mounted?.getSnapshot?.()
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

/**
 * Wrap `sidebarRight.openResource` so a changes-review open acts on the
 * session in the address while split view is active.
 *
 * Other resources, and review opens outside split view, call the original
 * method with the session the bar already has. When the bar already shows
 * the address's session, the original method runs immediately too: that is
 * the native review path.
 *
 * @param {any} sidebarRight
 * @param {{ openSession?: (sessionId: string) => void, enabled?: () => boolean, schedule?: (fn: () => void) => (() => void)|void }} deps
 * @returns {() => void} restore the original method and drop a pending wait
 */
function installChangesReviewRoute(sidebarRight, deps = {}) {
  if (sidebarRight == null || typeof sidebarRight.openResource !== 'function') return () => {}
  if (sidebarRight.openResource.hkcraftChangesReview === true) return () => {}
  const original = sidebarRight.openResource.bind(sidebarRight)
  const openSession = deps.openSession
  const enabled = typeof deps.enabled === 'function' ? deps.enabled : () => false
  const schedule =
    typeof deps.schedule === 'function'
      ? deps.schedule
      : (fn) => {
          const timer = setTimeout(fn, 0)
          return () => clearTimeout(timer)
        }
  let disposed = false
  /** @type {Array<() => void>} */
  const pending = []

  /**
   * @param {string} address
   * @param {object|undefined} options
   * @param {number} attempt
   */
  function open(address, options, attempt) {
    if (disposed) return undefined
    const wanted = changesReviewSessionId(address)
    const redirect = wanted !== null && enabled() === true
    if (redirect && mountedSessionId(sidebarRight) !== wanted && typeof openSession === 'function') {
      try {
        openSession(wanted)
      } catch (error) {
        console.error('[dsh-hk-craft] failed to show the review session in the right bar', error)
      }
    }
    const aligned = !redirect || mountedSessionId(sidebarRight) === wanted
    if (!aligned && attempt < MAX_ATTEMPTS) {
      const cancel = schedule(() => open(address, options, attempt + 1))
      if (typeof cancel === 'function') pending.push(cancel)
      return undefined
    }
    try {
      return original(address, options)
    } catch (error) {
      if (redirect && attempt < MAX_ATTEMPTS && isNoSurface(error)) {
        const cancel = schedule(() => open(address, options, attempt + 1))
        if (typeof cancel === 'function') pending.push(cancel)
        return undefined
      }
      throw error
    }
  }

  function wrapped(address, options) {
    return open(address, options, 0)
  }
  wrapped.hkcraftChangesReview = true
  sidebarRight.openResource = wrapped

  return () => {
    disposed = true
    for (const cancel of pending.splice(0)) {
      try {
        cancel()
      } catch {
        // The timer already fired, or the host has no timer to cancel.
      }
    }
    if (sidebarRight.openResource === wrapped) {
      sidebarRight.openResource = original
    }
  }
}

module.exports = {
  CHANGES_REVIEW_ADDRESS,
  changesReviewSessionId,
  installChangesReviewRoute,
}
