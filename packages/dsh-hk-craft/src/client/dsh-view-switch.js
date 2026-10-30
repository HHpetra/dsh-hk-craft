'use strict'

/**
 * The one place this plugin touches dsh's conversation View API.
 *
 * Verified against the 0.2.0-rc.2 bundles; the pinned train is 0.2.1-rc.5
 * (`deps/VERSIONS.md`). Durable record:
 * `doc/upstream-contracts.md#conversation-view-switch`.
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
 * `ctx` faces are read lazily through `ctx.get(...)` (the no-inject read): both
 * services may load after this plugin, and this plugin deliberately does not
 * require `configForms`/`uiConversation` just to keep a chat-only pane working.
 * A missing service degrades to "chat only" instead of a crash. No React here,
 * so unit tests can drive the adapter with fakes.
 */

const { messageOf } = require('./shared.js')

const CHAT_VIEW = 'chat'
const TRAJECTORY_VIEW = 'trajectory'

/**
 * Read an optional client service without requiring it through `inject`.
 *
 * A Cordis context is a proxy: reading a service the plugin did not inject
 * throws `cannot get property "…" without inject`, while `ctx.get(name)` is the
 * documented no-inject read. So try `get` first — a plain property read throws,
 * and if that throw is caught by one shared `try` the service silently reads as
 * "absent" (which is exactly how the pane lost its View toggle). The property
 * fallback keeps non-Cordis test doubles working.
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any} the service value, or undefined while it is not provided
 */
function optionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    // A service that is not provided/active yet is simply unavailable.
  }
  try {
    return ctx?.[name]
  } catch {
    // A Cordis proxy throws for an uninjected service; that is "absent", not an
    // error the caller should surface.
    return undefined
  }
}

/**
 * @param {any} ctx
 * @returns {any} the `uiConversation` face, or undefined
 */
function uiConversationFace(ctx) {
  return optionalService(ctx, 'uiConversation')
}

/**
 * The observable enablement of developer tools, exactly as ui-conversation
 * reads it before deciding whether the trajectory View exists.
 *
 * @param {any} ctx
 * @returns {{getSnapshot?: () => unknown, subscribe?: (listener: () => void) => unknown} | undefined}
 */
function developerToolsEnabled(ctx) {
  const enabled = optionalService(ctx, 'configForms')?.developerTools?.enabled
  return typeof enabled === 'object' && enabled !== null ? enabled : undefined
}

/**
 * Whether a pane may offer the trajectory View. Mirrors dsh's own filter:
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
 * The View a pane *shows*: a remembered trajectory choice reads as chat while
 * trajectory is unavailable, instead of pretending an unreachable View is
 * selected.
 *
 * @param {unknown} view
 * @param {boolean} trajectoryAvailable
 * @returns {'chat'|'trajectory'}
 */
function effectiveView(view, trajectoryAvailable) {
  return view === TRAJECTORY_VIEW && trajectoryAvailable === true ? TRAJECTORY_VIEW : CHAT_VIEW
}

/**
 * The Views a pane may offer, in display order.
 *
 * When developer tools are off the trajectory View does not exist in dsh at
 * all, so it is absent here too — not rendered-but-disabled. Callers hide the
 * whole control while fewer than two Views are available, matching native dsh's
 * "available views < 2" rule.
 *
 * @param {boolean} trajectoryAvailable
 * @returns {{id: 'chat'|'trajectory'}[]}
 */
function viewOptions(trajectoryAvailable) {
  return trajectoryAvailable === true
    ? [{ id: CHAT_VIEW }, { id: TRAJECTORY_VIEW }]
    : [{ id: CHAT_VIEW }]
}

/**
 * @param {any} ctx the client plugin context
 */
function createViewSwitch(ctx) {
  /** @type {Set<() => void>} */
  const listeners = new Set()
  /** The enablement source currently fanned out to `listeners`, if any. */
  let source = undefined
  /** Disposer of the shared source subscription. */
  let unsubscribeSource = null
  /** Whether a settings-service watcher is already pending. */
  let watching = false

  /** Publish one source change to every subscriber. */
  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-hk-craft] view availability listener failed', error)
      }
    }
  }

  /**
   * Bind the shared source once. False while the settings service is absent;
   * the caller then waits for it via `watchForService`.
   *
   * @returns {boolean}
   */
  function bindSource() {
    const enabled = developerToolsEnabled(ctx)
    if (typeof enabled?.subscribe !== 'function') return false
    if (source === enabled && unsubscribeSource !== null) return true
    if (unsubscribeSource !== null) unsubscribeSource()
    source = enabled
    try {
      const dispose = enabled.subscribe(notify)
      unsubscribeSource = typeof dispose === 'function' ? dispose : null
    } catch {
      source = undefined
      unsubscribeSource = null
      return false
    }
    return true
  }

  /**
   * A pane may mount before `ui-settings` serves `configForms`; wait for the
   * service once instead of leaving every subscriber a permanent no-op.
   */
  function watchForService() {
    if (watching || typeof ctx?.inject !== 'function') return
    watching = true
    try {
      ctx.inject(['configForms'], () => {
        watching = false
        if (listeners.size === 0) return
        if (bindSource()) notify()
      })
    } catch {
      watching = false
    }
  }

  return {
    /** @returns {boolean} */
    isTrajectoryAvailable() {
      return readTrajectoryAvailability(ctx)
    },
    /**
     * Follow developer-tool changes so the View (and a remembered trajectory
     * choice) react when the setting flips.
     *
     * @param {() => void} listener
     * @returns {() => void}
     */
    subscribeAvailability(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      if (!bindSource()) watchForService()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && unsubscribeSource !== null) {
          unsubscribeSource()
          unsubscribeSource = null
          source = undefined
        }
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
  viewOptions,
}
