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
 *   `retainedBy.mainView > 0` (ui-workspace:867, ui-session:917). Therefore the
 *   focused pane holds one `mainView` reference and every other pane holds a
 *   `hkcraftPane` reference only — never two panes with `mainView`.
 * - Creating a conversation without leaving the plugin panel:
 *   `sessions.create({ workspaceId })` resolves to the new session id and
 *   publishes its catalog row before resolving
 *   (dsh-api-session-controller/lib/client.js:3965-3977). The native path
 *   `uiWorkspace.startSession(workspaceId)` instead reveals the session through
 *   `replaceMain(..., "reveal")`, which calls `ctx.layout.selectPanel(null)` and
 *   would dismiss the pane workspace (ui-workspace:1500-1530, 1652-1676), so the
 *   pane host never calls it.
 * - Workspace membership is read from the `workspaces.list` snapshot exactly as
 *   `/resume` does (`dsh-sessions.js:workspaceIdOf`, ui-workspace:1421-1425).
 * - While a plugin panel is selected (`activePanelId !== null`) the shell gates
 *   its own "current session" consumers on the panel state: the sidebar rows
 *   ignore the mainView-derived current row (ui-workspace:3026-3028, 3357,
 *   3463) and rename/fork shortcuts are blocked (ui-workspace:143-148). There is
 *   no public API to release the native `uiWorkspace.mainReference` without
 *   revealing a session (which calls `selectPanel(null)`), so the pane host can
 *   only guarantee the mainView references it owns — one, on the focused pane.
 */

const { workspaceIdOf } = require('./dsh-sessions.js')
const layoutTree = require('./layout-tree.js')

const MAIN_SLOT = 'main'
const PANEL_KEY = 'hkcraft.panes'
const PANE_SLOT = 'hkcraft.pane'
const CONTENT_FACTORY = 'conversation.content'
const PANE_SOURCE = 'hkcraftPane'
/** The single retention dsh reads as "the current session" (ui-workspace:867). */
const MAIN_SOURCE = 'mainView'

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
 * Own the pane workspace: the layout tree, the focused pane, one retained
 * session reference per pane, and whether the plugin panel is selected.
 *
 * Pure state: no React, no DOM, no module-level singleton. `createPaneController`
 * is called once per plugin application; tests drive it with a fake ctx.
 *
 * Reference discipline (the part dsh observes):
 * - every pane holds one `hkcraftPane` retention of its session;
 * - exactly one pane — the focused one — additionally holds a `mainView`
 *   retention, because dsh derives "the current session" by scanning for it;
 * - a focus change releases the old `mainView` before acquiring the new one;
 * - closing a pane, replacing its session, hiding the panel or disposing all
 *   release the matching references.
 *
 * @param {{ sessions: any, layout: any, slots: any, workspaces?: any, get?: (name: string) => any }} ctx
 * @param {{ nextPaneId?: () => string }} [options] pane-id factory (tests inject a
 *   deterministic sequence; persistence will reuse restored ids, ticket 08)
 */
function createPaneController(ctx, options = {}) {
  const sessions = ctx?.sessions
  const layout = ctx?.layout
  const slots = ctx?.slots

  /**
   * `workspaces` is optional and may load after this plugin: read it through
   * the live ctx face at call time instead of capturing `undefined` at apply.
   */
  function workspacesFace() {
    if (typeof ctx?.get === 'function') return ctx.get('workspaces')
    return ctx?.workspaces
  }

  /** @type {Map<string, {sessionId: string, pane: any, main: any}>} per paneId */
  const refs = new Map()
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let layoutState = layoutTree.createLayout(null)
  let paneSeq = 0
  let registered = false
  let disposed = false
  let snapshot = Object.freeze({
    active: false,
    sessionId: null,
    probe: probeConversationContent(slots),
    error: null,
    workspaceId: null,
    root: null,
    panes: {},
    activePaneId: null,
  })

  function emit(patch) {
    const next = { ...snapshot, ...patch }
    const changed = Object.keys(next).some((key) => next[key] !== snapshot[key])
    if (!changed) return
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }

  /** The snapshot fields that mirror the layout tree. */
  function statePatch(value, active) {
    const focused = value.activePaneId === null ? undefined : value.panes[value.activePaneId]
    return {
      workspaceId: value.workspaceId,
      root: value.root,
      panes: value.panes,
      activePaneId: value.activePaneId,
      sessionId: active && focused !== undefined ? focused.sessionId : null,
    }
  }

  function panelId() {
    try {
      return layout?.panelInfo?.getSnapshot?.()?.activePanelId ?? null
    } catch {
      return null
    }
  }

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error)
  }

  function nextPaneId() {
    let candidate = typeof options?.nextPaneId === 'function' ? options.nextPaneId() : undefined
    while (typeof candidate !== 'string' || candidate === '' || layoutState.panes[candidate] !== undefined) {
      paneSeq += 1
      candidate = `pane-${paneSeq}`
    }
    return candidate
  }

  function watchReference(reference) {
    // The reference starts opening asynchronously; surface a failed open the
    // same way the right sidebar does (ui-sidebar-right:1753-1756).
    const ready = reference?.ready
    if (ready !== undefined && typeof ready.catch === 'function') {
      ready.catch((error) => {
        console.error('[dsh-hk-craft] pane session opening failed', error)
      })
    }
  }

  function retainSource(sessionId, source) {
    const reference = sessions.retain(sessionId, { source })
    watchReference(reference)
    return reference
  }

  function releaseOne(reference) {
    try {
      reference?.release?.()
    } catch (error) {
      console.error('[dsh-hk-craft] failed to release pane session reference', error)
    }
  }

  function releaseHeld(held) {
    releaseOne(held.pane)
    if (held.main !== undefined) releaseOne(held.main)
  }

  function releaseAll() {
    for (const held of refs.values()) releaseHeld(held)
    refs.clear()
  }

  /**
   * Take the pane retention for a pane, replacing an older session's retention
   * in place. Throws before mutating anything when the retain fails, so a
   * caller can abort the layout change instead of leaving a half-built pane.
   */
  function holdPane(pane) {
    const existing = refs.get(pane.paneId)
    if (existing !== undefined && existing.sessionId === pane.sessionId) return existing
    const reference = retainSource(pane.sessionId, PANE_SOURCE)
    if (existing !== undefined) {
      releaseHeld(existing)
      refs.delete(pane.paneId)
    }
    const held = { sessionId: pane.sessionId, pane: reference, main: undefined }
    refs.set(pane.paneId, held)
    return held
  }

  /**
   * Make the retained references match `next` and return the first failure (or
   * null). Stale references are released before new ones are acquired, and the
   * old `mainView` is always released before the new one is taken.
   *
   * @returns {string|null}
   */
  function reconcile(next) {
    let failure = null
    for (const [paneId, held] of [...refs]) {
      const pane = next.panes[paneId]
      if (pane === undefined || pane.sessionId !== held.sessionId) {
        releaseHeld(held)
        refs.delete(paneId)
      }
    }
    for (const pane of Object.values(next.panes)) {
      if (refs.get(pane.paneId) !== undefined) continue
      try {
        holdPane(pane)
      } catch (error) {
        failure = failure ?? messageOf(error)
      }
    }
    const focusId = next.activePaneId
    for (const [paneId, held] of [...refs]) {
      if (paneId !== focusId && held.main !== undefined) {
        releaseOne(held.main)
        held.main = undefined
      }
    }
    if (focusId !== null && next.panes[focusId] !== undefined) {
      const held = refs.get(focusId)
      if (held !== undefined && held.main === undefined) {
        try {
          held.main = retainSource(next.panes[focusId].sessionId, MAIN_SOURCE)
        } catch (error) {
          failure = failure ?? messageOf(error)
        }
      }
    }
    return failure
  }

  /** Apply a layout change atomically; a failed reconcile rolls back. */
  function apply(next) {
    if (next === layoutState) return false
    const previous = layoutState
    const failure = reconcile(next)
    if (failure !== null) {
      reconcile(previous)
      emit({ error: failure })
      return false
    }
    layoutState = next
    emit({ ...statePatch(next, snapshot.active), error: null })
    return true
  }

  function workspaceOf(sessionId) {
    try {
      return workspaceIdOf(workspacesFace()?.list?.getSnapshot?.(), sessionId)
    } catch {
      return undefined
    }
  }

  async function createSession(workspaceId) {
    if (typeof sessions?.create !== 'function') {
      throw new Error('sessions.create is not available in this shell')
    }
    const sessionId =
      workspaceId === undefined ? await sessions.create({}) : await sessions.create({ workspaceId })
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('sessions.create returned no session id')
    }
    return sessionId
  }

  function focusedPane() {
    const paneId = layoutState.activePaneId
    return paneId === null ? null : (layoutState.panes[paneId] ?? null)
  }

  function focusedWorkspaceId() {
    const pane = focusedPane()
    const fromPane = pane === null ? undefined : workspaceOf(pane.sessionId)
    if (fromPane !== undefined) return fromPane
    if (layoutState.workspaceId !== null) return layoutState.workspaceId
    // Nothing is open yet, so there is no session to derive a workspace from.
    // Fall back to the first workspace the host lists (the same host order the
    // sidebar renders), which lets `/clear` or the empty state open a first
    // pane instead of doing nothing. Ticket 08 replaces this with the real
    // per-workspace scope once the layout store is keyed by workspace.
    const items = workspacesFace()?.list?.getSnapshot?.()?.items
    return Array.isArray(items) ? items[0]?.workspaceId : undefined
  }

  function refreshProbe() {
    emit({ probe: probeConversationContent(slots) })
  }

  const unsubscribePanel =
    layout?.panelInfo?.subscribe?.(() => {
      if (disposed) return
      if (panelId() !== PANEL_KEY && snapshot.active) {
        // The shell switched away (native navigation, panel unregistration, or
        // the layout controller resetting activePanelId). The panes are already
        // unmounted, so drop the references but keep the layout for the next
        // activation.
        releaseAll()
        emit({ ...statePatch(layoutState, false), active: false, error: null })
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

  /** Focus a pane; false when it is absent or already focused. */
  function focusPaneValue(paneId) {
    if (disposed) return false
    if (layoutState.panes[paneId] === undefined) return false
    return apply(layoutTree.focus(layoutState, paneId))
  }

  /** Close a pane by id; false when it is absent. */
  function closePaneValue(paneId) {
    if (disposed) return false
    if (layoutState.panes[paneId] === undefined) return false
    return apply(layoutTree.close(layoutState, paneId))
  }

  /** Replace the focused pane's session, focusing an existing holder instead. */
  function replaceFocusedValue(sessionId) {
    if (disposed || !registered) return false
    const paneId = layoutState.activePaneId
    if (paneId === null) return false
    const holder = layoutTree.paneOfSession(layoutState, sessionId)
    if (holder !== undefined) return holder === paneId ? true : focusPaneValue(holder)
    const next = layoutTree.replaceSession(layoutState, paneId, sessionId)
    if (next === layoutState) return true
    return apply(next)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** The retained reference backing one pane, if that pane is mounted. */
    paneReference(paneId) {
      return refs.get(paneId)?.pane
    },
    /** The focused pane's retained reference (the one dsh treats as current). */
    currentReference() {
      const pane = focusedPane()
      return pane === null ? undefined : refs.get(pane.paneId)?.pane
    },
    focusedPane,
    /** Called by apply once the `main` entry exists, so selectPanel can succeed. */
    markRegistered() {
      registered = true
      refreshProbe()
    },
    refreshProbe,
    /**
     * Show the pane workspace for an explicit session. Omitted means "the
     * session dsh currently treats as the conversation".
     *
     * With panes already open, a known session focuses its pane and an unknown
     * one replaces the focused pane's content — the footer toggle never
     * dismantles the layout.
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
      if (snapshot.active) {
        if (target === undefined) return true
        const holder = layoutTree.paneOfSession(layoutState, target)
        if (holder !== undefined && holder === layoutState.activePaneId) return true
      }

      let next = layoutState
      if (next.root === null) {
        if (target !== undefined) {
          next = layoutTree.openPane(next, {
            paneId: nextPaneId(),
            sessionId: target,
            view: layoutTree.DEFAULT_VIEW,
          })
          next = { ...next, workspaceId: next.workspaceId ?? workspaceOf(target) ?? null }
        }
      } else if (target !== undefined) {
        const holder = layoutTree.paneOfSession(next, target)
        next =
          holder !== undefined
            ? layoutTree.focus(next, holder)
            : layoutTree.replaceSession(next, next.activePaneId, target)
      }

      const previous = layoutState
      const failure = reconcile(next)
      if (failure !== null) {
        reconcile(previous)
        emit({ error: failure })
        return false
      }
      try {
        layout.selectPanel(PANEL_KEY)
      } catch (error) {
        reconcile(previous)
        emit({ error: messageOf(error) })
        return false
      }
      layoutState = next
      emit({ ...statePatch(next, true), active: true, error: null })
      return true
    },
    /** Return to dsh's native Conversation, keeping the layout for next time. */
    deactivate() {
      if (disposed) return
      if (snapshot.active && panelId() === PANEL_KEY) {
        try {
          layout.selectPanel(null)
        } catch (error) {
          emit({ error: messageOf(error) })
          return
        }
      }
      releaseAll()
      emit({ ...statePatch(layoutState, false), active: false, error: null })
    },
    /** Move the focus (and with it dsh's "current session"). */
    focusPane(paneId) {
      return focusPaneValue(paneId)
    },
    /**
     * Split a pane and open a conversation beside it.
     *
     * With no `options.sessionId` a brand-new conversation is created in the
     * pane's workspace and the new pane takes the focus. Passing an explicit
     * session is the seam the tab strip's `+` and `/resume`'s Ctrl+Enter will
     * use (tickets 06): the session is opened in the new pane instead of being
     * created. A session already mounted in another pane is focused rather than
     * mounted twice (spec §4.4).
     *
     * @param {string} paneId
     * @param {'row'|'col'} dir
     * @param {{sessionId?: string}} [options]
     * @returns {Promise<boolean>}
     */
    async split(paneId, dir, options = {}) {
      if (disposed || !registered) return false
      const origin = layoutState.panes[paneId]
      if (origin === undefined) return false
      if (dir !== 'row' && dir !== 'col') return false

      let sessionId = options?.sessionId
      if (sessionId !== undefined) {
        const holder = layoutTree.paneOfSession(layoutState, sessionId)
        if (holder !== undefined) {
          if (holder !== layoutState.activePaneId) apply(layoutTree.focus(layoutState, holder))
          return false
        }
      } else {
        const workspaceId = workspaceOf(origin.sessionId) ?? layoutState.workspaceId ?? undefined
        if (workspaceId === undefined) {
          emit({ error: `cannot split: pane ${paneId} has no workspace` })
          return false
        }
        try {
          sessionId = await createSession(workspaceId)
        } catch (error) {
          emit({ error: messageOf(error) })
          return false
        }
      }

      const pane = { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
      const next = layoutTree.split(layoutState, paneId, dir, pane)
      if (next === layoutState) return false
      return apply(next)
    },
    /**
     * Close one pane. Structurally its sibling takes the parent's place and the
     * focus moves to the neighbour; interrupting a running session and asking
     * for confirmation is ticket 09, which wraps this call.
     *
     * @param {string} paneId
     * @returns {boolean}
     */
    closePane(paneId) {
      return closePaneValue(paneId)
    },
    /** Close the pane showing `sessionId` (the conversation fallbacks' exit). */
    closePaneBySession(sessionId) {
      const paneId = layoutTree.paneOfSession(layoutState, sessionId)
      return paneId === undefined ? false : closePaneValue(paneId)
    },
    /**
     * Pane-aware `/resume`: swap the focused pane's conversation without
     * touching the tree, the focus or the panel selection. If the session is
     * already mounted elsewhere, focus that pane instead.
     *
     * @param {string} sessionId
     * @returns {boolean}
     */
    replaceFocusedSession(sessionId) {
      return replaceFocusedValue(sessionId)
    },
    /**
     * Pane-aware `/clear`: create a conversation in the pane's workspace and put
     * it in the focused pane — or open the first pane when the workspace is
     * empty. Returns false when the panel is not showing or the workspace is
     * unknown, so the command can fall back to the native path.
     *
     * @param {string} [workspaceId]
     * @returns {Promise<boolean>}
     */
    async newInFocused(workspaceId) {
      if (disposed || !registered) return false
      if (!snapshot.active) return false
      const targetWorkspace = workspaceId ?? focusedWorkspaceId()
      if (targetWorkspace === undefined) return false
      let sessionId
      try {
        sessionId = await createSession(targetWorkspace)
      } catch (error) {
        emit({ error: messageOf(error) })
        return false
      }
      if (layoutState.activePaneId !== null) return replaceFocusedValue(sessionId)
      const pane = { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
      const next = { ...layoutTree.openPane(layoutState, pane), workspaceId: targetWorkspace }
      return apply(next)
    },
    /**
     * Remember a pane's conversation view (ticket 07 drives the toggle; the
     * state is per pane and travels with the layout).
     *
     * @param {string} paneId
     * @param {'chat'|'trajectory'} view
     * @returns {boolean}
     */
    setView(paneId, view) {
      if (disposed) return false
      return apply(layoutTree.setView(layoutState, paneId, view))
    },
    /**
     * Drag a separator: `path` addresses the split (a/b steps from the root).
     *
     * @param {string[]} path
     * @param {number} ratio
     * @returns {boolean}
     */
    resize(path, ratio) {
      if (disposed) return false
      return apply(layoutTree.resize(layoutState, path, ratio))
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
      snapshot = Object.freeze({
        ...snapshot,
        active: false,
        sessionId: null,
        error: null,
        workspaceId: null,
        root: null,
        panes: {},
        activePaneId: null,
      })
    },
  }
}

module.exports = {
  MAIN_SLOT,
  PANEL_KEY,
  PANE_SLOT,
  CONTENT_FACTORY,
  PANE_SOURCE,
  MAIN_SOURCE,
  probeConversationContent,
  findCurrentSession,
  derivePanePhase,
  createPaneController,
}
