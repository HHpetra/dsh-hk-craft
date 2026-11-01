'use strict'

/**
 * Every dsh assumption this plugin makes about mounting a Session into the
 * central `main` area is recorded in `doc/upstream-contracts.md` (read against
 * the 0.2.0-rc.2 bundles; the `conversation.content` occurrence contract was
 * re-checked on the pinned 0.2.1-rc.5 train). The parts relevant here:
 *
 * - `main` is a keyed root slot. The frame renders `activePanelId ??
 *   "conversation"`. This plugin shadows the `conversation` cell at priority
 *   -1 and never calls `selectPanel`, so `activePanelId` stays null and the
 *   native right bar stays visible — `#shadowing-the-conversation-cell`.
 * - `selectPanel(null)` returns from a global panel (settings, plugins). It
 *   does not unmount this shadow, because the conversation cell was never
 *   selected away. `selectPanel('conversation')` is not null and would hide
 *   the right bar — `#main-keyed-slot-and-selectpanel`.
 * - A `main` entry that declares a non-root child gets `SessionProvider` and
 *   `renderSlot` in its kit, plus `renderFactorySlot` for
 *   `conversation.content` — `#sessionprovider-and-conversationcontent`.
 * - Retention is an independent reference per caller:
 *   `sessions.retain(id, { source })` … `reference.release()`. "Current
 *   session" is derived from the first row with `retainedBy.mainView > 0`, so
 *   the focused pane holds one `mainView` reference and every other pane holds
 *   a `hkcraftPane` reference only. The right bar follows that same mainView
 *   — `#retention-sources-and-the-single-mainview-derivation`.
 * - `sessions.create({ workspaceId })` publishes the catalog row before
 *   resolving and never reuses a blank session. Native reveal still moves
 *   the shell's current session; the pane host follows that current onto the
 *   focused pane instead of calling the reveal —
 *   `#creating-a-session-without-leaving-the-panel`.
 * - Workspace membership comes from the `workspaces.list` snapshot —
 *   `#workspace-catalog`.
 * - The right bar is visible only while `activePanelId === null`.
 *   `ctx.sidebarRight.toggleExpanded()` / `isExpanded()` are the public
 *   controls, and there is no expanded observable — `#sidebar-right-toggle`.
 */

const { listWorkspaceConversations, workspaceIdOf } = require('./dsh-sessions.js')
const { isWorkspaceConversation, nativeConversationId } = require('./dsh-workspaces.js')
const layoutTree = require('./layout-tree.js')
const { hasLayoutKey } = require('./layout-store.js')
const { createPaneLayouts, UNSCOPED_WORKSPACE } = require('./pane-layouts.js')
const {
  isPaneBudgetSpent,
  normalizeMaxPanes,
  paneCount,
  readMaxPanes,
  writeMaxPanes,
} = require('./pane-budget.js')
const { createCloseFlow } = require('./pane-close.js')
const { messageOf } = require('./shared.js')
const { mainSessionId } = require('./workspace-status.js')
const { neighbourWorkspaceId, workspaceOrderOf } = require('./workspace-order.js')
const { openConversationItems, paneIdForStripIndex } = require('./pane-strip.js')

const MAIN_SLOT = 'main'
/** The official conversation cell. Shadowing it leaves `activePanelId` null. */
const CONVERSATION_KEY = 'conversation'
/** Below the shipped conversation entry (priority 0), so this one renders. */
const MAIN_PANEL_PRIORITY = -1
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
 * `conversation` is optional: it is ui-conversation's own standard hook and a
 * pane is not one of its children, so the pane only has the Session summary.
 * A missing `conversation` must therefore mean "no active targets", not "no
 * Session" — treating it as a blank Session made every pane render the
 * Factory's `hero`/`settling` state instead of the live conversation (the
 * composer moved into the hero stack and lost its pinned seat).
 *
 * @param {{ sessionId?: string, session?: any, conversation?: any, summaryBlank?: boolean }} input
 * @returns {{ phase: 'blank'|'engaging'|'active'|'settling'|'hero', hero: boolean }}
 */
function derivePanePhase({ sessionId, session, conversation, summaryBlank }) {
  const shellPhase =
    session === undefined
      ? 'blank'
      : conversation?.activeTargets?.size > 0 ||
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
 * Whether one catalog snapshot is safe to treat as complete.
 *
 * dsh's lists start at `phase: "pending"` and become `"ready"` only after the
 * first successful pull. A missing `phase` is the plain test double and counts
 * as ready. Anything else — including `"pending"` and `"loading"` — is not a
 * basis for "this workspace has no conversations" or for dropping panes.
 *
 * @param {any} snapshot
 * @returns {boolean}
 */
function catalogReady(snapshot) {
  if (snapshot == null) return false
  if (snapshot.phase === undefined) return true
  return snapshot.phase === 'ready'
}

/**
 * The workspace a cold start should show once both catalogs are ready.
 *
 * The shell's own restore prefers the session it retained as the main view,
 * then the workspace already on screen, then the one whose conversation was
 * updated most recently. Display order is only the last resort.
 *
 * @param {any} workspacesSnapshot
 * @param {any} sessionsSnapshot
 * @param {string|null|undefined} activeId
 * @returns {string|undefined}
 */
function bootWorkspaceId(workspacesSnapshot, sessionsSnapshot, activeId) {
  const fromMain = workspaceIdOf(workspacesSnapshot, mainSessionId(sessionsSnapshot))
  if (fromMain !== undefined) return fromMain
  if (typeof activeId === 'string' && activeId !== '') return activeId
  const items = Array.isArray(workspacesSnapshot?.items) ? workspacesSnapshot.items : []
  const byId = sessionsSnapshot?.byId ?? {}
  let selected
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of items) {
    if (workspace === null || typeof workspace !== 'object') continue
    if (typeof workspace.workspaceId !== 'string' || workspace.workspaceId === '') continue
    let latest = Number.NEGATIVE_INFINITY
    const memberIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    for (const sessionId of memberIds) {
      const updated = byId[sessionId]?.updatedAt
      if (typeof updated === 'number' && Number.isFinite(updated)) latest = Math.max(latest, updated)
    }
    if (latest === Number.NEGATIVE_INFINITY) {
      const created = Date.parse(workspace.createdAt)
      if (Number.isFinite(created)) latest = created
    }
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

/**
 * @param {any} list
 * @returns {any}
 */
function readSnapshot(list) {
  try {
    return list?.getSnapshot?.()
  } catch (_error) {
    return undefined
  }
}

/**
 * @param {any} list
 * @param {() => void} listener
 * @returns {(() => void)|undefined}
 */
function subscribeList(list, listener) {
  if (list == null || typeof list.subscribe !== 'function') return undefined
  try {
    const dispose = list.subscribe(listener)
    return typeof dispose === 'function' ? dispose : undefined
  } catch (_error) {
    return undefined
  }
}

/**
 * Own the pane workspace: one layout per workspace, the focused pane of the
 * active workspace, one retained session reference per mounted pane, and
 * whether split mode is active. Split mode does not select a panel.
 *
 * Per-workspace scope (ticket 08): `layouts` is keyed by workspace id and every
 * transition targets one workspace's tree. Switching workspace only changes
 * which tree is visible — no pane is closed, no session is released, and every
 * pane of every loaded workspace stays retained (and mounted-but-hidden by the
 * view layer) so streaming output, scroll position and composer drafts survive.
 *
 * Pane creation (ADR-0009 budget, ADR-0011 widths): the new pane is inserted
 * to the right of the referenced pane and takes the focus, then every
 * horizontal ratio is rewritten so a pure row gives each pane `1 / n` of the
 * width. A dragged ratio lasts until the next horizontal split. A new pane is
 * refused once the workspace holds `maxPanes` panes (0 = unlimited). The cap
 * lives in `pane-budget.js` and is shared by the strip control and every
 * controller path.
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
  /**
   * The pane cap shared by every workspace (dsh's sidebar pane budget, made a
   * setting). Read once from storage; changing it only gates creating panes.
   */
  let maxPanes = readMaxPanes(storage)
  /**
   * Splits that have passed the budget check but are still awaiting
   * `sessions.create`. Counted with the open panes so a second entry cannot
   * also pass the check and create a session before the first one lands.
   *
   * @type {Map<string, number>}
   */
  const pendingSplits = new Map()
  /**
   * Empty workspaces whose first pane is still awaiting `sessions.create`.
   *
   * This is not a budget reservation: the first pane does not spend the split
   * cap. It only stops a second new-session request (empty-state button,
   * Ctrl+Shift+N, `+` / `newPane` with no focused pane) from calling
   * `sessions.create` again. When that first create returns, the pane is
   * written only if this same workspace is still empty.
   *
   * @type {Set<string>}
   */
  const pendingFirstPanes = new Set()
  let paneSeq = 0
  let registered = false
  let disposed = false
  /**
   * Cold start has not yet seen both catalogs ready. Until then the workspace
   * on screen is whatever `activate` could see, which may be ahead of the
   * session list. A switch or an explicit session activation opts out: that
   * choice is the one that should receive history when the list arrives.
   */
  let bootOwned = true
  let bootSettled = false
  /** `ctx.sidebarRight` when the shell has one. Optional; the strip hides without it. */
  let rightbar = null
  /**
   * How deep a controller-originated retain is. `uiSession` current
   * notifications that arrive from our own `mainView` retain must not route
   * again.
   */
  let routingDepth = 0
  /** `uiSession.adapter.current`, once attached. */
  let sessionCurrent = null
  let unsubscribeCurrent = () => {}
  let snapshot = Object.freeze({
    active: false,
    sessionId: null,
    probe: probeConversationContent(slots),
    error: null,
    rightbarAvailable: false,
    rightbarExpanded: false,
    maxPanes,
    /** `null` after a successful write; a string when the last write failed. */
    maxPanesError: null,
    workspaceId: null,
    layouts: {},
    root: null,
    panes: {},
    activePaneId: null,
    pendingClose: null,
    closeBusy: false,
    closeError: null,
  })

  function readRightbarExpanded() {
    try {
      return rightbar?.isExpanded?.() === true
    } catch {
      return false
    }
  }

  function emit(patch) {
    const next = {
      ...snapshot,
      ...patch,
      rightbarAvailable: rightbar !== null,
      rightbarExpanded: readRightbarExpanded(),
    }
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
   * Release the references of panes that no layout owns any more.
   *
   * Used when a whole workspace is deleted: the workspace's panes disappear
   * from `book.allLayouts()` at once, and releasing their `hkcraftPane`
   * generation is what unmounts the client side. It never touches the Host
   * session, so a running turn keeps running — the
   * interrupt route belongs to closing a pane, not to deleting a registration.
   */
  function releaseOrphanedPanes() {
    for (const [paneId, held] of [...refs]) {
      if (book.locatePane(paneId) !== null) continue
      releaseHeld(held)
      refs.delete(paneId)
    }
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
    routingDepth += 1
    try {
      return reconcileAllNow(nextLayouts)
    } finally {
      routingDepth -= 1
    }
  }

  function reconcileAllNow(nextLayouts) {
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

  /** A new pane record. The id is allocated here, once, at the moment of insertion. */
  function freshPane(sessionId) {
    return { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
  }

  /**
   * Open `sessionId` as the first pane of `layout`.
   *
   * `workspaceId` omitted uses the visible workspace, matching `apply`.
   *
   * @param {object} layout
   * @param {string} sessionId
   * @param {string|null} [workspaceId]
   * @returns {boolean}
   */
  function openSessionPane(layout, sessionId, workspaceId) {
    return apply(layoutTree.openPane(layout, freshPane(sessionId)), workspaceId)
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
   * The workspace catalog becomes `"ready"` before the session list does.
   * Membership on that early snapshot can still be empty, and the session rows
   * are not in `byId` yet. Pruning against either half drops the workspace
   * that was opened at startup and writes the empty tree back. Both catalogs
   * have to be ready before a missing session is treated as gone.
   *
   * @param {string} workspaceId
   * @returns {Set<string>|null}
   */
  function knownSessionsOf(workspaceId) {
    const workspacesSnapshot = readSnapshot(workspacesFace()?.list)
    if (workspacesSnapshot == null) return null
    if (workspacesSnapshot.phase !== 'ready' || !Array.isArray(workspacesSnapshot.items)) return null
    const sessionsSnapshot = readSnapshot(sessions?.list)
    if (!catalogReady(sessionsSnapshot)) return null
    const record = workspacesSnapshot.items.find((item) => item?.workspaceId === workspaceId)
    if (record === undefined) {
      // The workspace itself is gone; its stored tree has no home any more.
      return new Set()
    }
    const known = new Set(Array.isArray(record.sessionIds) ? record.sessionIds : [])
    if (sessionsSnapshot.phase !== 'loading') {
      for (const sessionId of Object.keys(sessionsSnapshot.byId ?? {})) known.add(sessionId)
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

  /**
   * Whether a workspace was ever opened in split. "Enabled"
   * is deliberately a layout fact, not a session fact: a workspace has a loaded
   * layout in this process or a persisted `dsh.hkcraft.layout.v1.<id>` key from an
   * earlier one. Opening the workspace in the native view never reaches this
   * controller and writes no key, so it does not count; entering split — by
   * clicking the workspace while panes show, by the footer toggle, or by any
   * action that restores a tree — does.
   *
   * The answer is a plain boolean and never throws: an unreadable store just
   * means "no key", which can only under-report enablement for that workspace.
   *
   * @param {string} workspaceId
   * @returns {boolean}
   */
  function isWorkspaceEnabledValue(workspaceId) {
    if (disposed) return false
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    return book.hasWorkspace(workspaceId) || hasLayoutKey(storage, workspaceId)
  }

  function refreshProbe() {
    emit({ probe: probeConversationContent(slots) })
  }

  /**
   * The host's workspace ids in display order. Used to pick the neighbour a
   * deleted workspace hands the view to, and as the fallback when the caller
   * did not capture the order before deleting.
   *
   * @returns {string[]}
   */
  function hostWorkspaceOrder() {
    try {
      return workspaceOrderOf(workspacesFace()?.list?.getSnapshot?.())
    } catch {
      return []
    }
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
   * The read waits until both catalogs are ready, then repeats on later
   * snapshots. A startup read against a pending session list used to resolve
   * to `[]`, and the empty state kept that as "no past conversations".
   *
   * @param {string} [workspaceId]
   * @param {(rows: object[]) => void} listener
   * @returns {() => void}
   */
  function watchConversationsValue(workspaceId, listener) {
    let stopped = false
    let armed = false
    let generation = 0
    const disposers = []
    const stop = () => {
      if (stopped) return
      stopped = true
      generation += 1
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch (_error) {
          // The store is shutting down; forgetting the listener is enough.
        }
      }
    }
    const requested = typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : undefined
    const publish = () => {
      if (!armed || stopped || disposed) return
      const sessionsSnapshot = readSnapshot(sessions?.list)
      const workspacesSnapshot = readSnapshot(workspacesFace()?.list)
      if (!catalogReady(sessionsSnapshot) || !catalogReady(workspacesSnapshot)) {
        // No subscription means the snapshot will not change; report the
        // point-in-time miss instead of waiting forever.
        if (disposers.length === 0) listener([])
        return
      }
      const target = requested ?? focusedWorkspaceId()
      const token = ++generation
      const deliver = (rows) => {
        if (stopped || token !== generation) return
        try {
          listener(Array.isArray(rows) ? rows : [])
        } catch (_error) {
          // The view has gone away.
        }
      }
      if (typeof target !== 'string' || target === '') {
        deliver([])
        return
      }
      listWorkspaceConversations({ sessions, workspaces: workspacesFace() }, target).then(
        deliver,
        () => deliver([]),
      )
    }
    const sessionsUnsub = subscribeList(sessions?.list, publish)
    const workspacesUnsub = subscribeList(workspacesFace()?.list, publish)
    if (sessionsUnsub !== undefined) disposers.push(sessionsUnsub)
    if (workspacesUnsub !== undefined) disposers.push(workspacesUnsub)
    armed = true
    publish()
    return stop
  }

  /**
   * @param {string} [workspaceId]
   * @returns {Promise<object[]>} raw conversation rows (never rejects)
   */
  function recentConversationsValue(workspaceId) {
    return new Promise((resolve) => {
      let settled = false
      let stop = () => {}
      stop = watchConversationsValue(workspaceId, (rows) => {
        if (settled) return
        settled = true
        resolve(rows)
        queueMicrotask(() => stop())
      })
    })
  }

  /**
   * Whether a pane may offer the trajectory View. Mirrors dsh's own gate
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
   * Follow the developer-tools gate so the View (and a remembered
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
   * Workspace and session catalog notifications.
   *
   * `workspaces.list` decides whether a restore may prune, and `sessions.list`
   * decides whether that membership is readable as conversations. The workspace
   * catalog turns `"ready"` first; subscribing to both means a session list
   * that arrives later still prunes and still fills the workspace that was
   * already on screen. The services can load after this plugin, so
   * subscription is retried from every action that reads a catalog.
   */
  const catalogDisposers = []
  /** @type {Set<any>} */
  const subscribedLists = new Set()
  function ensureCatalogSubscription() {
    if (disposed) return
    watchCatalogList(workspacesFace()?.list)
    watchCatalogList(sessions?.list)
  }

  /**
   * @param {any} list
   */
  function watchCatalogList(list) {
    if (list == null || typeof list.subscribe !== 'function') return
    if (subscribedLists.has(list)) return
    try {
      const dispose = list.subscribe(() => {
        pruneLoadedWorkspaces()
        settleBootWorkspace()
      })
      if (typeof dispose === 'function') {
        subscribedLists.add(list)
        catalogDisposers.push(dispose)
      }
    } catch (_error) {
      // A store that refuses subscription is simply not observed.
    }
  }

  function unsubscribeCatalog() {
    subscribedLists.clear()
    for (const dispose of catalogDisposers.splice(0)) {
      try {
        dispose()
      } catch (_error) {
        // The store is shutting down; forgetting the listener is enough.
      }
    }
  }

  /**
   * Both catalogs are ready to answer "which conversations does this workspace have".
   *
   * @returns {boolean}
   */
  function catalogsReadyNow() {
    return (
      catalogReady(readSnapshot(sessions?.list)) && catalogReady(readSnapshot(workspacesFace()?.list))
    )
  }

  /**
   * Finish the cold start once both catalogs can name conversations.
   *
   * `activate` runs as soon as the conversation shadow is registered, which is before dsh has
   * restored the session list. The workspace on screen then has an empty
   * history read and, unlike a later switch, never asks for one of its own
   * conversations. Doing that here — and only until the first ready snapshot,
   * or until the user picks a workspace — is what makes the startup workspace
   * behave like the ones switched to afterwards.
   */
  function settleBootWorkspace() {
    if (bootSettled || disposed || !registered || !snapshot.active) return
    if (!catalogsReadyNow()) return
    const { workspaces: workspacesSnapshot, sessions: sessionsSnapshot } = conversationCatalog()
    const active = book.getActiveWorkspaceId()
    const target = bootOwned ? bootWorkspaceId(workspacesSnapshot, sessionsSnapshot, active) : active
    if (typeof target !== 'string' || target === '') return
    // Set before opening. Retaining the conversation notifies the session
    // list, which would otherwise re-enter this function.
    bootSettled = true
    if (active !== target && !switchWorkspaceValue(target)) return
    focusOrOpenWorkspaceConversation(target)
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
   * The catalog snapshots the conversation picker reads, or empty when a
   * service is missing. A throw must not turn a workspace switch into an error.
   *
   * @returns {{workspaces: any, sessions: any}}
   */
  function conversationCatalog() {
    try {
      return {
        workspaces: workspacesFace()?.list?.getSnapshot?.(),
        sessions: sessions?.list?.getSnapshot?.(),
      }
    } catch (_error) {
      return { workspaces: undefined, sessions: undefined }
    }
  }

  /**
   * Make the visible workspace show one of its own conversations.
   *
   * Switching the tree is not enough: an empty tree, or a tree whose focused
   * pane still holds another workspace's session, leaves the previous
   * transcript on screen. This opens the workspace's latest conversation when
   * none of its panes already shows one, and focuses an existing one when the
   * focused pane does not. A tree that already shows one of its conversations
   * is left alone, so a split the user arranged is not rebuilt. Nothing here
   * calls the native reveal — that would move the shell's current session
   * instead of switching this workspace's tree.
   *
   * @param {string} workspaceId
   * @returns {boolean} whether the layout changed
   */
  function focusOrOpenWorkspaceConversation(workspaceId) {
    if (disposed) return false
    const { workspaces: workspacesSnapshot, sessions: sessionsSnapshot } = conversationCatalog()
    const sessionId = nativeConversationId(workspacesSnapshot, sessionsSnapshot, workspaceId)
    if (sessionId === undefined) return false
    const layout = book.layoutOf(workspaceId)
    const focused = layout.activePaneId == null ? undefined : layout.panes[layout.activePaneId]
    const own = (candidate) =>
      isWorkspaceConversation(workspacesSnapshot, sessionsSnapshot, workspaceId, candidate)
    if (focused !== undefined && own(focused.sessionId)) return false

    const holder = layoutTree.paneOfSession(layout, sessionId)
    if (holder !== undefined) {
      if (holder === layout.activePaneId) return false
      return apply(layoutTree.focus(layout, holder), workspaceId)
    }
    for (const pane of Object.values(layout.panes)) {
      if (!own(pane.sessionId) || pane.paneId === layout.activePaneId) continue
      return apply(layoutTree.focus(layout, pane.paneId), workspaceId)
    }
    if (layout.root === null || layout.activePaneId === null) {
      return openSessionPane(layout, sessionId, workspaceId)
    }
    return apply(layoutTree.replaceSession(layout, layout.activePaneId, sessionId), workspaceId)
  }

  /**
   * Re-retain every loaded workspace without touching the layout. Idempotent
   * while the conversation cell stays shadowed: nothing here selects a panel.
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
      // A failed re-retain already kept the previous pane references. Do not
      // reconcile an empty book: that would drop them while the host still
      // renders the layout.
      emit({ ...statePatch(true), active: true, error: failure })
      return false
    }
    emit({ ...statePatch(true), active: true, error: null })
    return true
  }

  /**
   * Resolve the workspace a new session for `pane` belongs to. A pane tree only
   * holds sessions of its own workspace (ADR-0005 D3); when the catalog cannot
   * name one, the pane's layout key is the fallback.
   *
   * @param {{sessionId: string}} pane
   * @param {string|null} workspaceId
   * @returns {string|undefined}
   */
  function newSessionWorkspaceOf(pane, workspaceId) {
    return (
      workspaceOf(pane.sessionId) ??
      (workspaceId === null ? undefined : book.layoutOf(workspaceId).workspaceId)
    )
  }

  /**
   * Create the conversation for a new pane and report a failure. Returns
   * `undefined` when no workspace can be resolved, the Host call fails, or the
   * controller was disposed while the call was in flight (the layout book is
   * already cleared then, and writing would resurrect a persisted pane).
   *
   * @param {{paneId: string, sessionId: string}} pane
   * @param {string|null} workspaceId
   * @param {string} action error verb, e.g. "split" or "add a pane"
   * @returns {Promise<string|undefined>}
   */
  async function createNewPaneSession(pane, workspaceId, action) {
    const owningWorkspace = newSessionWorkspaceOf(pane, workspaceId)
    if (owningWorkspace === undefined) {
      emit({ error: `cannot ${action}: pane ${pane.paneId} has no workspace` })
      return undefined
    }
    try {
      const sessionId = await createSession(owningWorkspace)
      return disposed ? undefined : sessionId
    } catch (error) {
      emit({ error: messageOf(error) })
      return undefined
    }
  }

  /** @param {string|null} workspaceId */
  function splitBudgetKey(workspaceId) {
    return workspaceId === null ? UNSCOPED_WORKSPACE : workspaceId
  }

  /** @param {string|null} workspaceId */
  function pendingSplitCount(workspaceId) {
    return pendingSplits.get(splitBudgetKey(workspaceId)) ?? 0
  }

  /**
   * Whether one workspace has spent its pane budget.
   *
   * Mirrors the dockkit rule dsh's right sidebar uses (`canSplit`): the count
   * is of docked panes in the surface, plus splits already committed to
   * creating a session, and the budget only blocks a *new* pane.
   *
   * @param {string|null} workspaceId
   * @returns {boolean}
   */
  function paneBudgetSpent(workspaceId) {
    const open = paneCount(book.layoutOf(workspaceId))
    return isPaneBudgetSpent(open + pendingSplitCount(workspaceId), maxPanes)
  }

  /**
   * `splitBlock` reads the reservation map, which is not a snapshot field.
   * Subscribers (the strip) only re-read it when the snapshot identity changes.
   */
  function publishPendingSplit() {
    snapshot = Object.freeze({ ...snapshot })
    for (const listener of [...listeners]) listener()
  }

  /** @param {string|null} workspaceId */
  function reserveSplit(workspaceId) {
    const key = splitBudgetKey(workspaceId)
    pendingSplits.set(key, pendingSplitCount(workspaceId) + 1)
  }

  /**
   * @param {string|null} workspaceId
   * @param {boolean} [publish] false when the caller is about to publish the
   *   layout itself, so the pane is not counted once as open and again as pending
   */
  function releaseSplit(workspaceId, publish = true) {
    const key = splitBudgetKey(workspaceId)
    const next = pendingSplitCount(workspaceId) - 1
    if (next <= 0) pendingSplits.delete(key)
    else pendingSplits.set(key, next)
    if (publish) publishPendingSplit()
  }

  /** Record a refused split. No pane is created and no session is requested. */
  function refuseSplitBudget() {
    emit({ error: `cannot split: the workspace pane limit (${maxPanes}) is reached` })
    return false
  }

  /**
   * Split `paneId` to the right (or down) and open (or create) the conversation
   * in the new pane.
   *
   * A horizontal split keeps the new pane as the reference pane's right
   * neighbour, then evens the row by the current pane count. A vertical split
   * still only halves the reference pane. Splitting is refused once the
   * workspace holds `maxPanes` panes (0 means unlimited); focusing a session
   * that is already mounted is never refused, because it adds no pane.
   *
   * @param {string} paneId
   * @param {'row'|'col'} dir
   * @param {{sessionId?: string}} [options]
   * @returns {Promise<boolean>}
   */
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
    }

    // Reserve before `sessions.create`. A later cap change does not cancel this
    // split; only a new request is judged against the new cap. The reservation
    // is dropped before the layout write, with no await in between, so another
    // caller cannot pass the check in the gap and subscribers never count the
    // new pane twice (once open, once still pending).
    //
    // `reservationHeld` is the cleanup duty while the create is in flight.
    // `publishRelease` is set once that reservation is dropped without a
    // snapshot, and cleared only after `apply` publishes. An unchanged tree
    // (`split` returns the same layout) and a throw from `apply` both leave it
    // set, so the strip learns the slot is free again.
    let reservationHeld = false
    let publishRelease = false
    try {
      if (sessionId === undefined) {
        if (paneBudgetSpent(workspaceId)) return refuseSplitBudget()
        reserveSplit(workspaceId)
        reservationHeld = true
        publishPendingSplit()
        sessionId = await createNewPaneSession(origin, workspaceId, 'split')
        if (sessionId === undefined) return false
      } else if (paneBudgetSpent(workspaceId)) {
        return refuseSplitBudget()
      }

      if (reservationHeld) {
        releaseSplit(workspaceId, false)
        reservationHeld = false
        publishRelease = true
      }

      const current = book.layoutOf(workspaceId)
      const next = layoutTree.split(current, paneId, dir, freshPane(sessionId))
      if (next === current) return false
      const applied = apply(next, workspaceId)
      publishRelease = false
      return applied
    } finally {
      if (reservationHeld) releaseSplit(workspaceId)
      else if (publishRelease) publishPendingSplit()
    }
  }

  /**
   * Pane-aware `/clear`: a new conversation in the focused pane, or the first
   * pane when that workspace is empty.
   *
   * While that first session is still being created, another new-session
   * request for the same empty workspace is ignored and does not call
   * `sessions.create`. After the pane is open, this replaces the focused
   * pane's conversation, and `newPane` splits beside it.
   *
   * When the first create returns, the pane is written only into the workspace
   * that was empty at the start, and only while that workspace still has no
   * panes. A pane opened while waiting is left alone, and the created session
   * stays in history. Switching away during the create does not pull the new
   * session into the visible workspace or switch the view back.
   *
   * @param {string} [workspaceId]
   * @returns {Promise<boolean>}
   */
  async function newInFocusedValue(workspaceId) {
    if (disposed || !registered) return false
    if (!snapshot.active) return false
    const targetWorkspace = workspaceId ?? focusedWorkspaceId()
    if (typeof targetWorkspace !== 'string' || targetWorkspace === '') return false
    if (!ensureWorkspace(targetWorkspace)) return false
    const openingFirst = book.layoutOf(targetWorkspace).root === null
    if (openingFirst && pendingFirstPanes.has(targetWorkspace)) return false
    if (openingFirst) pendingFirstPanes.add(targetWorkspace)
    try {
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
      if (disposed) return false
      if (openingFirst) {
        // Judge the workspace that started this create, not whichever tree is
        // visible now. A pane opened while waiting stays put. An empty tree
        // receives this session where it was requested, without switching the
        // visible workspace back.
        const origin = book.layoutOf(targetWorkspace)
        if (origin.root !== null) return false
        return openSessionPane(origin, sessionId, targetWorkspace)
      }
      const current = book.activeLayout()
      if (current.activePaneId !== null) return replaceFocusedValue(sessionId)
      return openSessionPane(current, sessionId, targetWorkspace)
    } finally {
      if (openingFirst) pendingFirstPanes.delete(targetWorkspace)
    }
  }

  /**
   * `+` on the strip: a new conversation in a pane to the right of the focused
   * one, with the row then divided evenly by the current pane count. With no
   * pane open this opens the first pane instead (the empty-state path). A
   * repeat while that first session is still being created is ignored. That
   * first pane is written only if this workspace is still empty when the
   * session returns.
   */
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
    // The strip and the command path only act while split mode is active;
    // outside it there is no visible pane to split beside.
    if (!snapshot.active) return false
    const targetWorkspace = workspaceOf(sessionId) ?? focusedWorkspaceId()
    if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
      // Load the target tree before deciding. An unloaded layout reads as empty,
      // which would both miss an already-mounted session and skip the cap.
      if (!ensureWorkspace(targetWorkspace)) return false
    }

    const holder = book.locatePaneIn(sessionId)
    if (holder !== null) {
      const here = book.getActiveWorkspaceId()
      const focused = book.activeLayout().activePaneId
      if (holder.workspaceId !== here || holder.paneId !== focused) {
        focusPaneValue(holder.paneId)
      }
      return false
    }

    if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
      const target = book.layoutOf(targetWorkspace)
      // The first pane of an empty workspace is not a split and is not capped.
      // A full workspace is refused here, before any switch: the visible
      // workspace stays put and no session is created.
      if (target.root !== null && paneBudgetSpent(targetWorkspace)) return refuseSplitBudget()
      if (targetWorkspace !== book.getActiveWorkspaceId() && !switchWorkspaceValue(targetWorkspace)) {
        return false
      }
    }
    const paneId = book.activeLayout().activePaneId
    if (paneId === null) return openSessionPane(book.activeLayout(), sessionId)
    return splitPane(paneId, 'row', { sessionId })
  }

  /**
   * Change the pane cap shared by every workspace and persist it.
   *
   * Invalid input falls back to the default (4); 0 means unlimited. Changing the
   * value never touches a live layout, so a workspace that already holds more
   * panes than the new cap simply cannot grow until panes are closed.
   *
   * A failed write does not throw and does not roll back the memory value. The
   * snapshot's `maxPanesError` is then a string (empty when storage itself is
   * missing) so the settings page can show a failure while `splitBlock` already
   * uses the new cap. A later successful write clears that field.
   *
   * @param {unknown} value non-negative integer, or 0 for unlimited
   * @returns {number} the normalised value now in effect
   */
  function setMaxPanesValue(value) {
    const next = normalizeMaxPanes(value)
    maxPanes = next
    const written = writeMaxPanes(storage, next)
    const maxPanesError = written.ok ? null : (written.message ?? '')
    emit({ maxPanes: next, maxPanesError })
    return maxPanes
  }

  /**
   * Why the workspace's split control is blocked, or undefined when it is
   * available. Mirrors the sidebar's `splitBlock()`: only the pane budget is
   * checked here (this plugin has no width-measuring rule).
   *
   * @param {string|null} [workspaceId] defaults to the visible workspace
   * @returns {'budget'|undefined}
   */
  function splitBlockValue(workspaceId) {
    if (disposed) return undefined
    const target = workspaceId ?? book.getActiveWorkspaceId()
    return paneBudgetSpent(target) ? 'budget' : undefined
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

  /**
   * The workspace that inherits the view when `deletedId` goes away: the next
   * one in host order, else the previous one, else none. Without a usable order,
   * fall back to the remaining loaded workspaces in load order.
   *
   * @param {string} deletedId
   * @param {string[]} order host display order, captured *before* the delete
   * @returns {string|null}
   */
  function neighbourWorkspaceIdFor(deletedId, order) {
    if (Array.isArray(order) && order.includes(deletedId)) {
      return neighbourWorkspaceId(order, deletedId)
    }
    // No order reached us (older shell, or the catalog already dropped the row):
    // fall back to the remaining loaded workspaces, in load order.
    const loaded = book.workspaceIds().filter((workspaceId) => workspaceId !== deletedId)
    return loaded.length === 0 ? null : loaded[0]
  }

  /**
   * Forget a deleted workspace.
   *
   * The adapter calls this only after the public `workspaces.delete(id)` has
   * resolved, so the registration is already gone. Here the local state follows:
   * - the workspace's layout is dropped and its persisted key removed, so the
   *   "enabled" inference cannot resurrect a ghost workspace;
   * - its panes' client references are released, unmounting them without ever
   *   interrupting the Host sessions (a running turn keeps running);
   * - if it was the visible workspace, the view moves to the next host-order
   *   workspace, else the previous one, else the empty no-workspace state;
   * - a new snapshot is published so the sidebar and the panes update together.
   *
   * An id that is neither loaded nor in the host order is a no-op, so a stale
   * click cannot clear somebody else's layout.
   *
   * @param {string} workspaceId
   * @param {{order?: string[]}} [options] host order captured before the delete
   * @returns {boolean} whether a known workspace was forgotten
   */
  function forgetWorkspaceValue(workspaceId, options = {}) {
    if (disposed) return false
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    const order = Array.isArray(options?.order)
      ? options.order.filter((item) => typeof item === 'string' && item !== '')
      : hostWorkspaceOrder()
    const wasLoaded = book.hasWorkspace(workspaceId)
    if (!wasLoaded && !order.includes(workspaceId)) return false

    const wasActive = book.getActiveWorkspaceId() === workspaceId
    const target = wasActive ? neighbourWorkspaceIdFor(workspaceId, order) : null

    book.forget(workspaceId)
    releaseOrphanedPanes()

    if (wasActive) {
      // While split mode is active, the neighbour has to be loaded before
      // the reconcile can retain its panes and take the single mainView. While it
      // is hidden, no reference exists; remembering the id is enough, and the
      // next activation restores the layout from its key.
      book.setActiveWorkspace(
        target !== null && snapshot.active ? (ensureWorkspace(target) ? target : null) : target,
      )
    }

    let failure = null
    if (snapshot.active) {
      const reconciled = reconcileAll(book.allLayouts())
      failure = reconciled.failure
    }
    emit({
      ...statePatch(snapshot.active),
      error: failure,
      pendingClose: null,
      closeBusy: false,
      closeError: null,
    })
    return true
  }

  function currentSessionId() {
    try {
      const key = sessionCurrent?.getSnapshot?.()?.key
      return typeof key === 'string' && key !== '' ? key : null
    } catch {
      return null
    }
  }

  /**
   * Land the shell's current session on the focused pane.
   *
   * A session that some pane already holds is focused, switching workspace
   * first when that pane is elsewhere. An unknown session replaces the focused
   * pane. With no pane open it becomes the first pane. Notifications caused by
   * this controller's own `mainView` retain are ignored.
   */
  function syncCurrent() {
    if (routingDepth > 0 || disposed || !snapshot.active) return
    const sessionId = currentSessionId()
    if (sessionId === null) return
    const focused = focusedPane()
    if (focused !== null && focused.sessionId === sessionId) return
    routingDepth += 1
    try {
      const holder = book.locatePaneIn(sessionId)
      if (holder !== null) {
        focusPaneValue(holder.paneId)
        return
      }
      if (book.activeLayout().activePaneId !== null) {
        replaceFocusedValue(sessionId)
        return
      }
      face.activate(sessionId)
    } finally {
      routingDepth -= 1
    }
  }

  const face = {
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
     * Whether a workspace was ever opened in split: a loaded layout or a
     * persisted layout key. The sidebar uses it to gate the four-state light; it
     * is not a dsh fact, it is this plugin's own record.
     *
     * @param {string} workspaceId
     * @returns {boolean}
     */
    isWorkspaceEnabled(workspaceId) {
      return isWorkspaceEnabledValue(workspaceId)
    },
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
    /**
     * Follow one workspace's conversation list across catalog updates.
     *
     * The listener is not called while either catalog is still loading, so a
     * startup read cannot stick on "no past conversations". It is called again
     * when a later snapshot fills membership in.
     *
     * @param {string} [workspaceId]
     * @param {(rows: object[]) => void} listener
     * @returns {() => void}
     */
    watchConversations(workspaceId, listener) {
      return watchConversationsValue(workspaceId, listener)
    },
    /** Called once the shadow `conversation` entry is registered. */
    markRegistered() {
      registered = true
      refreshProbe()
    },
    refreshProbe,
    /**
     * Enter or restore split mode for the workspace the target session belongs to.
     *
     * Omitted `sessionId` means "the session dsh currently treats as the
     * conversation". With panes already open in that workspace, a known session
     * focuses its pane and an unknown one replaces the focused pane's content.
     * A session of another workspace switches the visible workspace first.
     *
     * This never calls `layout.selectPanel`. The conversation cell is shadowed,
     * so `activePanelId` stays null. A failure still leaves split mode active
     * and records `error`, so the main area can explain it instead of going blank.
     *
     * @param {string} [sessionId]
     * @returns {boolean} whether the requested session is now the focused pane
     */
    activate(sessionId) {
      if (disposed) return false
      if (!registered) {
        emit({ error: 'pane main entry is not registered yet' })
        return false
      }
      if (typeof sessionId === 'string' && sessionId !== '') bootOwned = false
      ensureCatalogSubscription()
      refreshProbe()
      pruneLoadedWorkspaces()
      const target = sessionId ?? mainSessionId(sessions?.list?.getSnapshot?.())
      const targetWorkspace =
        target === undefined ? focusedWorkspaceId() : (workspaceOf(target) ?? focusedWorkspaceId())
      if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
        if (!ensureWorkspace(targetWorkspace)) {
          emit({
            ...statePatch(true),
            active: true,
            error: `cannot show workspace ${targetWorkspace}`,
          })
          return false
        }
        book.setActiveWorkspace(targetWorkspace)
      }

      const current = book.activeLayout()
      if (snapshot.active) {
        if (target === undefined) {
          emit({ ...statePatch(true), active: true, error: null })
          settleBootWorkspace()
          return true
        }
        const holder = layoutTree.paneOfSession(current, target)
        if (holder !== undefined && holder === current.activePaneId) {
          emit({ ...statePatch(true), active: true, error: null })
          settleBootWorkspace()
          return true
        }
      }

      let next = current
      if (next.root === null) {
        if (target !== undefined) {
          next = layoutTree.openPane(next, freshPane(target))
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
        emit({ ...statePatch(true), active: true, error: failure })
        return false
      }
      book.store(book.getActiveWorkspaceId(), next)
      emit({ ...statePatch(true), active: true, error: null })
      settleBootWorkspace()
      return true
    },
    /**
     * Show another workspace's layout without closing anything (spec D5).
     *
     * The tree switch alone does not change the transcript when the destination
     * has no panes, or when its focused pane still holds another workspace's
     * session. After the tree is visible, show one of this workspace's own
     * conversations in that case.
     *
     * @param {string} workspaceId
     * @returns {boolean} whether that workspace is now the active one
     */
    switchWorkspace(workspaceId) {
      // Claim the cold start before the switch reads the catalog. A store that
      // notifies inside `subscribe` would otherwise still treat this as boot
      // and move the view back. A refused id gives the claim back.
      const alreadyClaimed = !bootOwned
      bootOwned = false
      const switched = switchWorkspaceValue(workspaceId)
      if (!switched) {
        if (!alreadyClaimed) bootOwned = true
        return false
      }
      if (catalogsReadyNow()) bootSettled = true
      focusOrOpenWorkspaceConversation(workspaceId)
      return true
    },
    /**
     * Forget a workspace whose registration was just deleted.
     * Drops its layout, clears its persisted key, releases its pane references
     * (without interrupting the Host sessions) and moves a visible workspace to
     * its host-order neighbour. `options.order` is the pre-delete host order.
     *
     * @param {string} workspaceId
     * @param {{order?: string[]}} [options]
     * @returns {boolean}
     */
    forgetWorkspace(workspaceId, options) {
      return forgetWorkspaceValue(workspaceId, options)
    },
    /**
     * Re-retain every loaded workspace without changing the layout or selecting
     * a panel. Safe to call again while split mode is already active.
     *
     * @returns {boolean}
     */
    reactivate() {
      return reactivateValue()
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
     * The new pane sits to the right of `paneId`. A horizontal split then evens
     * the row by pane count, which replaces any dragged horizontal ratio. A
     * vertical split only halves the reference pane. Once the workspace has
     * `maxPanes` panes (and the cap is not 0), no pane is created.
     *
     * @param {string} paneId
     * @param {'row'|'col'} dir
     * @param {{sessionId?: string}} [options]
     * @returns {Promise<boolean>}
     */
    split: splitPane,
    /**
     * `+` on the pane strip: a new conversation in a pane split beside the
     * focused one. With no pane open this opens the first pane instead (the
     * empty-state path), so the button never dead-ends.
     *
     * @returns {Promise<boolean>}
     */
    newPane: newPaneValue,
    /**
     * `/resume` + Ctrl+Enter: open a chosen conversation in a new pane split
     * beside the focused one, leaving the current pane untouched. The
     * conversation is never mounted twice — an already-open one just takes the
     * focus. The pane budget applies exactly as it does to `split`. A refusal
     * leaves the visible workspace where it is.
     *
     * @param {string} sessionId
     * @returns {Promise<boolean>}
     */
    openInNewPane: openInNewPaneValue,
    /**
     * Change the workspace pane cap (0 = unlimited) and persist it. The strip
     * disables its split control at the same threshold.
     *
     * @param {unknown} value non-negative integer
     * @returns {number} the normalised cap now in effect
     */
    setMaxPanes: setMaxPanesValue,
    /**
     * Why the workspace cannot split right now, or undefined. The strip uses
     * `'budget'` to disable `+` with a reason.
     *
     * @param {string|null} [workspaceId]
     * @returns {'budget'|undefined}
     */
    splitBlock: splitBlockValue,
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
     * than remembered as an unreachable selection; the View is not rendered
     * for the same reason (ADR-0006).
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
    /** Whether the trajectory View is offered (developer-tools gate). */
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
    /**
     * Remember `ctx.sidebarRight`. A missing service hides the strip button.
     * The returned state is whatever `isExpanded()` says right now; the service
     * has no expanded subscription, so later emits re-read it.
     *
     * @param {any} service
     */
    attachRightbar(service) {
      rightbar = service ?? null
      emit({})
    },
    /**
     * Flip the native right bar. False when the service is missing or the call throws.
     *
     * @returns {boolean}
     */
    toggleRightbar() {
      if (rightbar === null) return false
      try {
        rightbar.toggleExpanded()
      } catch (error) {
        emit({ error: messageOf(error) })
        return false
      }
      emit({})
      return true
    },
    /**
     * Follow `uiSession.adapter.current` so a native current change lands in
     * the focused pane. Our own `mainView` retains notify this store too;
     * `routingDepth` drops those. Returns the unsubscribe.
     *
     * @param {any} current
     * @returns {() => void}
     */
    attachSessionSelection(current) {
      unsubscribeCurrent()
      unsubscribeCurrent = () => {}
      sessionCurrent = current ?? null
      if (sessionCurrent === null || typeof sessionCurrent.subscribe !== 'function') {
        sessionCurrent = null
        return () => {}
      }
      let unsubscribe = () => {}
      try {
        const result = sessionCurrent.subscribe(() => syncCurrent())
        if (typeof result === 'function') unsubscribe = result
      } catch (error) {
        sessionCurrent = null
        emit({ error: messageOf(error) })
        return () => {}
      }
      unsubscribeCurrent = () => {
        unsubscribe()
        if (sessionCurrent === current) sessionCurrent = null
      }
      return unsubscribeCurrent
    },
    /** Plugin unload: release everything. Unregistering the shadow hands `conversation` back. */
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeCurrent()
      unsubscribeCurrent = () => {}
      sessionCurrent = null
      rightbar = null
      unsubscribeEntryError()
      unsubscribeViewAvailability()
      unsubscribeCatalog()
      releaseAll()
      book.clear()
      snapshot = Object.freeze({
        ...snapshot,
        active: false,
        sessionId: null,
        error: null,
        rightbarAvailable: false,
        rightbarExpanded: false,
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
  return face
}

module.exports = {
  MAIN_SLOT,
  CONVERSATION_KEY,
  MAIN_PANEL_PRIORITY,
  PANE_SLOT,
  CONTENT_FACTORY,
  PANE_SOURCE,
  MAIN_SOURCE,
  UNSCOPED_WORKSPACE,
  probeConversationContent,
  derivePanePhase,
  createPaneController,
}
