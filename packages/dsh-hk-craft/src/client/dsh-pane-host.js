'use strict'

/**
 * Every dsh assumption this plugin makes about mounting a Session into the
 * central `main` area lives here, so a wrong guess is a one-file fix.
 *
 * Verified against the unpacked client bundles in `.scratch/_tmp/client/`:
 *
 * - `main` is a keyed root slot. The frame renders it with
 *   `entryKey: activePanelId ?? "conversation"` (ui-layout:119), so selecting a
 *   different key unmounts the native Conversation instead of stacking on it.
 * - `ctx.layout.selectPanel(id)` rejects ids that have no live `main` entry and
 *   `selectPanel(null)` returns to the native Conversation (ui-layout:468-472).
 * - A `main` entry that declares a non-root child gets `SessionProvider` and
 *   `renderSlot` in its kit (ui-renderer:753-760). A session-scoped slot entry
 *   additionally gets the session standard props (sessionId, useSession, …).
 * - `renderFactorySlot(name, props)` is available on every entry kit and does
 *   not check ownership (ui-renderer:740, 1061-1069). The official Conversation
 *   mounts the body as `renderFactorySlot("conversation.content", { variant:
 *   "main", phase, hero }, { slots: CONTENT_SLOTS })`
 *   (ui-conversation:17601-17620).
 * - The factory is named `conversation.content` (ui-conversation:19936-19998).
 * - Retention is an independent reference per caller:
 *   `sessions.retain(id, { source })` … `reference.release()`, exactly as the
 *   right sidebar does with `source: "sidebarView"`
 *   (ui-sidebar-right:1753, 1801-1807).
 * - "Current session" is derived, not stored: the first session row with
 *   `retainedBy.mainView > 0` (ui-workspace:867, ui-session:917).
 */

const MAIN_SLOT = 'main'
const PANEL_KEY = 'hkcraft.panes'
const PANE_SLOT = 'hkcraft.pane'
const CONTENT_FACTORY = 'conversation.content'
const PANE_SOURCE = 'hkcraftPane'

/**
 * Probe the `conversation.content` Factory through the public slots snapshot.
 *
 * `ctx.slots.snapshot(root)` accepts `factory:<name>` and returns an array of
 * composition trees, or an empty array when the root is absent
 * (ui-renderer:1557-1563, platform ui-slots `SlotCore.snapshot`). An older or
 * different shell may not expose `snapshot`; in that case the pane still
 * mounts optimistically and relies on the FactoryOutlet fallback.
 *
 * @param {any} slots the `ctx.slots` face
 * @returns {{ ok: boolean, status: 'present'|'missing'|'error'|'unknown', message?: string }}
 */
function probeConversationContent(slots) {
  const snapshot = slots?.snapshot
  if (typeof snapshot !== 'function') {
    return { ok: true, status: 'unknown', message: 'slots.snapshot is not available' }
  }
  try {
    const result = snapshot.call(slots, `factory:${CONTENT_FACTORY}`)
    const present =
      Array.isArray(result) &&
      result.some((root) => root?.type === 'factory' && root?.name === CONTENT_FACTORY)
    return present
      ? { ok: true, status: 'present' }
      : { ok: false, status: 'missing', message: `factory "${CONTENT_FACTORY}" is not registered` }
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Derive the session dsh currently treats as "the conversation".
 *
 * dsh does not store this id. Every consumer scans the session list for the
 * first row retained through `mainView` (ui-workspace:867, ui-session:917).
 *
 * @param {any} sessions the `ctx.sessions` face
 * @returns {string | undefined}
 */
function findCurrentSession(sessions) {
  const byId = sessions?.list?.getSnapshot?.()?.byId ?? {}
  for (const row of Object.values(byId)) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id
  }
  return undefined
}

/**
 * The native Conversation's phase derivation (ui-conversation:17605-17611,
 * helper at 17379-17381), kept pure so the pane can pass the same props the
 * official main panel passes to `conversation.content`.
 *
 * @param {{ sessionId?: string, session?: any, conversation?: any, summaryBlank?: boolean }} input
 * @returns {{ phase: 'blank'|'engaging'|'active'|'settling'|'hero', hero: boolean }}
 */
function derivePanePhase({ sessionId, session, conversation, summaryBlank }) {
  const shellPhase =
    session === undefined || conversation === undefined
      ? 'blank'
      : conversation.activeTargets?.size > 0 ||
          (!session.blank && !session.awaitingFirstTurn) ||
          session.running
        ? 'active'
        : session.promptAttempted
          ? 'engaging'
          : 'blank'
  const openState = session?.openState
  const hero = sessionId === undefined || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const settling =
    sessionId !== undefined && shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true
  return { phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }
}

/**
 * Own the one plugin pane: which session it shows, the retained reference that
 * keeps that session alive, and whether the plugin panel is selected.
 *
 * Pure state: no React, no DOM, no module-level singleton. `createPaneController`
 * is called once per plugin application; tests drive it with a fake ctx.
 *
 * @param {{ sessions: any, layout: any, slots: any }} ctx
 */
function createPaneController(ctx) {
  const sessions = ctx?.sessions
  const layout = ctx?.layout
  const slots = ctx?.slots

  /** @type {Map<string, any>} one retained reference per session, never two */
  const references = new Map()
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let registered = false
  let disposed = false
  let snapshot = Object.freeze({
    active: false,
    sessionId: null,
    probe: probeConversationContent(slots),
    error: null,
  })

  function emit(patch) {
    const next = { ...snapshot, ...patch }
    if (
      next.active === snapshot.active &&
      next.sessionId === snapshot.sessionId &&
      next.probe === snapshot.probe &&
      next.error === snapshot.error
    ) {
      return
    }
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }

  function panelId() {
    try {
      return layout?.panelInfo?.getSnapshot?.()?.activePanelId ?? null
    } catch {
      return null
    }
  }

  function retain(sessionId) {
    const existing = references.get(sessionId)
    if (existing !== undefined) return existing
    const reference = sessions.retain(sessionId, { source: PANE_SOURCE })
    // The reference starts opening asynchronously; surface a failed open the
    // same way the right sidebar does (ui-sidebar-right:1753-1756).
    const ready = reference?.ready
    if (ready !== undefined && typeof ready.catch === 'function') {
      ready.catch((error) => {
        console.error('[dsh-hk-craft] pane session opening failed', error)
      })
    }
    references.set(sessionId, reference)
    return reference
  }

  function release(sessionId) {
    const reference = references.get(sessionId)
    if (reference === undefined) return
    references.delete(sessionId)
    try {
      reference.release()
    } catch (error) {
      console.error('[dsh-hk-craft] failed to release pane session reference', error)
    }
  }

  function releaseAll() {
    for (const sessionId of [...references.keys()]) release(sessionId)
  }

  function refreshProbe() {
    emit({ probe: probeConversationContent(slots) })
  }

  const unsubscribePanel =
    layout?.panelInfo?.subscribe?.(() => {
      if (disposed) return
      if (panelId() !== PANEL_KEY && snapshot.active) {
        // The shell switched away (native navigation, panel unregistration, or
        // the layout controller resetting activePanelId). The pane is already
        // unmounted, so only release and mirror the state.
        releaseAll()
        emit({ active: false, sessionId: null, error: null })
      }
    }) ?? (() => {})

  // The renderer contains a Factory crash inside its own boundary and renders
  // an empty `[data-factory-error]` cell. Its supervision channel is the only
  // way the pane can replace that cell with an explicit fallback.
  const unsubscribeEntryError =
    slots?.onEntryError?.((key, entry, error) => {
      if (disposed || key !== `factory:${CONTENT_FACTORY}`) return
      emit({
        probe: {
          ok: false,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }) ?? (() => {})

  return {
    getSnapshot: () => snapshot,
    /** The retained reference currently backing the pane, if any. */
    currentReference() {
      if (snapshot.sessionId === null) return undefined
      return references.get(snapshot.sessionId)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Called by apply once the `main` entry exists, so selectPanel can succeed. */
    markRegistered() {
      registered = true
      refreshProbe()
    },
    refreshProbe,
    /**
     * Show the pane for an explicit session. Omitted means "the session dsh
     * currently treats as the conversation".
     *
     * @param {string} [sessionId]
     * @returns {boolean} whether the plugin panel is now selected
     */
    activate(sessionId) {
      if (disposed) return false
      if (!registered) {
        emit({ error: 'pane main entry is not registered yet' })
        return false
      }
      refreshProbe()
      const target = sessionId ?? findCurrentSession(sessions)
      const targetId = target ?? null
      if (snapshot.active && snapshot.sessionId === targetId) return true

      const previousId = snapshot.sessionId
      let nextReference
      try {
        nextReference = target === undefined ? undefined : retain(target)
      } catch (error) {
        emit({ error: error instanceof Error ? error.message : String(error) })
        return false
      }
      try {
        layout.selectPanel(PANEL_KEY)
      } catch (error) {
        if (nextReference !== undefined) release(target)
        emit({ error: error instanceof Error ? error.message : String(error) })
        return false
      }
      if (previousId !== null && previousId !== targetId) release(previousId)
      emit({ active: true, sessionId: targetId, error: null })
      return true
    },
    /** Return to dsh's native Conversation and drop the retained reference. */
    deactivate() {
      if (disposed) return
      if (snapshot.active && panelId() === PANEL_KEY) {
        try {
          layout.selectPanel(null)
        } catch (error) {
          emit({ error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
      releaseAll()
      emit({ active: false, sessionId: null, error: null })
    },
    /** Plugin unload / panel unregistration: release everything, restore native. */
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribePanel()
      unsubscribeEntryError()
      releaseAll()
      try {
        if (panelId() === PANEL_KEY) layout.selectPanel(null)
      } catch {
        // The layout may already be gone during shell teardown.
      }
      snapshot = Object.freeze({ ...snapshot, active: false, sessionId: null, error: null })
    },
  }
}

module.exports = {
  MAIN_SLOT,
  PANEL_KEY,
  PANE_SLOT,
  CONTENT_FACTORY,
  PANE_SOURCE,
  probeConversationContent,
  findCurrentSession,
  derivePanePhase,
  createPaneController,
}
