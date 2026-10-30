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
 * The staged close flow.
 *
 * An idle session closes immediately. A running one is only staged in
 * `pendingClose`: the user must confirm, because closing the pane interrupts
 * the turn (spec D4). A failed interrupt keeps the pane mounted and the dialog
 * open with `closeError`, so nothing is half-closed.
 *
 * @param {object} deps
 * @param {any} deps.sessions the `ctx.sessions` face
 * @param {() => any} deps.getSnapshot current controller snapshot
 * @param {(patch: object) => void} deps.emit state emitter
 * @param {() => boolean} deps.isDisposed
 * @param {(paneId: string) => {workspaceId: string|null, pane: object}|null} deps.locatePane
 * @param {(sessionId: string) => any} deps.rowOf session list row
 * @param {(sessionId: string) => boolean} deps.isSessionRunning
 * @param {(paneId: string) => boolean} deps.closePane structural close
 * @returns {{clearPendingClose: () => void, requestClose: (paneId: string) => boolean, confirmClose: () => Promise<boolean>, cancelClose: () => boolean}}
 */
function createCloseFlow(deps) {
  const { sessions, getSnapshot, emit, isDisposed, locatePane, rowOf, isSessionRunning, closePane } = deps

  /** Drop a pending close (and its error); no layout or session change. */
  function clearPendingClose() {
    const snapshot = getSnapshot()
    if (
      snapshot.pendingClose === null &&
      snapshot.closeError === null &&
      snapshot.closeBusy === false
    ) {
      return
    }
    emit({ pendingClose: null, closeBusy: false, closeError: null })
  }

  /**
   * Ask to close one pane. An idle session closes immediately. A running one is
   * only staged in `pendingClose`: the user must confirm, because closing the
   * pane interrupts the turn (spec D4).
   *
   * @param {string} paneId
   * @returns {boolean} whether the pane closed immediately
   */
  function requestClose(paneId) {
    if (isDisposed()) return false
    const located = locatePane(paneId)
    if (located === null) return false
    const pane = located.pane
    if (!isSessionRunning(pane.sessionId)) {
      const closed = closePane(paneId)
      if (closed) clearPendingClose()
      return closed
    }
    const title = rowOf(pane.sessionId)?.title
    emit({
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
   * Confirm the staged close: interrupt the running turn first, then release the
   * pane. A failed interrupt keeps the pane mounted and leaves the dialog open
   * with `closeError`, so nothing is half-closed and the user can retry or
   * cancel.
   *
   * @returns {Promise<boolean>} whether the pane was closed
   */
  async function confirmClose() {
    if (isDisposed()) return false
    const pending = getSnapshot().pendingClose
    if (pending === null || getSnapshot().closeBusy) return false
    emit({ closeBusy: true, closeError: null })
    try {
      await interruptSession(sessions, pending.sessionId)
    } catch (error) {
      if (isDisposed()) return false
      emit({ closeBusy: false, closeError: messageOf(error) })
      return false
    }
    if (isDisposed()) return false
    // The panel may have been hidden (or another close requested) while the
    // interrupt was in flight; in that case the pane already lost its refs and
    // must not be structurally re-reconciled from an inactive panel.
    const snapshot = getSnapshot()
    if (!snapshot.active || snapshot.pendingClose?.paneId !== pending.paneId) {
      emit({ closeBusy: false })
      return false
    }
    const closed = closePane(pending.paneId)
    emit({ pendingClose: null, closeBusy: false, closeError: null })
    return closed
  }

  /** Dismiss the staged close without changing the session or the layout. */
  function cancelClose() {
    const snapshot = getSnapshot()
    if (isDisposed() || snapshot.pendingClose === null || snapshot.closeBusy) return false
    emit({ pendingClose: null, closeError: null })
    return true
  }

  return { clearPendingClose, requestClose, confirmClose, cancelClose }
}

module.exports = { interruptSession, createCloseFlow }
