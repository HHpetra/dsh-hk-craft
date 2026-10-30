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
 * Interrupt the running turn of one session through the public client route the
 * shell's own stop button uses.
 *
 * Verified against the unpacked bundles:
 * - the stop action resolves its session-scoped conversation face as
 *   `sessions.scope(id).get("conversation")` (ui-conversation:19674-19680) and
 *   calls `cancel()` on it (ui-conversation:19808-19810);
 * - that `cancel()` forwards to `sessions.binding(id).session.cancel()`
 *   (ui-conversation:4940-4953), which is the Host RPC
 *   `remote.session.cancel({ sessionId })`
 *   (dsh-api-session-controller:2429-2440, types/session.js:257-267).
 *
 * The direct binding is the fallback, because it is the same call with one less
 * hop; it reports failures as `{ ok: false }` instead of throwing, so this
 * adapter normalises that. Releasing a Session reference is *not* a substitute:
 * it only tears down the client generation and never stops the Host Agent
 * (dsh-api-session-controller/README.md:82).
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
 * @param {{ nextPaneId?: () => string, viewSwitch?: any }} [options] pane-id factory (tests
 *   inject a deterministic sequence; persistence will reuse restored ids, ticket 08) and the
 *   conversation View adapter (ticket 07 — `dsh-view-switch.js`, tests inject a fake)
 */
function createPaneController(ctx, options = {}) {
  const sessions = ctx?.sessions
  const layout = ctx?.layout
  const slots = ctx?.slots
  const viewSwitch = options?.viewSwitch

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
    pendingClose: null,
    closeBusy: false,
    closeError: null,
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

  /**
   * Whether a pane may offer the trajectory segment. Mirrors ui-conversation's
   * own gate (ui-conversation:19753-19758): the View only exists while
   * developer tools are enabled. Without an adapter the pane stays chat-only.
   */
  function isTrajectoryAvailable() {
    return typeof viewSwitch?.isTrajectoryAvailable === 'function'
      ? viewSwitch.isTrajectoryAvailable() === true
      : false
  }

  /**
   * Follow the developer-tools gate so the segment (and a remembered
   * trajectory choice) react when the setting flips. No-op without an adapter.
   *
   * @param {() => void} listener
   * @returns {() => void}
   */
  function subscribeViewAvailability(listener) {
    return typeof viewSwitch?.subscribeAvailability === 'function'
      ? viewSwitch.subscribeAvailability(listener)
      : () => {}
  }

  /**
   * Drive the real conversation View through the public binding. This is the
   * same call dsh's own tab row makes, so the session is not rebuilt and the
   * draft / scroll state are dsh's own.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  function activateView(pane, view) {
    if (typeof viewSwitch?.activate !== 'function') {
      return { ok: false, error: 'view switching is unavailable in this shell' }
    }
    try {
      return viewSwitch.activate(pane.sessionId, view) ?? { ok: false, error: 'view switch returned no result' }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
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
        emit({
          ...statePatch(layoutState, false),
          active: false,
          error: null,
          pendingClose: null,
          closeBusy: false,
          closeError: null,
        })
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

  // Developer tools gate the trajectory View. Turning them back on re-asserts
  // the trajectory choice each pane remembered; turning them off is left to
  // dsh, whose own refreshViews restores every tracked binding (usually chat).
  const unsubscribeViewAvailability = subscribeViewAvailability(() => {
    if (disposed) return
    if (!isTrajectoryAvailable()) return
    for (const pane of Object.values(layoutState.panes)) {
      if (pane.view === 'trajectory') activateView(pane, pane.view)
    }
  })

  /** Focus a pane; false when it is absent or already focused. */
  function focusPaneValue(paneId) {
    if (disposed) return false
    if (layoutState.panes[paneId] === undefined) return false
    return apply(layoutTree.focus(layoutState, paneId))
  }

  /** The session list row the shell publishes for a session, if still known. */
  function rowOf(sessionId) {
    try {
      return sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
    } catch {
      return undefined
    }
  }

  /**
   * A session is "running" when its published summary says so — the same bit the
   * sidebar's yellow light and the workspace status projection use
   * (`workspace-status.js:sessionSignal`).
   */
  function isSessionRunning(sessionId) {
    return rowOf(sessionId)?.running === true
  }

  /** Drop a pending close (and its error); no layout or session change. */
  function clearPendingClose() {
    if (
      snapshot.pendingClose === null &&
      snapshot.closeError === null &&
      snapshot.closeBusy === false
    ) {
      return
    }
    emit({ pendingClose: null, closeBusy: false, closeError: null })
  }

  /** Close a pane by id; false when it is absent. */
  function closePaneValue(paneId) {
    if (disposed) return false
    if (layoutState.panes[paneId] === undefined) return false
    return apply(layoutTree.close(layoutState, paneId))
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
    if (disposed) return false
    const pane = layoutState.panes[paneId]
    if (pane === undefined) return false
    if (!isSessionRunning(pane.sessionId)) {
      const closed = closePaneValue(paneId)
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
  async function confirmCloseValue() {
    if (disposed) return false
    const pending = snapshot.pendingClose
    if (pending === null || snapshot.closeBusy) return false
    emit({ closeBusy: true, closeError: null })
    try {
      await interruptSession(sessions, pending.sessionId)
    } catch (error) {
      if (disposed) return false
      emit({ closeBusy: false, closeError: messageOf(error) })
      return false
    }
    if (disposed) return false
    // The panel may have been hidden (or another close requested) while the
    // interrupt was in flight; in that case the pane already lost its refs and
    // must not be structurally re-reconciled from an inactive panel.
    if (!snapshot.active || snapshot.pendingClose?.paneId !== pending.paneId) {
      emit({ closeBusy: false })
      return false
    }
    const closed = closePaneValue(pending.paneId)
    emit({ pendingClose: null, closeBusy: false, closeError: null })
    return closed
  }

  /** Dismiss the staged close without changing the session or the layout. */
  function cancelCloseValue() {
    if (disposed || snapshot.pendingClose === null || snapshot.closeBusy) return false
    emit({ pendingClose: null, closeError: null })
    return true
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
      emit({
        ...statePatch(layoutState, false),
        active: false,
        error: null,
        pendingClose: null,
        closeBusy: false,
        closeError: null,
      })
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
     * Ask to close one pane. An idle session closes immediately; a running one
     * only stages `pendingClose` so the view can show the interrupt confirmation
     * (ticket 09). The actual close happens in `confirmClose`.
     *
     * @param {string} paneId
     * @returns {boolean} whether the pane closed immediately
     */
    closePane(paneId) {
      return requestClose(paneId)
    },
    /** Close the pane showing `sessionId` (the conversation fallbacks' exit). */
    closePaneBySession(sessionId) {
      const paneId = layoutTree.paneOfSession(layoutState, sessionId)
      return paneId === undefined ? false : requestClose(paneId)
    },
    /**
     * Confirm a staged close: interrupt the running turn, then close the pane.
     * A failure is reported through `closeError` and the pane stays mounted.
     *
     * @returns {Promise<boolean>} whether the pane was closed
     */
    confirmClose() {
      return confirmCloseValue()
    },
    /** Dismiss the staged close; the session and the layout are unchanged. */
    cancelClose() {
      return cancelCloseValue()
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
     * Switch one pane's conversation view. The remembered choice lives on that
     * pane only; the tree, the focus and every retained reference are
     * untouched, and the session itself is not rebuilt (ticket 07).
     *
     * A trajectory request while developer tools are disabled is refused rather
     * than remembered as an unreachable selection; the segment is disabled for
     * the same reason.
     *
     * @param {string} paneId
     * @param {'chat'|'trajectory'} view
     * @returns {boolean}
     */
    setView(paneId, view) {
      if (disposed) return false
      const pane = layoutState.panes[paneId]
      if (pane === undefined) return false
      if (view !== 'chat' && view !== 'trajectory') return false
      if (pane.view === view) return true
      if (view === 'trajectory' && !isTrajectoryAvailable()) return false
      if (viewSwitch !== undefined) {
        const result = activateView(pane, view)
        if (result?.ok !== true) {
          emit({ error: result?.error ?? 'could not switch the conversation view' })
          return false
        }
      }
      return apply(layoutTree.setView(layoutState, paneId, view))
    },
    /**
     * Re-assert the view a pane remembered, once its conversation binding is
     * available. Called from the pane body after mount; dsh restores the
     * per-session preference on its own, but the pane's memory must win.
     *
     * @param {string} sessionId
     * @returns {boolean}
     */
    restoreViewFor(sessionId) {
      if (disposed) return false
      const paneId = layoutTree.paneOfSession(layoutState, sessionId)
      if (paneId === undefined) return false
      const pane = layoutState.panes[paneId]
      if (pane.view === 'trajectory' && !isTrajectoryAvailable()) return false
      return activateView(pane, pane.view).ok === true
    },
    /** Whether the trajectory segment is offered (developer-tools gate). */
    isTrajectoryAvailable,
    subscribeViewAvailability,
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
      unsubscribeViewAvailability()
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
        pendingClose: null,
        closeBusy: false,
        closeError: null,
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
  interruptSession,
  createPaneController,
}
