'use strict'

/**
 * Every dsh assumption this plugin makes about mounting a Session into the
 * central `main` area is recorded in `doc/upstream-contracts.md` (verified
 * against dsh 0.2.0-rc.2). The parts relevant here:
 *
 * - `main` is a keyed root slot; the frame renders `activePanelId ??
 *   "conversation"`, so selecting a different key unmounts the native
 *   Conversation instead of stacking on it — `#main-keyed-slot-and-selectpanel`.
 * - `ctx.layout.selectPanel(id)` rejects ids without a live `main` entry;
 *   `selectPanel(null)` returns to the native Conversation.
 * - A `main` entry that declares a non-root child gets `SessionProvider` and
 *   `renderSlot` in its kit, plus `renderFactorySlot` for
 *   `conversation.content` — `#sessionprovider-and-conversationcontent`.
 * - Retention is an independent reference per caller:
 *   `sessions.retain(id, { source })` … `reference.release()`. "Current
 *   session" is derived from the first row with `retainedBy.mainView > 0`, so
 *   the focused pane holds one `mainView` reference and every other pane holds
 *   a `hkcraftPane` reference only — `#retention-sources-and-the-single-mainview-derivation`.
 * - `sessions.create({ workspaceId })` publishes the catalog row before
 *   resolving and never reuses a blank session; the native
 *   `uiWorkspace.startSession(workspaceId)` reveals through
 *   `replaceMain(…, "reveal")` → `selectPanel(null)`, which would dismiss the
 *   pane workspace, so the pane host never calls it —
 *   `#creating-a-session-without-leaving-the-panel`.
 * - Workspace membership comes from the `workspaces.list` snapshot —
 *   `#workspace-catalog`.
 * - While a plugin panel is selected the shell gates its own "current session"
 *   consumers on the panel state (sidebar current row, rename/fork shortcuts).
 *   There is no public API to release the native `uiWorkspace.mainReference`
 *   without revealing a session, so the pane host can only guarantee the
 *   mainView references it owns: one, on the focused pane.
 */

const { listWorkspaceConversations, workspaceIdOf } = require('./dsh-sessions.js')
const layoutTree = require('./layout-tree.js')
const { createPaneLayouts, UNSCOPED_WORKSPACE } = require('./pane-layouts.js')
const { createCloseFlow } = require('./pane-close.js')
const { messageOf } = require('./shared.js')
const { mainSessionId } = require('./workspace-status.js')
const { openConversationItems, paneIdForStripIndex } = require('./pane-strip.js')

const MAIN_SLOT = 'main'
const PANEL_KEY = 'hkcraft.panes'
const PANE_SLOT = 'hkcraft.pane'
const CONTENT_FACTORY = 'conversation.content'
const PANE_SOURCE = 'hkcraftPane'
/** The single retention dsh reads as "the current session". */
const MAIN_SOURCE = 'mainView'

/**
 * Probe the `conversation.content` Factory through the public slots snapshot.
 *
 * `ctx.slots.snapshot(root)` accepts `factory:<name>` and returns an array of
 * composition trees, or an empty array when the root is absent
 * (`doc/upstream-contracts.md#sessionprovider-and-conversationcontent`). An
 * older or different shell may not expose `snapshot`; in that case the pane
 * still mounts optimistically and relies on the FactoryOutlet fallback.
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
 * The native Conversation's phase derivation, kept pure so the pane can pass
 * the same props the official main panel passes to `conversation.content`
 * (`doc/upstream-contracts.md#sessionprovider-and-conversationcontent`).
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
 * The browser's origin-wide storage, or null. Reading the global itself can
 * throw in locked-down profiles, and Node (the unit tests) has none.
 *
 * @returns {{getItem?: Function, setItem?: Function}|null}
 */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch (_error) {
    return null
  }
}

/**
 * Own the pane workspace: one layout per workspace, the focused pane of the
 * active workspace, one retained session reference per mounted pane, and
 * whether the plugin panel is selected.
 *
 * Per-workspace scope (ticket 08): `layouts` is keyed by workspace id and every
 * transition targets one workspace's tree. Switching workspace only changes
 * which tree is visible — no pane is closed, no session is released, and every
 * pane of every loaded workspace stays retained (and mounted-but-hidden by the
 * view layer) so streaming output, scroll position and composer drafts survive.
 *
 * Reference discipline (the part dsh observes):
 * - every loaded pane holds one `hkcraftPane` retention of its session;
 * - exactly one pane — the focused pane of the *active* workspace —
 *   additionally holds a `mainView` retention, because dsh derives "the current
 *   session" by scanning for it. A hidden workspace's panes keep their
 *   `hkcraftPane` retention only;
 * - a focus or workspace change releases the old `mainView` before acquiring
 *   the new one;
 * - closing a pane, replacing its session, hiding the panel or disposing all
 *   release the matching references.
 *
 * Persistence and the per-workspace registry live in `pane-layouts.js`; every
 * change writes `dsh.hkcraft.layout.v1.<workspaceId>` (best-effort), and a
 * workspace's layout is read back from that key the first time the workspace is
 * shown. Panes whose session is gone are dropped at restore time, and the prune
 * re-runs if the catalog was still loading when the layout was first read.
 *
 * @param {{ sessions: any, layout: any, slots: any, workspaces?: any, get?: (name: string) => any }} ctx
 * @param {{ nextPaneId?: () => string, storage?: any, viewSwitch?: any }} [options]
 *   `nextPaneId` is a deterministic id factory and `storage` a storage seam for
 *   tests (defaults to `localStorage`); `viewSwitch` is the conversation View
 *   adapter (ticket 07 — `dsh-view-switch.js`, tests inject a fake)
 * @returns {any}
 */
function createPaneController(ctx, options = {}) {
  const sessions = ctx?.sessions
  const layout = ctx?.layout
  const slots = ctx?.slots
  const storage = options.storage === undefined ? defaultStorage() : options.storage
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
  /** Per-workspace layouts, the visible workspace and persistence. */
  const book = createPaneLayouts({ storage, nextPaneId: () => nextPaneId() })
  let paneSeq = 0
  let registered = false
  let disposed = false
  let snapshot = Object.freeze({
    active: false,
    sessionId: null,
    probe: probeConversationContent(slots),
    error: null,
    workspaceId: null,
    layouts: {},
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

  /** The snapshot fields that mirror the active layout tree. */
  function statePatch(active) {
    const value = book.activeLayout()
    const focused = value.activePaneId === null ? undefined : value.panes[value.activePaneId]
    return {
      workspaceId: book.getActiveWorkspaceId(),
      layouts: book.layoutsMap(),
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

  /** Every pane id currently loaded, across all workspaces. */
  function paneIdInUse(paneId) {
    for (const layoutValue of Object.values(book.allLayouts())) {
      if (layoutValue.panes[paneId] !== undefined) return true
    }
    return false
  }

  /** Pane ids are unique across workspaces, so the renderer and refs can key on one id. */
  function nextPaneId() {
    let candidate = typeof options?.nextPaneId === 'function' ? options.nextPaneId() : undefined
    while (typeof candidate !== 'string' || candidate === '' || paneIdInUse(candidate)) {
      paneSeq += 1
      candidate = `pane-${paneSeq}`
    }
    return candidate
  }

  function watchReference(reference) {
    // The reference starts opening asynchronously; surface a failed open the
    // same way the right sidebar does (see `doc/upstream-contracts.md`
    // `#retention-sources-and-the-single-mainview-derivation`).
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
   * Make the retained references match every loaded layout and return the first
   * failure (or null). Panes of hidden workspaces stay retained under
   * `hkcraftPane` only.
   *
   * Every new retention is taken *before* any stale one is released. That order
   * matters for the strip-entry drag swap (ticket 10): pane A's and pane B's sessions
   * trade places in one layout change, and releasing first would momentarily
   * drop each session to zero client references — tearing down the dsh client
   * generation and losing the scroll position / composer draft that the split
   * view exists to preserve.
   *
   * A failed acquire leaves the existing references untouched (the speculative
   * ones are released again), so a caller can abort the layout change instead of
   * leaving a half-built pane. The old `mainView` is released before the new one
   * is taken, as before.
   *
   * @param {Record<string, object>} nextLayouts
   * @returns {{failure: string|null, failed: Array<{paneId: string, workspaceId: string, error: any}>}}
   */
  function reconcileAll(nextLayouts) {
    const failed = []
    const desired = new Map()
    for (const [workspaceId, value] of Object.entries(nextLayouts)) {
      for (const pane of Object.values(value.panes)) desired.set(pane.paneId, pane)
    }

    /** Retentions that still match the desired layout, kept by identity. */
    const keep = new Map()
    /** Retentions the new layout no longer wants (different session or gone). */
    const stale = []
    for (const [paneId, held] of refs) {
      const pane = desired.get(paneId)
      if (pane !== undefined && pane.sessionId === held.sessionId) keep.set(paneId, held)
      else stale.push(held)
    }

    /** @type {Array<{sessionId: string, pane: any, main: undefined}>} */
    const acquired = []
    for (const pane of desired.values()) {
      if (keep.has(pane.paneId)) continue
      try {
        const held = { sessionId: pane.sessionId, pane: retainSource(pane.sessionId, PANE_SOURCE), main: undefined }
        keep.set(pane.paneId, held)
        acquired.push(held)
      } catch (error) {
        failed.push({ paneId: pane.paneId, workspaceId: book.workspaceOfPane(nextLayouts, pane.paneId), error })
      }
    }

    if (failed.length > 0) {
      // Undo the speculative acquires and keep the previous reference set as it
      // was; the caller's rollback then finds nothing to repair.
      for (const held of acquired) releaseHeld(held)
      return {
        failure: messageOf(failed[0].error),
        failed,
      }
    }

    for (const held of stale) releaseHeld(held)
    refs.clear()
    for (const [paneId, held] of keep) refs.set(paneId, held)

    const focused = book.focusedPaneOf(nextLayouts)
    for (const [paneId, held] of [...refs]) {
      if ((focused === null || paneId !== focused.paneId) && held.main !== undefined) {
        releaseOne(held.main)
        held.main = undefined
      }
    }
    if (focused !== null) {
      const held = refs.get(focused.paneId)
      if (held !== undefined && held.main === undefined) {
        try {
          held.main = retainSource(focused.sessionId, MAIN_SOURCE)
        } catch (error) {
          failed.push({ paneId: focused.paneId, workspaceId: book.getActiveWorkspaceId(), error })
        }
      }
    }
    return {
      failure: failed.length === 0 ? null : messageOf(failed[0].error),
      failed,
    }
  }

  /** Apply a layout change atomically; a failed reconcile rolls back. */
  function apply(next, workspaceId = book.getActiveWorkspaceId()) {
    const current = book.layoutOf(workspaceId)
    if (next === current) return false
    const previous = book.allLayouts()
    const proposed = { ...previous, [workspaceId === null ? UNSCOPED_WORKSPACE : workspaceId]: next }
    const { failure } = snapshot.active ? reconcileAll(proposed) : { failure: null }
    if (failure !== null) {
      if (snapshot.active) reconcileAll(previous)
      emit({ error: failure })
      return false
    }
    book.store(workspaceId, next)
    emit({ ...statePatch(snapshot.active), error: null })
    return true
  }

  function workspaceOf(sessionId) {
    try {
      return workspaceIdOf(workspacesFace()?.list?.getSnapshot?.(), sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * The sessions that still exist in one workspace, from the host catalogs.
   * `null` means "not loaded yet": restore keeps every pane instead of guessing.
   *
   * @param {string} workspaceId
   * @returns {Set<string>|null}
   */
  function knownSessionsOf(workspaceId) {
    const workspacesSnapshot = workspacesFace()?.list?.getSnapshot?.()
    if (workspacesSnapshot === undefined || workspacesSnapshot === null) return null
    if (workspacesSnapshot.phase !== 'ready' || !Array.isArray(workspacesSnapshot.items)) return null
    const record = workspacesSnapshot.items.find((item) => item?.workspaceId === workspaceId)
    if (record === undefined) {
      // The workspace itself is gone; its stored tree has no home any more.
      return new Set()
    }
    const known = new Set(Array.isArray(record.sessionIds) ? record.sessionIds : [])
    const sessionsSnapshot = sessions?.list?.getSnapshot?.()
    if (sessionsSnapshot?.phase !== 'loading') {
      for (const sessionId of Object.keys(sessionsSnapshot?.byId ?? {})) known.add(sessionId)
    }
    return known
  }

  /**
   * Make one workspace's layout available, restoring it on first use.
   *
   * The restore prune can only run against a ready catalog. When the layout was
   * first loaded while `workspaces.list` was still loading, every pane was
   * kept; the prune must therefore be able to re-run later, so this also prunes
   * an already-loaded workspace whenever the catalog is now ready (spec §9).
   *
   * @param {string} workspaceId
   * @returns {boolean}
   */
  function ensureWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    ensureCatalogSubscription()
    const known = knownSessionsOf(workspaceId)
    const already = book.hasWorkspace(workspaceId)
    if (!book.ensureWorkspace(workspaceId, known)) return false
    if (already) pruneWorkspace(workspaceId, known)
    return true
  }

  /**
   * Apply the catalog prune to one loaded workspace.
   *
   * Goes through `apply` for both visible and hidden workspaces: while the panel
   * is active every loaded workspace has mounted panes and retained
   * references, so the reconcile has to see the pruned tree even when that
   * workspace is not the visible one.
   *
   * @param {string} workspaceId
   * @param {Set<string>|null} knownSessionIds
   */
  function pruneWorkspace(workspaceId, knownSessionIds) {
    const pruned = book.pruneCandidate(workspaceId, knownSessionIds)
    if (pruned === null) return
    apply(pruned, workspaceId)
  }

  /**
   * Re-run the prune for every loaded workspace once the catalog becomes ready.
   * Called from the catalog subscription and from every action that already
   * reads the catalog, so a late load cannot leave vanished sessions mounted.
   */
  function pruneLoadedWorkspaces() {
    if (disposed) return
    for (const workspaceId of book.workspaceIds()) {
      pruneWorkspace(workspaceId, knownSessionsOf(workspaceId))
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
    const value = book.activeLayout()
    const paneId = value.activePaneId
    return paneId === null ? null : (value.panes[paneId] ?? null)
  }

  function focusedWorkspaceId() {
    const active = book.getActiveWorkspaceId()
    if (active !== null) return active
    const pane = focusedPane()
    const fromPane = pane === null ? undefined : workspaceOf(pane.sessionId)
    if (fromPane !== undefined) return fromPane
    // Nothing is open yet, so there is no session to derive a workspace from.
    // Fall back to the first workspace the host lists (the same host order the
    // sidebar renders), which lets `/clear` or the empty state open a first
    // pane instead of doing nothing.
    const items = workspacesFace()?.list?.getSnapshot?.()?.items
    return Array.isArray(items) ? items[0]?.workspaceId : undefined
  }

  function refreshProbe() {
    emit({ probe: probeConversationContent(slots) })
  }

  /**
   * The workspace's recent conversations for the empty state (ticket 10).
   *
   * Reuses the `/resume` projection and prompt fallback
   * (`dsh-sessions.js:listWorkspaceConversations`) instead of inventing a second
   * list; the view applies `buildResumeRows` for filtering, ordering and
   * truncation, exactly as the command does. With no workspace id the active
   * workspace is used, falling back to the first catalog workspace — the same
   * target the empty state's "new conversation" button uses.
   *
   * @param {string} [workspaceId]
   * @returns {Promise<object[]>} raw conversation rows (never rejects)
   */
  function recentConversationsValue(workspaceId) {
    const target =
      typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : focusedWorkspaceId()
    if (typeof target !== 'string' || target === '') return Promise.resolve([])
    return listWorkspaceConversations({ sessions, workspaces: workspacesFace() }, target).catch(
      () => [],
    )
  }

  /**
   * Whether a pane may offer the trajectory segment. Mirrors dsh's own gate
   * (`doc/upstream-contracts.md#trajectory-gate-developertools-enabled`): the
   * View only exists while developer tools are enabled. Without an adapter the
   * pane stays chat-only.
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
   * same call dsh's own View switcher makes, so the session is not rebuilt and the
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
          ...statePatch(false),
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
    for (const layoutValue of Object.values(book.layoutsMap())) {
      for (const pane of Object.values(layoutValue.panes)) {
        if (pane.view === 'trajectory') activateView(pane, pane.view)
      }
    }
  })

  /**
   * Workspace-catalog notifications. `workspaces.list` is the store whose
   * `phase` decides whether a restore may prune; subscribing to it means a
   * catalog that becomes ready after the first show still runs the prune
   * (spec §9). The service can load after this plugin, so subscription is
   * retried from every action that reads the catalog. If the store exposes no
   * `subscribe`, those actions are the fallback.
   */
  const catalogDisposers = []
  let subscribedList = null
  function ensureCatalogSubscription() {
    if (disposed) return
    const list = workspacesFace()?.list
    if (list === null || list === undefined || typeof list.subscribe !== 'function') return
    if (subscribedList === list) return
    try {
      const dispose = list.subscribe(() => pruneLoadedWorkspaces())
      if (typeof dispose === 'function') {
        subscribedList = list
        catalogDisposers.push(dispose)
      }
    } catch {
      // A store that refuses subscription is simply not observed.
    }
  }

  function unsubscribeCatalog() {
    subscribedList = null
    for (const dispose of catalogDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        // The store is shutting down; forgetting the listener is enough.
      }
    }
  }

  /** Focus a pane; false when it is absent or already focused. */
  function focusPaneValue(paneId) {
    if (disposed) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    if (located.workspaceId !== book.getActiveWorkspaceId()) {
      if (!switchWorkspaceValue(located.workspaceId)) return false
    }
    return apply(layoutTree.focus(book.layoutOf(located.workspaceId), paneId), located.workspaceId)
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

  /** Close a pane by id; false when it is absent. */
  function closePaneValue(paneId) {
    if (disposed) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    return apply(layoutTree.close(book.layoutOf(located.workspaceId), paneId), located.workspaceId)
  }

  // The staged-close flow (interrupt first, then close) lives in
  // `pane-close.js`; it reads this controller's state through the callbacks.
  const closeFlow = createCloseFlow({
    sessions,
    getSnapshot: () => snapshot,
    emit,
    isDisposed: () => disposed,
    locatePane: (paneId) => book.locatePane(paneId),
    rowOf,
    isSessionRunning,
    closePane: (paneId) => closePaneValue(paneId),
  })

  /** Replace the focused pane's session, focusing an existing holder instead. */
  function replaceFocusedValue(sessionId) {
    if (disposed || !registered) return false
    const value = book.activeLayout()
    const paneId = value.activePaneId
    if (paneId === null) return false
    const holder = book.locatePaneIn(sessionId)
    if (holder !== null) {
      return holder.paneId === paneId && holder.workspaceId === book.getActiveWorkspaceId()
        ? true
        : focusPaneValue(holder.paneId)
    }
    const next = layoutTree.replaceSession(value, paneId, sessionId)
    if (next === value) return true
    return apply(next)
  }

  /**
   * Show one workspace's tree without closing anything. This is the D5 seam:
   * references of the workspace being left stay retained, the active
   * workspace's focused pane takes dsh's single `mainView` retention, and the
   * panel selection is untouched.
   *
   * @param {string} workspaceId
   * @returns {boolean} whether that workspace is now the active one
   */
  function switchWorkspaceValue(workspaceId) {
    if (disposed) return false
    if (!ensureWorkspace(workspaceId)) return false
    const switched = book.switchTo(workspaceId, knownSessionsOf(workspaceId))
    if (switched === null || !switched.changed) return switched !== null
    if (snapshot.active) {
      const { failure } = reconcileAll(book.allLayouts())
      if (failure !== null) {
        book.setActiveWorkspace(switched.previous)
        reconcileAll(book.allLayouts())
        emit({ error: failure })
        return false
      }
    }
    // A staged close belongs to a pane of the workspace being left; leaving the
    // confirmation open over another workspace would be a trap. The interrupt
    // itself is never started by a switch, so there is nothing to cancel.
    emit({
      ...statePatch(snapshot.active),
      error: null,
      pendingClose: null,
      closeBusy: false,
      closeError: null,
    })
    return true
  }

  /**
   * Re-select the plugin panel without touching any layout. The sidebar uses
   * this after a native workspace reveal bounced the shell back to the native
   * Conversation; references for every loaded workspace are retained again.
   *
   * @returns {boolean}
   */
  function reactivateValue() {
    if (disposed) return false
    if (!registered) {
      emit({ error: 'pane main entry is not registered yet' })
      return false
    }
    refreshProbe()
    const previous = book.allLayouts()
    const { failure } = reconcileAll(previous)
    if (failure !== null) {
      reconcileAll({})
      emit({ error: failure })
      return false
    }
    try {
      layout.selectPanel(PANEL_KEY)
    } catch (error) {
      reconcileAll({})
      emit({ error: messageOf(error) })
      return false
    }
    emit({ ...statePatch(true), active: true, error: null })
    return true
  }

  /** Split `paneId` and open (or create) the conversation beside it. */
  async function splitPane(paneId, dir, options = {}) {
    if (disposed || !registered) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    const origin = located.pane
    const workspaceId = located.workspaceId
    if (dir !== 'row' && dir !== 'col') return false

    let sessionId = options?.sessionId
    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const owningWorkspace = workspaceOf(sessionId)
      if (owningWorkspace !== undefined && workspaceId !== null && owningWorkspace !== workspaceId) {
        // A pane tree only holds sessions of one workspace (spec D3): show the
        // session in its own workspace instead of mounting it across trees.
        if (!ensureWorkspace(owningWorkspace)) {
          emit({ error: `cannot show workspace ${owningWorkspace}` })
          return false
        }
        const holder = book.locatePaneIn(sessionId)
        if (holder !== null) focusPaneValue(holder.paneId)
        else switchWorkspaceValue(owningWorkspace)
        return false
      }
      const holder = book.locatePaneIn(sessionId)
      if (holder !== null) {
        if (holder.paneId !== paneId || holder.workspaceId !== workspaceId) {
          focusPaneValue(holder.paneId)
        }
        return false
      }
    } else {
      const owningWorkspace =
        workspaceOf(origin.sessionId) ??
        (workspaceId === null ? undefined : book.layoutOf(workspaceId).workspaceId) ??
        undefined
      if (owningWorkspace === undefined) {
        emit({ error: `cannot split: pane ${paneId} has no workspace` })
        return false
      }
      try {
        sessionId = await createSession(owningWorkspace)
      } catch (error) {
        emit({ error: messageOf(error) })
        return false
      }
    }

    const pane = { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
    const next = layoutTree.split(book.layoutOf(workspaceId), paneId, dir, pane)
    if (next === book.layoutOf(workspaceId)) return false
    return apply(next, workspaceId)
  }

  /** Pane-aware `/clear`: new conversation in the focused pane (or first pane). */
  async function newInFocusedValue(workspaceId) {
    if (disposed || !registered) return false
    if (!snapshot.active) return false
    const targetWorkspace = workspaceId ?? focusedWorkspaceId()
    if (typeof targetWorkspace !== 'string' || targetWorkspace === '') return false
    if (!ensureWorkspace(targetWorkspace)) return false
    if (targetWorkspace !== book.getActiveWorkspaceId()) {
      if (!switchWorkspaceValue(targetWorkspace)) return false
    }
    let sessionId
    try {
      sessionId = await createSession(targetWorkspace)
    } catch (error) {
      emit({ error: messageOf(error) })
      return false
    }
    const current = book.activeLayout()
    if (current.activePaneId !== null) return replaceFocusedValue(sessionId)
    const pane = { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
    return apply(layoutTree.openPane(current, pane), targetWorkspace)
  }

  /** `+`: new conversation in a new pane beside the focused one. */
  async function newPaneValue() {
    if (disposed || !registered) return false
    if (!snapshot.active) return false
    const paneId = book.activeLayout().activePaneId
    if (paneId === null) return newInFocusedValue()
    return splitPane(paneId, 'row')
  }

  /** Ctrl+Enter in `/resume`: the chosen conversation in a new pane. */
  async function openInNewPaneValue(sessionId) {
    if (disposed || !registered) return false
    if (typeof sessionId !== 'string' || sessionId === '') return false
    // The strip and the command path only act while the pane panel is showing;
    // outside it there is no visible pane to split beside.
    if (!snapshot.active) return false
    const targetWorkspace = workspaceOf(sessionId) ?? focusedWorkspaceId()
    if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
      if (!ensureWorkspace(targetWorkspace)) return false
      if (targetWorkspace !== book.getActiveWorkspaceId() && !switchWorkspaceValue(targetWorkspace)) {
        return false
      }
    }
    const paneId = book.activeLayout().activePaneId
    if (paneId === null) {
      const pane = { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
      return apply(layoutTree.openPane(book.activeLayout(), pane))
    }
    return splitPane(paneId, 'row', { sessionId })
  }

  /** Ctrl+1..4: focus the open conversation at that strip position. */
  function focusPaneAtValue(index) {
    if (disposed) return false
    const paneId = paneIdForStripIndex(book.activeLayout(), index)
    return paneId === null ? false : focusPaneValue(paneId)
  }

  /**
   * Drag a strip entry onto another entry: exchange the two panes' contents
   * (spec §4.2).
   *
   * The two panes must live in the same workspace tree — a drag can never leave
   * one strip (spec D3) — and the transition is the pure `swap` of
   * `layout-tree.js`: pane ids, leaf positions, ratios and the focus stay put,
   * while the session and the remembered view move. The reference reconciliation
   * acquires both new pane retentions before releasing the old ones, so neither
   * conversation's client generation is torn down by the swap.
   *
   * @param {string} a
   * @param {string} b
   * @returns {boolean} whether the contents were swapped
   */
  function swapPanesValue(a, b) {
    if (disposed) return false
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) return false
    const first = book.locatePane(a)
    const second = book.locatePane(b)
    if (first === null || second === null) return false
    if (first.workspaceId !== second.workspaceId) return false
    const current = book.layoutOf(first.workspaceId)
    const next = layoutTree.swap(current, a, b)
    if (next === current) return false
    return apply(next, first.workspaceId)
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
    /** The workspace the pane workspace is currently showing. */
    focusedWorkspaceId,
    /**
     * The workspace's recent conversations, for the empty state (ticket 10).
     * Rows are raw (`buildResumeRows` filters / sorts / truncates them); the
     * promise never rejects, so the empty state can render an empty list.
     *
     * @param {string} [workspaceId] defaults to the active workspace
     * @returns {Promise<object[]>}
     */
    recentConversations(workspaceId) {
      return recentConversationsValue(workspaceId)
    },
    /** Called by apply once the `main` entry exists, so selectPanel can succeed. */
    markRegistered() {
      registered = true
      refreshProbe()
    },
    refreshProbe,
    /**
     * Show the pane workspace, restoring the layout of the workspace the target
     * session belongs to.
     *
     * Omitted `sessionId` means "the session dsh currently treats as the
     * conversation". With panes already open in that workspace, a known session
     * focuses its pane and an unknown one replaces the focused pane's content —
     * the footer toggle never dismantles the layout. A session of another
     * workspace switches the visible workspace first (ticket 08).
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
      pruneLoadedWorkspaces()
      const target = sessionId ?? mainSessionId(sessions?.list?.getSnapshot?.())
      const targetWorkspace =
        target === undefined ? focusedWorkspaceId() : (workspaceOf(target) ?? focusedWorkspaceId())
      if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
        if (!ensureWorkspace(targetWorkspace)) {
          emit({ error: `cannot show workspace ${targetWorkspace}` })
          return false
        }
        book.setActiveWorkspace(targetWorkspace)
      }

      const current = book.activeLayout()
      if (snapshot.active) {
        if (target === undefined) {
          emit({ ...statePatch(true), active: true, error: null })
          return true
        }
        const holder = layoutTree.paneOfSession(current, target)
        if (holder !== undefined && holder === current.activePaneId) {
          // Already visible and focused; just make sure the panel is selected.
          try {
            layout.selectPanel(PANEL_KEY)
          } catch (error) {
            emit({ error: messageOf(error) })
            return false
          }
          emit({ ...statePatch(true), active: true, error: null })
          return true
        }
      }

      let next = current
      if (next.root === null) {
        if (target !== undefined) {
          next = layoutTree.openPane(next, {
            paneId: nextPaneId(),
            sessionId: target,
            view: layoutTree.DEFAULT_VIEW,
          })
        }
      } else if (target !== undefined) {
        const holder = layoutTree.paneOfSession(next, target)
        next =
          holder !== undefined
            ? layoutTree.focus(next, holder)
            : layoutTree.replaceSession(next, next.activePaneId, target)
      }

      const previous = book.allLayouts()
      const proposed = { ...previous, [book.activeKey()]: next }
      const { failure } = reconcileAll(proposed)
      if (failure !== null) {
        reconcileAll(previous)
        emit({ error: failure })
        return false
      }
      try {
        layout.selectPanel(PANEL_KEY)
      } catch (error) {
        reconcileAll(previous)
        emit({ error: messageOf(error) })
        return false
      }
      book.store(book.getActiveWorkspaceId(), next)
      emit({ ...statePatch(true), active: true, error: null })
      return true
    },
    /**
     * Show another workspace's layout without closing anything (spec D5).
     *
     * @param {string} workspaceId
     * @returns {boolean} whether that workspace is now the active one
     */
    switchWorkspace(workspaceId) {
      return switchWorkspaceValue(workspaceId)
    },
    /**
     * Re-select the plugin panel without changing any layout. The sidebar calls
     * this after a native workspace reveal bounced the shell to the native
     * Conversation; every loaded workspace's panes are retained again.
     *
     * @returns {boolean}
     */
    reactivate() {
      return reactivateValue()
    },
    /** Return to dsh's native Conversation, keeping every workspace layout. */
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
        ...statePatch(false),
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
     * session is the seam the strip's `+` and `/resume`'s Ctrl+Enter use:
     * the session is opened in the new pane instead of being created. A session
     * already mounted in another pane is focused rather than mounted twice
     * (spec §4.4).
     *
     * @param {string} paneId
     * @param {'row'|'col'} dir
     * @param {{sessionId?: string}} [options]
     * @returns {Promise<boolean>}
     */
    split: splitPane,
    /**
     * `+` on the pane strip: a new conversation in a new pane beside the focused
     * one. With no pane open this opens the first pane instead (the empty-state
     * path), so the button never dead-ends.
     *
     * @returns {Promise<boolean>}
     */
    newPane: newPaneValue,
    /**
     * `/resume` + Ctrl+Enter: open a chosen conversation in a new pane beside
     * the focused one, leaving the current pane untouched. The conversation is
     * never mounted twice — an already-open one just takes the focus.
     *
     * @param {string} sessionId
     * @returns {Promise<boolean>}
     */
    openInNewPane: openInNewPaneValue,
    /**
     * Ctrl+1..4: focus the open conversation at that strip position. The
     * numbering is the strip's own projection, not a raw leaf walk.
     *
     * @param {number} index 1-based strip position
     * @returns {boolean}
     */
    focusPaneAt: focusPaneAtValue,
    /**
     * The 1-based strip position of a conversation already open in the visible
     * workspace's panes, or null. `/resume` uses it for the "已在窗格 N" badge
     * (spec D10); selecting such a row focuses that pane instead of remounting.
     *
     * @param {string} sessionId
     * @returns {number|null}
     */
    paneIndexOf(sessionId) {
      if (disposed || typeof sessionId !== 'string' || sessionId === '') return null
      const item = openConversationItems(book.activeLayout()).find(
        (entry) => entry.sessionId === sessionId,
      )
      return item === undefined ? null : item.index
    },
    /**
     * Strip-entry drag: exchange two panes' sessions and remembered views while
     * keeping the tree shape, the ratios and the focus (ticket 10). Dropping on
     * the same entry, an unknown pane or a pane of another workspace is a no-op.
     *
     * @param {string} a
     * @param {string} b
     * @returns {boolean}
     */
    swapPanes: swapPanesValue,
    /**
     * Ask to close one pane. An idle session closes immediately; a running one
     * only stages `pendingClose` so the view can show the interrupt confirmation
     * (ticket 09). The actual close happens in `confirmClose`.
     *
     * @param {string} paneId
     * @returns {boolean} whether the pane closed immediately
     */
    closePane(paneId) {
      return closeFlow.requestClose(paneId)
    },
    /** Close the pane showing `sessionId` (the conversation fallbacks' exit). */
    closePaneBySession(sessionId) {
      const holder = book.locatePaneIn(sessionId)
      return holder === null ? false : closeFlow.requestClose(holder.paneId)
    },
    /**
     * Confirm a staged close: interrupt the running turn, then close the pane.
     * A failure is reported through `closeError` and the pane stays mounted.
     *
     * @returns {Promise<boolean>} whether the pane was closed
     */
    confirmClose() {
      return closeFlow.confirmClose()
    },
    /** Dismiss the staged close; the session and the layout are unchanged. */
    cancelClose() {
      return closeFlow.cancelClose()
    },
    /**
     * Pane-aware `/resume`: swap the focused pane's conversation without
     * touching the tree, the focus or the panel selection. If the session is
     * already mounted elsewhere, focus that pane (switching workspace when it
     * belongs to another one).
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
    newInFocused: newInFocusedValue,
    /**
     * Switch one pane's conversation view. The remembered choice lives on that
     * pane only; the tree, the focus and every retained reference are
     * untouched, and the session itself is not rebuilt (ticket 07).
     *
     * A trajectory request while developer tools are disabled is refused rather
     * than remembered as an unreachable selection; the segment is not rendered
     * for the same reason (spec §6).
     *
     * @param {string} paneId
     * @param {'chat'|'trajectory'} view
     * @returns {boolean}
     */
    setView(paneId, view) {
      if (disposed) return false
      const located = book.locatePane(paneId)
      if (located === null) return false
      const pane = located.pane
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
      return apply(
        layoutTree.setView(book.layoutOf(located.workspaceId), paneId, view),
        located.workspaceId,
      )
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
      const holder = book.locatePaneIn(sessionId)
      if (holder === null) return false
      const pane = book.layoutOf(holder.workspaceId).panes[holder.paneId]
      if (pane === undefined) return false
      if (pane.view === 'trajectory' && !isTrajectoryAvailable()) return false
      return activateView(pane, pane.view).ok === true
    },
    /** Whether the trajectory segment is offered (developer-tools gate). */
    isTrajectoryAvailable,
    subscribeViewAvailability,
    /**
     * Drag a separator: `path` addresses the split (a/b steps from the root).
     *
     *
     * @param {string[]} path
     * @param {number} ratio
     * @returns {boolean}
     */
    resize(path, ratio) {
      if (disposed) return false
      return apply(layoutTree.resize(book.activeLayout(), path, ratio))
    },
    /** Plugin unload / panel unregistration: release everything, restore native. */
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribePanel()
      unsubscribeEntryError()
      unsubscribeViewAvailability()
      unsubscribeCatalog()
      releaseAll()
      try {
        if (panelId() === PANEL_KEY) layout.selectPanel(null)
      } catch {
        // The layout may already be gone during shell teardown.
      }
      book.clear()
      snapshot = Object.freeze({
        ...snapshot,
        active: false,
        sessionId: null,
        error: null,
        workspaceId: null,
        layouts: {},
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
  UNSCOPED_WORKSPACE,
  probeConversationContent,
  derivePanePhase,
  createPaneController,
}
