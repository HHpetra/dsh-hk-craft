'use strict'

/**
 * The pane kernel: the layout book, the pane references, the one layout
 * transaction (`apply`), the aggregate snapshot, and the composition of the
 * holders that sit beside it (ADR-0017).
 *
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
 *   The service pair and the three snapshot fields it produces belong to
 *   `pane-panel.js`, not to this file.
 */

const { listWorkspaceConversations } = require('./dsh-sessions.js')
const { isWorkspaceConversation, nativeConversationId } = require('./dsh-workspaces.js')
const { openCatalog, readCatalogs } = require('./catalog.js')
const layoutTree = require('./layout-tree.js')
const { hasLayoutKey } = require('./layout-store.js')
const { createPaneLayouts, UNSCOPED_WORKSPACE } = require('./pane-layouts.js')
const { createSplitBudget } = require('./pane-budget.js')
const { createCloseFlow } = require('./pane-close.js')
const { createPaneLayout } = require('./pane-layout.js')
const { createRightbar } = require('./pane-panel.js')
const { messageOf } = require('./shared.js')
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
 * The workspace a cold start should show once both catalogs are ready.
 *
 * The shell's own restore prefers the session it retained as the main view,
 * then the workspace already on screen, then the one whose conversation was
 * updated most recently. Display order is only the last resort.
 *
 * A member whose `updatedAt` is zero contributes nothing: the catalog normalises
 * a missing timestamp to zero, and a workspace whose members are all timestamped
 * zero must still fall back to its own `createdAt`.
 *
 * @param {any} catalog the read model
 * @param {string|null|undefined} activeId
 * @returns {string|undefined}
 */
function bootWorkspaceId(catalog, activeId) {
  const fromMain = catalog.workspaceOf(catalog.current())
  if (fromMain !== undefined) return fromMain.id
  if (typeof activeId === 'string' && activeId !== '') return activeId
  let selected
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of catalog.workspaces()) {
    let latest = Number.NEGATIVE_INFINITY
    for (const row of catalog.sessionsOf(workspace.id)) {
      if (row.updatedAt > 0) latest = Math.max(latest, row.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY && typeof workspace.createdAt === 'number') {
      latest = workspace.createdAt
    }
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.id
      selectedTime = latest
    }
  }
  return selected
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
 * shown. The visible workspace id is remembered separately
 * (`dsh.hkcraft.active-workspace.v1`), so a plugin reload or restart restores
 * the tree that was on screen instead of dsh's native selection (ADR-0020).
 * Panes whose session is gone are dropped at restore time, and the prune
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

  /**
   * The read model over the shell's snapshots, at this instant.
   *
   * Every catalog question in this controller goes through here, so the module
   * never touches `byId`, `sessionIds`, `phase` or `retainedBy` itself. The
   * catalog memoises on the snapshot triple, so repeated calls inside one
   * transition share one instance without any caching on this side.
   *
   * @returns {any}
   */
  function catalogNow() {
    return openCatalog(readCatalogs(ctx))
  }

  /** @type {Map<string, {sessionId: string, pane: any, main: any}>} per paneId */
  const refs = new Map()
  /** @type {Set<() => void>} */
  const listeners = new Set()
  /** Per-workspace layouts, the visible workspace and persistence. */
  const book = createPaneLayouts({ storage, nextPaneId: () => nextPaneId() })
  /**
   * Pane creation and the pane cap (`pane-budget.js`). It owns `maxPanes`, the
   * in-flight split reservations and the first-pane guard; this kernel only
   * transacts the layouts it asks for. Created before the first snapshot so the
   * stored cap is in it from the start — no consumer ever sees a placeholder.
   */
  const budget = createSplitBudget({
    storage,
    book,
    isDisposed: () => disposed,
    isRegistered: () => registered,
    isActive: () => snapshot.active,
    emit: (patch) => emit(patch),
    republish: () => republish(),
    workspaceOf: (sessionId) => workspaceOf(sessionId),
    focusedWorkspaceId: () => focusedWorkspaceId(),
    ensureWorkspace: (workspaceId) => ensureWorkspace(workspaceId),
    apply: (next, workspaceId) => apply(next, workspaceId),
    freshPane: (sessionId) => freshPane(sessionId),
    openSessionPane: (layout, sessionId, workspaceId) => openSessionPane(layout, sessionId, workspaceId),
    focusPane: (paneId) => layoutRuntime.layout.focusPane(paneId),
    replaceFocused: (sessionId) => layoutRuntime.layout.replaceFocusedSession(sessionId),
    switchWorkspace: (workspaceId) => switchWorkspaceValue(workspaceId),
    createSession: (workspaceId) => createSession(workspaceId),
  })
  /**
   * The layout operations and the View switch (`pane-layout.js`). Two faces over
   * the transaction this kernel owns; created below, once `emit` and `apply`
   * exist, because the budget's callbacks come through it.
   *
   * @type {ReturnType<typeof createPaneLayout>|null}
   */
  let layoutRuntime = null
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
  /**
   * The first activation restored a pane this plugin had persisted. That tree
   * is the view the user was looking at, so boot settlement must not move the
   * focus to a different (older) conversation the shell still calls current.
   */
  let bootRestored = false
  /**
   * The native right bar, which owns its own state and snapshot fields
   * (`pane-panel.js`). Created below, once `emit` exists, because the panel
   * reports through the same publish path as everything else.
   *
   * @type {ReturnType<typeof createRightbar>|null}
   */
  let panel = null
  /**
   * The staged close flow (`pane-close.js`), which owns `pendingClose`,
   * `closeBusy` and `closeError`. Created below with the other holders.
   *
   * @type {ReturnType<typeof createCloseFlow>|null}
   */
  let close = null
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
    rightbarTools: Object.freeze([]),
    ...budget.snapshotPatch(),
    workspaceId: null,
    layouts: {},
    root: null,
    panes: {},
    activePaneId: null,
    pendingClose: null,
    closeBusy: false,
    closeError: null,
  })

  panel = createRightbar({ publish: (patch) => emit(patch ?? {}) })

  /** The fields a holder owns, merged into every publish after the caller's patch. */
  function holderPatch() {
    return {
      ...(panel === null ? {} : panel.snapshotPatch()),
      ...(close === null ? {} : close.snapshotPatch()),
      ...budget.snapshotPatch(),
    }
  }

  /**
   * Bump the snapshot identity without changing a field. `splitBlock` reads the
   * reservation map, which is not a snapshot field, so subscribers (the strip)
   * only re-read it when the identity moves.
   */
  function republish() {
    snapshot = Object.freeze({ ...snapshot })
    for (const listener of [...listeners]) listener()
  }

  function emit(patch) {
    const next = {
      ...snapshot,
      ...patch,
      ...holderPatch(),
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
      return catalogNow().workspaceOf(sessionId)?.id
    } catch {
      return undefined
    }
  }

  /**
   * The sessions that still exist in one workspace, from the shell's catalog.
   * `null` means "not loaded yet": restore keeps every pane instead of guessing.
   *
   * Both catalogs have to be ready before a missing session may be treated as
   * gone. The workspace catalog becomes `"ready"` before the session list does,
   * and membership on that early snapshot can still be empty, so pruning against
   * one half drops the workspace that was opened at startup and writes the empty
   * tree back. `catalog.complete()` is exactly that rule, in one place
   * (`ADR-0016`).
   *
   * @param {string} workspaceId
   * @returns {Set<string>|null}
   */
  function knownSessionsOf(workspaceId) {
    const catalog = catalogNow()
    if (catalog.complete() !== true) return null
    // Membership, not the join: a pane survives while the workspace still lists
    // its session, even if the session row has not been projected yet. A
    // workspace the host no longer lists answers with an empty set, which prunes
    // its restored tree — its stored key is about to be cleared anyway.
    return new Set(catalog.memberIds(workspaceId))
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
  /**
   * Membership used to drop vanished panes.
   *
   * A running conversation can disappear from one workspace snapshot while the
   * host reindexes that session's directory. Treating that gap as a delete
   * closes the pane and leaves an older, already finished conversation focused.
   * A session that is actually gone is not running, so the next catalog tick
   * still drops it.
   *
   * @param {string} workspaceId
   * @param {Set<string>|null} knownSessionIds
   * @returns {Set<string>|null}
   */
  function knownSessionsForPrune(workspaceId, knownSessionIds) {
    if (!(knownSessionIds instanceof Set)) return knownSessionIds
    const layout = book.layoutOf(workspaceId)
    let kept = null
    for (const pane of Object.values(layout.panes ?? {})) {
      if (!isSessionRunning(pane.sessionId) || knownSessionIds.has(pane.sessionId)) continue
      if (kept === null) kept = new Set(knownSessionIds)
      kept.add(pane.sessionId)
    }
    return kept ?? knownSessionIds
  }

  function pruneWorkspace(workspaceId, knownSessionIds) {
    const pruned = book.pruneCandidate(workspaceId, knownSessionsForPrune(workspaceId, knownSessionIds))
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
    const first = catalogNow().workspaces()[0]
    return first === undefined ? undefined : first.id
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
      return workspaceOrderOf(openCatalog(readCatalogs(ctx)))
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
      if (catalogNow().complete() !== true) {
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
      listWorkspaceConversations({ sessions, catalog: catalogNow() }, target).then(
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
   * The same projection, resolved once. Used by the empty state, which only
   * wants the first set of rows the catalogs can name.
   *
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
    const catalog = catalogNow()
    if (catalog.complete() !== true) return
    let active = book.getActiveWorkspaceId()
    // A workspace the ready catalog no longer lists is gone, even if its stored
    // tree survived (deleted outside this plugin). Drop it instead of keeping a
    // hidden pane retained under a host id that does not exist.
    if (typeof active === 'string' && active !== '' && catalog.workspace(active) === undefined) {
      book.forget(active)
      releaseOrphanedPanes()
      book.setActiveWorkspace(null)
      active = null
      bootOwned = true
    } else if (bootRestored && focusedPane() !== null) {
      // A restored tree is the view the user was looking at. Keep its focus even
      // when the conversation is still blank: dsh's current can name an older
      // native selection, and replacing the blank one is the same jump the
      // running/idle guard prevents elsewhere.
      bootSettled = true
      return
    }
    const target = bootOwned ? bootWorkspaceId(catalog, active) : active
    if (typeof target !== 'string' || target === '') return
    // Set before opening. Retaining the conversation notifies the session
    // list, which would otherwise re-enter this function.
    bootSettled = true
    if (active !== target && !switchWorkspaceValue(target)) return
    focusOrOpenWorkspaceConversation(target)
  }

  /** The catalog row of one session, or undefined when the shell no longer lists it. */
  function rowOf(sessionId) {
    return catalogNow().session(sessionId)
  }

  /**
   * A session is "running" when its published signal says so — the same bit the
   * sidebar's yellow light and the workspace status projection use
   * (`catalog.js:signal`, consumed by `workspace-status.js:workspaceLight`).
   */
  function isSessionRunning(sessionId) {
    return catalogNow().signal(sessionId).running === true
  }

  /** Close a pane by id; false when it is absent. */
  function closePaneValue(paneId) {
    if (disposed) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    return apply(layoutTree.close(book.layoutOf(located.workspaceId), paneId), located.workspaceId)
  }

  // The staged-close flow (interrupt first, then close) lives in
  // `pane-close.js`; it reads this kernel through the callbacks and owns the
  // three snapshot fields of the confirmation.
  close = createCloseFlow({
    sessions,
    getSnapshot: () => snapshot,
    publish: (patch) => emit(patch ?? {}),
    isDisposed: () => disposed,
    locatePane: (paneId) => book.locatePane(paneId),
    locateSession: (sessionId) => book.locatePaneIn(sessionId),
    rowOf,
    isSessionRunning,
    closePane: (paneId) => closePaneValue(paneId),
  })

  // The layout operations and the View switch (`pane-layout.js`). Two faces over
  // the transaction above; every mutation still goes through `apply`, so the
  // reference reconcile stays in exactly one place.
  layoutRuntime = createPaneLayout({
    book,
    layoutTree,
    apply: (next, workspaceId) => apply(next, workspaceId),
    emit: (patch) => emit(patch),
    isDisposed: () => disposed,
    isRegistered: () => registered,
    switchWorkspace: (workspaceId) => switchWorkspaceValue(workspaceId),
    paneReference: (paneId) => refs.get(paneId)?.pane,
    focusedWorkspaceId: () => focusedWorkspaceId(),
    viewSwitch,
    paneIdForStripIndex,
    openConversationItems,
  })

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
    close.clear()
    emit({
      ...statePatch(snapshot.active),
      error: null,
    })
    return true
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
    const catalog = catalogNow()
    const sessionId = nativeConversationId(catalog, workspaceId)
    if (sessionId === undefined) return false
    const layout = book.layoutOf(workspaceId)
    const focused = layout.activePaneId == null ? undefined : layout.panes[layout.activePaneId]
    const own = (candidate) => isWorkspaceConversation(catalog, workspaceId, candidate)
    // A turn that is still running has to stay put even when the catalog has
    // not marked it started yet, or still lists an older conversation as the
    // one a workspace click would reveal. Replacing it is how an in-progress
    // conversation lands on a finished one.
    if (focused !== undefined && (own(focused.sessionId) || isSessionRunning(focused.sessionId))) return false

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
    close.clear()
    emit({
      ...statePatch(snapshot.active),
      error: failure,
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
   *
   * A running conversation is left alone when the shell's current id names an
   * idle session. dsh keeps "current" on whichever session still has a
   * `mainView` retain, and the session restored at startup often still has
   * one. Following that id replaces the turn on screen with a conversation
   * that already finished.
   */
  function syncCurrent() {
    if (routingDepth > 0 || disposed || !snapshot.active) return
    const sessionId = currentSessionId()
    if (sessionId === null) return
    const focused = focusedPane()
    if (focused !== null && focused.sessionId === sessionId) return
    if (
      focused !== null &&
      isSessionRunning(focused.sessionId) &&
      !isSessionRunning(sessionId)
    ) {
      return
    }
    routingDepth += 1
    try {
      const holder = book.locatePaneIn(sessionId)
      if (holder !== null) {
        layoutRuntime.layout.focusPane(holder.paneId)
        return
      }
      if (book.activeLayout().activePaneId !== null) {
        layoutRuntime.layout.replaceFocusedSession(sessionId)
        return
      }
      face.activate(sessionId)
    } finally {
      routingDepth -= 1
    }
  }

  /**
   * The workspace a fresh controller should restore before it reads the shell's
   * current session.
   *
   * The per-workspace layout keys cannot say which tree was visible, so the
   * view layer remembers the id (`layout-store.js`). It is only a hint: a
   * workspace the ready catalog no longer lists, or one whose layout key went
   * away with a delete, is ignored and the shell's current session decides.
   *
   * @returns {string|null}
   */
  function rememberedWorkspaceId() {
    const remembered = book.getActiveWorkspaceId()
    if (typeof remembered !== 'string' || remembered === '') return null
    const catalog = catalogNow()
    if (catalog.complete() && catalog.workspace(remembered) === undefined) return null
    if (!book.hasWorkspace(remembered) && !hasLayoutKey(storage, remembered)) return null
    return remembered
  }

  /**
   * The focused pane's session in one loaded layout, or undefined when the
   * tree is empty.
   *
   * @param {string} workspaceId
   * @returns {string|undefined}
   */
  function focusedSessionOf(workspaceId) {
    const layout = book.layoutOf(workspaceId)
    if (layout.activePaneId === null) return undefined
    const pane = layout.panes[layout.activePaneId]
    return pane === undefined ? undefined : pane.sessionId
  }

  const face = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
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
     * Omitted `sessionId` restores the tree this plugin persisted. A plugin
     * reload or restart must show the conversation that was on screen; dsh's
     * current can still name an older native selection, so it is only the
     * fallback for a workspace with no restored pane. With panes already open,
     * a known session focuses its pane and an unknown one replaces the focused
     * pane's content. A session of another workspace switches the visible
     * workspace first.
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
      const explicit = typeof sessionId === 'string' && sessionId !== ''
      if (explicit) bootOwned = false
      ensureCatalogSubscription()
      refreshProbe()
      pruneLoadedWorkspaces()

      let target
      let targetWorkspace
      let fallbackTarget
      if (explicit) {
        target = sessionId
        targetWorkspace = workspaceOf(target) ?? focusedWorkspaceId()
      } else {
        // Restore the workspace this plugin itself persisted before following
        // the shell's current. A plugin reload builds a new controller while
        // dsh still points current at the native selection from before the
        // split view; that older conversation is not what the panes were
        // showing.
        const remembered = rememberedWorkspaceId()
        if (remembered !== null) {
          targetWorkspace = remembered
        } else {
          fallbackTarget = catalogNow().current()
          targetWorkspace =
            fallbackTarget === undefined
              ? focusedWorkspaceId()
              : (workspaceOf(fallbackTarget) ?? focusedWorkspaceId())
        }
      }

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
        if (!explicit) {
          // The restored focused pane is the view the user was looking at, even
          // when the workspace was picked from the shell's current. An empty
          // tree leaves the target open for the boot settlement (a remembered
          // empty workspace must not get another workspace's session).
          const restored = focusedSessionOf(targetWorkspace)
          if (restored !== undefined) {
            target = restored
            bootOwned = false
            bootRestored = true
          } else if (fallbackTarget !== undefined) {
            target = fallbackTarget
          }
        }
      }
      if (target === undefined && (typeof targetWorkspace !== 'string' || targetWorkspace === '')) {
        target = catalogNow().current()
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
      if (catalogNow().complete()) bootSettled = true
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
    /**
     * Pane creation and the pane cap: `split`, `newPane`, `openInNewPane`,
     * `newInFocused`, `setMaxPanes` and `splitBlock`. See `pane-budget.js`,
     * which owns the cap, the in-flight reservations and the first-pane guard.
     */
    budget,
    /**
     * The staged close: `request(paneId)` may only stage an interrupt dialog,
     * `bySession(sessionId)` finds the pane that holds a conversation,
     * `confirm()` / `cancel()` answer that dialog. See `pane-close.js`.
     */
    close,
    /**
     * The tree operations: `paneReference`, `focusedPane`, `focusPane`,
     * `focusPaneAt`, `paneIndexOf`, `swapPanes`, `replaceFocusedSession`,
     * `resize`. Every one of them goes through this kernel's `apply`.
     * See `pane-layout.js`.
     */
    layout: layoutRuntime.layout,
    /**
     * The chat/trajectory switch over the same tree: `setView`,
     * `restoreViewFor`, `isTrajectoryAvailable`, `subscribeViewAvailability`.
     */
    view: layoutRuntime.view,
    /**
     * The native right bar: `attach` / `attachTabs` / `toggle` / `openTool`
     * plus the three snapshot fields it owns. See `pane-panel.js`.
     */
    panel,
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
      panel.dispose()
      close.dispose()
      unsubscribeEntryError()
      layoutRuntime.dispose()
      unsubscribeCatalog()
      releaseAll()
      book.clear()
      snapshot = Object.freeze({
        ...snapshot,
        ...holderPatch(),
        active: false,
        sessionId: null,
        error: null,
        workspaceId: null,
        layouts: {},
        root: null,
        panes: {},
        activePaneId: null,
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
