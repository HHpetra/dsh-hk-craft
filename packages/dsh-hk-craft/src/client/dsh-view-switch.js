'use strict'

/**
 * The one place this plugin touches dsh's conversation View API.
 *
 * Verified against the unpacked client bundle in
 * `.scratch/_tmp/client/dsh-client-ui-conversation/lib/client.js`:
 *
 * - `uiConversation.binding(sessionId)` resolves the stable per-session binding
 *   and throws for an unknown or inactive session (ui-conversation:4078-4085).
 * - `binding.activate(viewId)` performs a View switch on the resident
 *   conversation; it does not rebuild the session, so the draft and the native
 *   scroll behaviour are untouched (ui-conversation:3951-3954, 19766-19768).
 * - The native View switcher calls the same method, then persists its own
 *   preference; this plugin keeps the per-pane choice in the layout tree
 *   instead, so no dsh store is written (ui-conversation:20086-20089).
 * - The trajectory View is gated by
 *   `ctx.configForms.developerTools.enabled.getSnapshot()`; while it is false
 *   ui-conversation skips that View entirely (ui-conversation:19753-19758).
 *   `DeveloperToolsPreference` reads `value?.enabled ?? false`, so the answer is
 *   false until the host value arrives (ui-settings:1032-1052).
 *
 * `ctx` faces are read lazily: both services may load after this plugin, and a
 * missing service degrades to "chat only" instead of a crash. No React here, so
 * unit tests can drive the adapter with fakes.
 */

const CHAT_VIEW = 'chat'
const TRAJECTORY_VIEW = 'trajectory'

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {any} ctx
 * @returns {any} the `uiConversation` face, or undefined
 */
function uiConversationFace(ctx) {
  try {
    if (ctx?.uiConversation !== undefined) return ctx.uiConversation
    if (typeof ctx?.get === 'function') return ctx.get('uiConversation')
  } catch {
    // A service proxy that rejects the read means "not available yet".
  }
  return undefined
}

/**
 * The observable enablement of developer tools, exactly as ui-conversation
 * reads it before deciding whether the trajectory View exists.
 *
 * @param {any} ctx
 * @returns {{getSnapshot?: () => unknown, subscribe?: (listener: () => void) => unknown} | undefined}
 */
function developerToolsEnabled(ctx) {
  let configForms
  try {
    configForms = ctx?.configForms
    if (configForms === undefined && typeof ctx?.get === 'function') configForms = ctx.get('configForms')
  } catch {
    return undefined
  }
  const enabled = configForms?.developerTools?.enabled
  return typeof enabled === 'object' && enabled !== null ? enabled : undefined
}

/**
 * Whether a pane may offer the trajectory segment. Mirrors dsh's own filter:
 * only when the developer-tools gate reports `true`.
 *
 * @param {any} ctx
 * @returns {boolean}
 */
function readTrajectoryAvailability(ctx) {
  try {
    return developerToolsEnabled(ctx)?.getSnapshot?.() === true
  } catch {
    // A settings store that cannot be read must not take the pane down.
    return false
  }
}

/**
 * The segment a pane *shows*: a remembered trajectory choice reads as chat
 * while trajectory is unavailable, instead of pretending an unreachable View
 * is selected.
 *
 * @param {unknown} view
 * @param {boolean} trajectoryAvailable
 * @returns {'chat'|'trajectory'}
 */
function effectiveView(view, trajectoryAvailable) {
  return view === TRAJECTORY_VIEW && trajectoryAvailable === true ? TRAJECTORY_VIEW : CHAT_VIEW
}

/**
 * The two segments of the pane control, in display order.
 *
 * @param {boolean} trajectoryAvailable
 * @returns {{id: 'chat'|'trajectory', disabled: boolean}[]}
 */
function viewSegments(trajectoryAvailable) {
  return [
    { id: CHAT_VIEW, disabled: false },
    { id: TRAJECTORY_VIEW, disabled: trajectoryAvailable !== true },
  ]
}

/**
 * @param {any} ctx the client plugin context
 */
function createViewSwitch(ctx) {
  return {
    /** @returns {boolean} */
    isTrajectoryAvailable() {
      return readTrajectoryAvailability(ctx)
    },
    /**
     * Follow developer-tool changes so the segment (and a remembered trajectory
     * choice) react when the setting flips.
     *
     * @param {() => void} listener
     * @returns {() => void}
     */
    subscribeAvailability(listener) {
      const enabled = developerToolsEnabled(ctx)
      if (typeof enabled?.subscribe !== 'function') return () => {}
      try {
        const dispose = enabled.subscribe(listener)
        return typeof dispose === 'function' ? dispose : () => {}
      } catch {
        return () => {}
      }
    },
    /**
     * Drive the real View on one session's conversation binding.
     *
     * @param {string} sessionId
     * @param {'chat'|'trajectory'} viewId
     * @returns {{ok: boolean, error?: string}}
     */
    activate(sessionId, viewId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, error: 'cannot switch view: no session in this pane' }
      }
      if (viewId !== CHAT_VIEW && viewId !== TRAJECTORY_VIEW) {
        return { ok: false, error: `cannot switch view: unknown view "${String(viewId)}"` }
      }
      const uiConversation = uiConversationFace(ctx)
      if (typeof uiConversation?.binding !== 'function') {
        return { ok: false, error: 'uiConversation service is not available in this shell' }
      }
      try {
        const binding = uiConversation.binding(sessionId)
        if (typeof binding?.activate !== 'function') {
          return { ok: false, error: 'uiConversation.binding has no activate(viewId)' }
        }
        binding.activate(viewId)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

module.exports = {
  CHAT_VIEW,
  TRAJECTORY_VIEW,
  createViewSwitch,
  effectiveView,
  viewSegments,
}
