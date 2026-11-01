'use strict'

/**
 * Closing a pane: the interrupt route and the staged-confirmation flow.
 *
 * Extracted from `dsh-pane-host.js` (which keeps the composition) so the
 * "closing a pane stops the session" behaviour is one reviewable unit. dsh
 * assumptions and their verification live in
 * `doc/upstream-contracts.md#interrupting-a-running-turn`.
 *
 * `interruptSession` uses the public route the shell's own stop button uses.
 * Releasing a Session reference is *not* a substitute: it only tears down the
 * client generation and never stops the Host Agent.
 */

const { messageOf } = require('./shared.js')

/**
 * Interrupt the running turn of one session through the public client route the
 * shell's own stop button uses.
 *
 * @param {any} sessions the `ctx.sessions` face
 * @param {string} sessionId
 * @returns {Promise<void>} rejects when no public route exists or the Host
 *   refuses to cancel the turn
 */
async function interruptSession(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('interruptSession: a session id is required')
  }
  if (typeof sessions?.scope === 'function') {
    const scoped = sessions.scope(sessionId)
    const conversation = scoped?.get?.('conversation')
    if (conversation !== undefined && typeof conversation.cancel === 'function') {
      await conversation.cancel()
      return
    }
  }
  if (typeof sessions?.binding === 'function') {
    const session = sessions.binding(sessionId)?.session
    if (session !== undefined && typeof session.cancel === 'function') {
      const result = await session.cancel()
      if (result !== null && result !== undefined && result.ok === false) {
        const error = result.error ?? {}
        throw new Error(
          `session.cancel failed: ${error.code ?? 'unknown'}: ${error.message ?? 'unknown error'}`,
        )
      }
      return
    }
  }
  throw new Error(`no public interrupt route for session "${sessionId}"`)
}

/**
 * The staged close flow, as one holder with its own face (ADR-0017).
 *
 * An idle session closes immediately. A running one is only staged in
 * `pendingClose`: the user must confirm, because closing the pane interrupts
 * the turn (spec D4). A failed interrupt keeps the pane mounted and the dialog
 * open with `closeError`, so nothing is half-closed.
 *
 * This holder owns the three snapshot fields of the confirmation and reports
 * them through `snapshotPatch()`. The kernel merges that into every publish
 * *after* the caller's patch, so no other module can claim a close state this
 * flow does not hold — which is why `write()` and not `publish()` is the only
 * way those fields move.
 *
 * @param {object} deps
 * @param {any} deps.sessions the `ctx.sessions` face
 * @param {() => any} deps.getSnapshot current kernel snapshot, read for `active`
 * @param {(patch?: object) => void} deps.publish kernel state emitter
 * @param {() => boolean} deps.isDisposed
 * @param {(paneId: string) => {workspaceId: string|null, pane: object}|null} deps.locatePane
 * @param {(sessionId: string) => {paneId: string}|null} deps.locateSession
 * @param {(sessionId: string) => any} deps.rowOf the session's catalog row
 * @param {(sessionId: string) => boolean} deps.isSessionRunning
 * @param {(paneId: string) => boolean} deps.closePane structural close
 */
function createCloseFlow(deps) {
  const {
    sessions,
    getSnapshot,
    publish,
    isDisposed,
    locatePane,
    locateSession,
    rowOf,
    isSessionRunning,
    closePane,
  } = deps

  /** @type {{paneId: string, sessionId: string, title?: string}|null} */
  let pendingClose = null
  let closeBusy = false
  /** @type {string|null} */
  let closeError = null

  /**
   * Move the fields this flow owns. Publishes only when one of them changed,
   * mirroring the kernel's own identity-based change detection.
   *
   * @param {{pendingClose?: any, closeBusy?: boolean, closeError?: string|null}} patch
   */
  function write(patch) {
    const nextPending = 'pendingClose' in patch ? patch.pendingClose : pendingClose
    const nextBusy = 'closeBusy' in patch ? patch.closeBusy : closeBusy
    const nextError = 'closeError' in patch ? patch.closeError : closeError
    if (nextPending === pendingClose && nextBusy === closeBusy && nextError === closeError) return
    pendingClose = nextPending
    closeBusy = nextBusy
    closeError = nextError
    if (typeof publish === 'function') publish({})
  }

  /** Drop a pending close (and its error); no layout or session change. */
  function clear() {
    write({ pendingClose: null, closeBusy: false, closeError: null })
  }

  /**
   * Ask to close one pane. An idle session closes immediately. A running one is
   * only staged in `pendingClose`: the user must confirm, because closing the
   * pane interrupts the turn (spec D4).
   *
   * @param {string} paneId
   * @returns {boolean} whether the pane closed immediately
   */
  function request(paneId) {
    if (isDisposed()) return false
    const located = locatePane(paneId)
    if (located === null) return false
    const pane = located.pane
    if (!isSessionRunning(pane.sessionId)) {
      const closed = closePane(paneId)
      if (closed) clear()
      return closed
    }
    const title = rowOf(pane.sessionId)?.title
    write({
      pendingClose: {
        paneId,
        sessionId: pane.sessionId,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
      },
      closeBusy: false,
      closeError: null,
    })
    return false
  }

  /**
   * The pane holding one session, closed through the same staged flow. False
   * when no pane holds it.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  function bySession(sessionId) {
    const holder = typeof locateSession === 'function' ? locateSession(sessionId) : null
    return holder === null || holder === undefined ? false : request(holder.paneId)
  }

  /**
   * Confirm the staged close: interrupt the running turn first, then release the
   * pane. A failed interrupt keeps the pane mounted and leaves the dialog open
   * with `closeError`, so nothing is half-closed and the user can retry or
   * cancel.
   *
   * @returns {Promise<boolean>} whether the pane was closed
   */
  async function confirm() {
    if (isDisposed()) return false
    if (pendingClose === null || closeBusy) return false
    const pending = pendingClose
    write({ closeBusy: true, closeError: null })
    try {
      await interruptSession(sessions, pending.sessionId)
    } catch (error) {
      if (isDisposed()) return false
      write({ closeBusy: false, closeError: messageOf(error) })
      return false
    }
    if (isDisposed()) return false
    // The panel may have been hidden (or another close requested) while the
    // interrupt was in flight; in that case the pane already lost its refs and
    // must not be structurally re-reconciled from an inactive panel.
    if (!getSnapshot().active || pendingClose?.paneId !== pending.paneId) {
      write({ closeBusy: false })
      return false
    }
    const closed = closePane(pending.paneId)
    write({ pendingClose: null, closeBusy: false, closeError: null })
    return closed
  }

  /** Dismiss the staged close without changing the session or the layout. */
  function cancel() {
    if (isDisposed() || pendingClose === null || closeBusy) return false
    write({ pendingClose: null, closeError: null })
    return true
  }

  return {
    snapshotPatch() {
      return { pendingClose, closeBusy, closeError }
    },
    request,
    bySession,
    confirm,
    cancel,
    /** Drop a staged confirmation from the outside (workspace forgotten, teardown). */
    clear,
    dispose() {
      pendingClose = null
      closeBusy = false
      closeError = null
    },
  }
}

module.exports = { interruptSession, createCloseFlow }