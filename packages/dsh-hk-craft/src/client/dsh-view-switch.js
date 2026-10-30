'use strict'

/**
 * The one place this plugin touches dsh's conversation View API.
 *
 * Verified against dsh 0.2.0-rc.2 (durable record:
 * `doc/upstream-contracts.md#conversation-view-switch`):
 *
 * - `uiConversation.binding(sessionId)` resolves the stable per-session binding
 *   and throws for an unknown or inactive session.
 * - `binding.activate(viewId)` performs a View switch on the resident
 *   conversation; it does not rebuild the session, so the draft and the native
 *   scroll behaviour are untouched.
 * - The native View switcher calls the same method, then persists its own
 *   preference; this plugin keeps the per-pane choice in the layout tree
 *   instead, so no dsh store is written.
 * - The trajectory View is gated by
 *   `ctx.configForms.developerTools.enabled.getSnapshot()`; while it is false
 *   ui-conversation skips that View entirely
 *   (`doc/upstream-contracts.md#trajectory-gate-developertools-enabled`).
 *   `DeveloperToolsPreference` reads `value?.enabled ?? false`, so the answer is
 *   false until the host value arrives.
 *
 * `ctx` faces are read lazily: both services may load after this plugin, and a
 * missing service degrades to "chat only" instead of a crash. No React here, so
 * unit tests can drive the adapter with fakes.
 */

const { messageOf } = require('./shared.js')

const CHAT_VIEW = 'chat'
const TRAJECTORY_VIEW = 'trajectory'

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
 * The segments of the pane control, in display order.
 *
 * When developer tools are off the trajectory View does not exist in dsh at
 * all, so it is absent here too — not rendered-but-disabled. Callers hide the
 * whole control while fewer than two segments are available, matching native
 * dsh's "available views < 2" rule.
 *
 * @param {boolean} trajectoryAvailable
 * @returns {{id: 'chat'|'trajectory'}[]}
 */
function viewSegments(trajectoryAvailable) {
  return trajectoryAvailable === true
    ? [{ id: CHAT_VIEW }, { id: TRAJECTORY_VIEW }]
    : [{ id: CHAT_VIEW }]
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
