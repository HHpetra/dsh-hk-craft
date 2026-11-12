'use strict'

/**
 * Closing a pane: the interrupt route and the staged-confirmation flow.
 *
 * Extracted from `dsh-pane-host.js` (which keeps the composition) so the
 * "closing a pane stops the session" behaviour is one reviewable unit. dsh
 * assumptions and their verification live in
 * `docs/upstream-contracts.md#interrupting-a-running-turn`.
 *
 * Closing a pane is a client-side release: it never stops the Host Agent on its
 * own (`#retention-sources-and-the-single-mainview-derivation`). The interrupt is
 * therefore the *only* thing that ends the turn, and it is a request the Host can
 * refuse. A refused request must never become a trap: the confirmation is a
 * warning plus a best-effort stop, not a gate that keeps the overlay up forever
 * (ADR-0021).
 */

const { messageOf } = require('./shared.js')

/**
 * The Host codes that mean "there is no live turn left to stop".
 *
 * `session/not-found` is the Host's "session is not attached" answer: no Agent is
 * resident, so no turn can be running. The client can still have a stale
 * `running` bit (a status frame that outlived its turn), and treating that answer
 * as a hard failure left the pane unclosable behind a full-screen overlay. The
 * older `session/not-running` spelling is kept for shells that still answer with
 * it.
 */
const NOTHING_TO_INTERRUPT = Object.freeze(['session/not-running', 'session/not-found'])

/**
 * How long the confirmation waits for the Host's cancel answer before it reports
 * "no answer" and hand control back. Without a bound, a silent RPC leaves the
 * dialog busy forever and the modal overlay blocks every other pane.
 */
const INTERRUPT_TIMEOUT_MS = 5000

/**
 * The stable error code a Host refusal carries.
 *
 * The object-layer route reports `{ ok: false, error: { code, message } }`. The
 * public action face (`conversation.cancel`) throws an `Error` whose message
 * embeds the same code (`conversation.cancel failed: session/not-found: …`), so
 * the code is read back out of it instead of being dropped.
 *
 * @param {unknown} error
 * @returns {string|null}
 */
function codeOf(error) {
  const text = messageOf(error)
  const match = /(session\/[a-z][a-z-]*)/u.exec(text)
  return match === null ? null : match[1]
}

/**
 * One cancel result as a structured outcome.
 *
 * @param {any} result the `{ ok, value, error }` envelope `session.cancel()`
 *   resolves with; `null` / `undefined` means the route dispatched the request
 *   without reporting one
 * @returns {{ok: boolean, code: string|null, message: string|null}}
 */
function outcomeOf(result) {
  if (result === null || result === undefined || result.ok !== false) {
    return { ok: true, code: null, message: null }
  }
  const error = result.error ?? {}
  return {
    ok: false,
    code: typeof error.code === 'string' && error.code !== '' ? error.code : null,
    message:
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `session.cancel was refused (${error.code ?? 'unknown'})`,
  }
}

/**
 * Ask the Host to stop the running turn of one session.
 *
 * The object layer (`sessions.binding(id).session.cancel()`) is preferred: it
 * answers with `{ ok, error }` instead of throwing, so the caller can tell "there
 * is nothing to stop" from "the Host refused", and it already routes a subagent
 * child through `subagents.interruptByParent`. The public action face the shell's
 * own stop button uses (`sessions.scope(id).get('conversation').cancel()`) is the
 * fallback for a shell that exposes no binding. Releasing a Session reference is
 * still not a substitute: it only tears down the client generation.
 *
 * Never rejects: a missing route, a transport failure and a refusal are all
 * outcomes the close flow has to act on.
 *
 * @param {any} sessions the `ctx.sessions` face
 * @param {string} sessionId
 * @returns {Promise<{ok: boolean, code: string|null, message: string|null}>}
 */
async function interruptSession(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, code: null, message: 'interruptSession: a session id is required' }
  }
  if (typeof sessions?.binding === 'function') {
    let session
    try {
      session = sessions.binding(sessionId)?.session
    } catch (_error) {
      // A shell whose binding face is not readable is not a refusal: the scope
      // route below may still reach the same Session.
      session = undefined
    }
    if (session !== undefined && typeof session.cancel === 'function') {
      try {
        return outcomeOf(await session.cancel())
      } catch (error) {
        return { ok: false, code: codeOf(error), message: messageOf(error) }
      }
    }
  }
  if (typeof sessions?.scope === 'function') {
    let conversation
    try {
      conversation = sessions.scope(sessionId)?.get?.('conversation')
    } catch (_error) {
      conversation = undefined
    }
    if (conversation !== undefined && typeof conversation.cancel === 'function') {
      try {
        return outcomeOf(await conversation.cancel())
      } catch (error) {
        return { ok: false, code: codeOf(error), message: messageOf(error) }
      }
    }
  }
  return { ok: false, code: null, message: `no public interrupt route for session "${sessionId}"` }
}

/**
 * Whether a failure actually means "the turn is already gone".
 *
 * @param {{ok: boolean, code: string|null, message: string|null}} outcome
 * @returns {boolean}
 */
function nothingToInterrupt(outcome) {
  if (outcome === null || outcome === undefined || outcome.ok === true) return false
  if (typeof outcome.code === 'string' && NOTHING_TO_INTERRUPT.includes(outcome.code)) return true
  const message = typeof outcome.message === 'string' ? outcome.message : ''
  return /\bnot attached\b/iu.test(message)
}

/**
 * Bound one interrupt attempt. A Host that never answers must not leave the
 * confirmation busy forever (ADR-0021).
 *
 * @param {() => Promise<{ok: boolean, code: string|null, message: string|null}>} attempt
 * @param {number} timeoutMs `0` or a non-finite value disables the bound
 * @returns {Promise<{ok: boolean, code: string|null, message: string|null}>}
 */
async function interruptWithin(attempt, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof setTimeout !== 'function') {
    return attempt()
  }
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null
  try {
    return await Promise.race([
      attempt(),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              code: null,
              message: `the Host did not answer the interrupt within ${Math.round(timeoutMs)} ms`,
            }),
          timeoutMs,
        )
        timer?.unref?.()
      }),
    ])
  } finally {
    if (timer !== null) {
      try {
        clearTimeout(timer)
      } catch (_error) {
        // A disposed host may have torn the timer registry down.
      }
    }
  }
}

/**
 * The staged close flow, as one holder with its own face (ADR-0017).
 *
 * An idle session closes immediately. A running one is only staged in
 * `pendingClose`: the user must confirm, because closing the pane asks the Host
 * to interrupt the turn. The confirmation never half-closes anything: on success
 * the pane is released, on a real refusal it stays mounted with `closeError` and
 * the user can retry, dismiss, or take `force()` — closing the pane while the
 * turn keeps running in the background. A refusal the Host answers with "nothing
 * to stop" closes the pane directly: the turn is already gone.
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
 * @param {number} [deps.interruptTimeoutMs] test seam for the interrupt bound
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
  const interruptTimeoutMs =
    typeof deps.interruptTimeoutMs === 'number' && Number.isFinite(deps.interruptTimeoutMs)
      ? deps.interruptTimeoutMs
      : INTERRUPT_TIMEOUT_MS

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
   * pane interrupts the turn.
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
   * Confirm the staged close: ask the Host to stop the turn, then release the
   * pane.
   *
   * - The Host answered and the turn is gone (or was never there): close.
   * - The Host refused: keep the pane, report the reason, and leave the dialog up
   *   with `force()` available, so a refusal cannot trap the user behind the
   *   overlay (ADR-0021).
   * - The Host did not answer: same as a refusal, with the elapsed bound named in
   *   the message.
   *
   * @returns {Promise<boolean>} whether the pane was closed
   */
  async function confirm() {
    if (isDisposed()) return false
    if (pendingClose === null || closeBusy) return false
    const pending = pendingClose
    write({ closeBusy: true, closeError: null })
    const outcome = await interruptWithin(
      () => interruptSession(sessions, pending.sessionId),
      interruptTimeoutMs,
    )
    if (isDisposed()) return false
    // The panel may have been hidden (or another close requested) while the
    // interrupt was in flight; in that case the pane already lost its refs and
    // must not be structurally re-reconciled from an inactive panel.
    if (!getSnapshot().active || pendingClose?.paneId !== pending.paneId) {
      write({ closeBusy: false })
      return false
    }
    if (outcome.ok !== true && !nothingToInterrupt(outcome)) {
      write({ closeBusy: false, closeError: outcome.message })
      return false
    }
    const closed = closePane(pending.paneId)
    write({ pendingClose: null, closeBusy: false, closeError: null })
    return closed
  }

  /**
   * Close the staged pane without stopping its turn.
   *
   * Offered by the dialog only after an interrupt failed or timed out: a refused
   * interrupt used to leave the pane unclosable behind a full-screen overlay,
   * which is worse than losing sight of a turn the user was told about. Releasing
   * the pane never stops the Host Agent, so the turn keeps running and stays
   * visible (and stoppable) in the sidebar.
   *
   * @returns {boolean} whether the pane was closed
   */
  function force() {
    if (isDisposed()) return false
    if (pendingClose === null || closeBusy) return false
    const paneId = pendingClose.paneId
    const closed = closePane(paneId)
    write({ pendingClose: null, closeBusy: false, closeError: null })
    return closed
  }

  /**
   * Dismiss the staged close without changing the session or the layout.
   *
   * This stays available while the interrupt is in flight. A late Host answer
   * then sees that the staged pane is gone and does not close it; refusing the
   * dismiss until the answer arrived left the confirmation up for the whole
   * wait, and every other pane's close control sat behind it.
   */
  function cancel() {
    if (isDisposed() || pendingClose === null) return false
    write({ pendingClose: null, closeBusy: false, closeError: null })
    return true
  }

  return {
    snapshotPatch() {
      return { pendingClose, closeBusy, closeError }
    },
    request,
    bySession,
    confirm,
    force,
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

module.exports = {
  INTERRUPT_TIMEOUT_MS,
  NOTHING_TO_INTERRUPT,
  interruptSession,
  nothingToInterrupt,
  createCloseFlow,
}
