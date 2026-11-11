'use strict'

/**
 * The pane kernel: the layout book, the pane references, the one layout
 * transaction (`apply`), the aggregate snapshot, and the composition of the
 * holders that sit beside it (ADR-0017).
 *
 * Every dsh assumption this plugin makes about mounting a Session into the
 * central `main` area is recorded in `docs/upstream-contracts.md` (read against
 * the 0.2.0-rc.2 bundles; the `conversation.content` occurrence contract was
 * re-checked on the pinned 0.2.2-rc.1 train). The parts relevant here:
 *
 * - `main` is a keyed root slot. The frame renders `activePanelId ??
 *   "conversation"`. This plugin shadows the `conversation` cell at priority
 *   -1. The only `selectPanel` call is `returnToPanes`, and it passes `null`,
 *   so a 全局面板 closes without setting `activePanelId` to `"conversation"`
 *   (that would hide the right bar) — `#shadowing-the-conversation-cell`.
 * - `selectPanel(null)` returns from a 全局面板 (plugin manager, scheduled
 *   tasks). It does not unmount this shadow, because the conversation cell was
 *   never selected away. `selectPanel('conversation')` is not null and would
 *   hide the right bar — `#main-keyed-slot-and-selectpanel`.
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
const { browserStorage, messageOf } = require('./shared.js')
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
 * How long the cold start may stay undecided before the reveal gate opens
 * anyway. A shell whose catalogs never report ready must not leave the right
 * bar permanently detached from the panes, so the deadline is a fallback, not
 * the rule: a settled restore opens the gate as soon as both catalogs are ready.
 */
const BOOT_REVEAL_TIMEOUT_MS = 4000

/**
 * Probe the `conversation.content` Factory through the public slots snapshot.
 *
 * `ctx.slots.snapshot(root)` accepts `factory:<name>` and returns an array of
 * composition trees, or an empty array when the root is absent
 * (`docs/upstream-contracts.md#sessionprovider-and-conversationcontent`). An
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
      message: messageOf(error),
    }
  }
}

/**
 * The native Conversation's phase derivation, kept pure so the pane can pass
 * the same props the official main panel passes to `conversation.content`
 * (`docs/upstream-contracts.md#sessionprovider-and-conversationcontent`).
 *
 * `conversation` is optional: it is ui-conversation's own standard hook and a
 * pane is not one of its children, so the pane only has the Session summary.
 * A missing `conversation` must therefore mean "no active targets", not "no
 * Session" — treating it as a blank Session made every pane render the
 * Factory's `hero`/`settling` state instead of the live conversation (the
 * composer moved into the hero stack and lost its pinned seat).
 *
 * The live Session also starts conservatively blank, and stays that way until
 * the manager reconciles it. Once the history stream is open, `openState`
 * `"open"` would select the new-conversation hero even when the catalog
 * already knows a message was sent. That hero collapses the transcript and,
 * until a workspace title resolves, disables the composer. A catalog that
 * says the conversation has started keeps the transcript after open, and
 * stays on `settling` only while that stream is still loading.
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
  const knownHistory = summaryBlank === false
  const hero =
    sessionId === undefined ||
    (shellPhase === 'blank' && !knownHistory && (openState === 'open' || summaryBlank === true))
  const settling =
    sessionId !== undefined && shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true
  return { phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }
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
 *   additionally holds a `mainView` retention. A hidden workspace's panes keep
 *   their `hkcraftPane` retention only. `ui-workspace` also keeps a `mainView`
 *   on the native selection, and `uiSession.current` sticks to whichever
 *   session still has one, so the pane's retain alone does not move the right
 *   bar. While split is active, `revealFocusedPane` calls
 *   `uiWorkspace.openSession` for the focused pane so that native retain, and
 *   therefore the right bar, names the pane. That follows the pane (ADR-0020);
 *   it does not replace the pane with the previous current;
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
 *   tests (defaults to `browserStorage()`); `viewSwitch` is the conversation View
 *   adapter (ticket 07 — `dsh-view-switch.js`, tests inject a fake)
 * @returns {any}
 */
function createPaneController(ctx, options = {}) {
  const sessions = ctx?.sessions
  const slots = ctx?.slots
  const storage = options.storage === undefined ? browserStorage() : options.storage
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
   * Whether the plugin may move dsh's current session onto the focused pane.
   *
   * Closed from the first activation until the cold-start restore settles, so
   * a restart does not navigate the shell away from the session it restored
   * itself: doing that loads a second conversation and is what makes a start
   * feel slow. Explicit user actions open the gate immediately; a deadline
   * opens it when the catalogs never arrive.
   */
  let bootRevealSettled = false
  /** @type {ReturnType<typeof setTimeout>|null} */
  let bootRevealTimer = null
  /**
   * True for one frame after the first cold-start activation: the view mounts
   * the focused pane's conversation first and gives every other pane its
   * header only until the next frame. Ordering, not deferral — every pane still
   * mounts with its session retained (#13, option B).
   */
  let mountFocusedOnly = false
  /** Whether the one-frame window was already armed for this process. */
  let mountFocusedOnlyArmed = false
  /**
   * Sessions this controller created or placed before `workspaces.list` links
   * them. A ready catalog that does not list them yet is not a delete: pruning
   * on that gap closes the new-conversation pane on the same tick the row
   * appears.
   *
   * @type {Set<string>}
   */
  const pendingMembership = new Set()
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
  /**
   * True while `revealFocusedPane` is inside `uiWorkspace.openSession`.
   * That call notifies `uiSession` current, which would otherwise re-enter
   * `syncCurrent` and try to move the pane we just revealed.
   */
  let revealing = false
  /**
   * The focused/current pair `revealFocusedPane` already asked `openSession`
   * to fix. `revealing` only covers the synchronous call. A shell that reports
   * the same idle current on a later turn (the open did not move it) must not
   * be asked again, or the pull-back and the notification form a loop.
   *
   * @type {string|null}
   */
  let revealMiss = null
  /** Deferred retry for an explicit reveal that the shell had not applied yet. */
  let revealRetryTimer = null
  /**
   * The cold start wanted to reveal but `uiSession` was not attached yet.
   *
   * `uiWorkspace` and `uiSession` resolve independently, so the settlement can
   * run before the plugin can read the shell's current. The attach hook replays
   * this one deferred reveal; without it the right bar stays on the Session dsh
   * started with, and a tool opened from it uses that workspace's directory.
   */
  let revealDeferred = false
  /**
   * Last `mainView` counts read from the session list. A 新会话 retains
   * `mainView` on the new session without moving the sticky current, so a
   * count that grows on a session no pane holds is that arrival. `null` until
   * the list is first read.
   *
   * @type {Map<string, number>|null}
   */
  let mainViewBaseline = null
  /** Whether that baseline was read from a ready session list. */
  let mainViewBaselineReady = false
  /** A list notification arrived inside our own retain and is waiting. */
  let newSessionObserveScheduled = false
  /**
   * The 新会话 just placed, and the sticky current that must not swap it back
   * while that session is still the focused pane.
   *
   * @type {{ sessionId: string, stickyId: string }|null}
   */
  let newSessionGuard = null
  /** `uiSession.adapter.current`, once attached. */
  let sessionCurrent = null
  let unsubscribeCurrent = () => {}
  /**
   * `uiWorkspace`, once attached.
   *
   * The plugin's root context does not declare `uiWorkspace`, and Cordis only
   * exposes a service inside the `inject` scope that asked for it. Reading it
   * through `ctx.get` here therefore returned undefined and every reveal — the
   * one at boot, the one on a workspace switch, the one behind the right-bar
   * tool icons — silently did nothing. The client entry attaches the real face
   * from its own `ctx.inject(['uiWorkspace'])`.
   */
  let attachedWorkspace = null
  let snapshot = Object.freeze({
    active: false,
    sessionId: null,
    mountFocusedOnly: false,
    restoringPanes: false,
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

  panel = createRightbar({
    publish: (patch) => emit(patch ?? {}),
    reveal: () => revealFocusedSessionValue(),
  })

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
    revealFocusedPane()
  }

  /**
   * Whether at least one restored pane is still waiting for the session list.
   *
   * The view renders a pane whose reference is missing as "no conversation
   * selected", which is the truth for a closed or pruned pane but a lie while
   * the cold start is only waiting for `sessions.list`: the shell cannot retain
   * an id it has not published yet (`acquireMissingPaneReferences` retries once
   * it can). This bit lets the view say "opening" for that window instead.
   *
   * @returns {boolean}
   */
  function panesAwaitingCatalog(active) {
    if (!active) return false
    let complete
    try {
      complete = catalogNow().complete()
    } catch (_error) {
      return false
    }
    if (complete === true) return false
    for (const value of Object.values(book.allLayouts())) {
      for (const paneId of Object.keys(value.panes)) {
        if (refs.get(paneId) === undefined) return true
      }
    }
    return false
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
      mountFocusedOnly,
      restoringPanes: panesAwaitingCatalog(active),
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
    // same way the right sidebar does (see `docs/upstream-contracts.md`
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

    // Establish the focused pane's retention first, then the rest in layout
    // order (#13, option B): the shell opens a session as it is retained, so
    // the conversation on screen gets the head start instead of waiting behind
    // the whole tree.
    const focused = book.focusedPaneOf(nextLayouts)
    const ordered = []
    if (focused !== null) {
      const pane = desired.get(focused.paneId)
      if (pane !== undefined) ordered.push(pane)
    }
    for (const pane of desired.values()) {
      if (focused !== null && pane.paneId === focused.paneId) continue
      ordered.push(pane)
    }

    /** @type {Array<{sessionId: string, pane: any, main: undefined}>} */
    const acquired = []
    for (const pane of ordered) {
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
    const ids = new Set(catalog.memberIds(workspaceId))
    const layout = book.layoutOf(workspaceId)
    for (const pane of Object.values(layout.panes ?? {})) {
      const sessionId = pane?.sessionId
      if (typeof sessionId !== 'string' || ids.has(sessionId) || !pendingMembership.has(sessionId)) continue
      if (catalog.session(sessionId) === undefined) {
        pendingMembership.delete(sessionId)
        continue
      }
      const owner = catalog.workspaceOf(sessionId)
      if (owner !== undefined && owner.id !== workspaceId) {
        pendingMembership.delete(sessionId)
        continue
      }
      ids.add(sessionId)
    }
    for (const sessionId of [...pendingMembership]) {
      if (catalog.workspaceOf(sessionId) !== undefined) pendingMembership.delete(sessionId)
    }
    return ids
  }

  /** @param {string} sessionId */
  function notePendingMembership(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') pendingMembership.add(sessionId)
  }

  /**
   * Make one workspace's layout available, restoring it on first use.
   *
   * The restore prune can only run against a ready catalog. The first read keeps
   * every pane: pruning inside that read would drop a running session this
   * snapshot's membership omits, and persist that loss, before the
   * running-session guard can see the pane. `pruneWorkspace` applies the
   * catalog afterwards, and a later ready snapshot can prune again (spec §9).
   *
   * @param {string} workspaceId
   * @returns {boolean}
   */
  function ensureWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    ensureCatalogSubscription()
    const known = knownSessionsOf(workspaceId)
    if (!book.ensureWorkspace(workspaceId, null)) return false
    pruneWorkspace(workspaceId, known)
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
    // Creating a conversation is always a user action (/clear, 新会话, a split
    // entry); the right bar may follow it even during the cold-start window.
    openBootRevealGate()
    const sessionId =
      workspaceId === undefined ? await sessions.create({}) : await sessions.create({ workspaceId })
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('sessions.create returned no session id')
    }
    notePendingMembership(sessionId)
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
          message: messageOf(error),
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
    const sessionsList = list === sessions?.list
    // Seed before subscribe. A store that notifies immediately must not treat
    // the sessions already retaining mainView as a fresh 新会话.
    if (sessionsList) captureMainViewBaseline()
    try {
      const dispose = list.subscribe(() => {
        pruneLoadedWorkspaces()
        settleBootWorkspace()
        acquireMissingPaneReferences()
        if (sessionsList) noteNewSessionArrivals()
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
      markBootRevealSettled()
      return
    }
    const target = bootOwned ? bootWorkspaceId(catalog, active) : active
    if (typeof target !== 'string' || target === '') return
    // Set before opening. Retaining the conversation notifies the session
    // list, which would otherwise re-enter this function. A ready snapshot
    // whose rows are still stale blanks has not named any history; clearing
    // the flag lets the metadata correction open one. A pane already on
    // screen stays: a new conversation opened in that gap is not replaced.
    bootSettled = true
    if (active !== target && !switchWorkspaceValue(target)) {
      bootSettled = false
      return
    }
    if (focusedPane() === null) focusOrOpenWorkspaceConversation(target)
    if (focusedPane() === null) {
      bootSettled = false
      return
    }
    markBootRevealSettled()
  }

  /**
   * Retry the pane references a cold start could not take.
   *
   * `sessions.retain` throws `unknown session <id>` for a session the shell's
   * list has not published yet, and the restore runs before that first list.
   * The failed transaction leaves the restored panes in the layout with no
   * retained reference, and the view renders each of them as "no conversation
   * selected". The tree itself never changes again in that state — focusing an
   * already-focused pane is a no-op and a same-workspace switch returns early —
   * so nothing used to re-acquire them and a restart could stay empty.
   *
   * Both catalogs being readable is the point where the id is known, so the
   * acquire pass runs from the list subscription. A session that is really gone
   * is pruned before this runs and leaves no missing pane; an unchanged failure
   * publishes nothing, because `emit` drops a patch that changes no field.
   *
   * @returns {boolean} whether every loaded pane now holds a reference
   */
  function acquireMissingPaneReferences() {
    if (disposed || !registered || !snapshot.active) return false
    if (catalogNow().complete() !== true) return false
    const missing = Object.values(book.allLayouts()).some((value) =>
      Object.keys(value.panes).some((paneId) => refs.get(paneId) === undefined),
    )
    if (!missing) return false
    const { failure } = reconcileAll(book.allLayouts())
    emit({ ...statePatch(snapshot.active), error: failure })
    return failure === null
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
   * focused pane does not. A focused pane that still belongs to this workspace
   * stays, including a blank draft from `/clear`, so switching away and back
   * does not replace it with an older conversation. An archived session, or a
   * session that belongs to another workspace, is still replaced. Nothing here
   * calls the native reveal — that would move the shell's current session
   * instead of switching this workspace's tree.
   *
   * @param {string} workspaceId
   * @returns {boolean} whether the layout changed
   */
  function keepsFocusedSession(catalog, workspaceId, sessionId) {
    // A turn that is still running has to stay put even when this snapshot has
    // dropped it from membership. Replacing it is how an in-progress
    // conversation lands on a finished one.
    if (isSessionRunning(sessionId)) return true
    if (catalog.memberIds(workspaceId).includes(sessionId) !== true) return false
    return catalog.session(sessionId)?.archived !== true
  }

  function focusOrOpenWorkspaceConversation(workspaceId) {
    if (disposed) return false
    const catalog = catalogNow()
    const sessionId = nativeConversationId(catalog, workspaceId)
    if (sessionId === undefined) return false
    const layout = book.layoutOf(workspaceId)
    const focused = layout.activePaneId == null ? undefined : layout.panes[layout.activePaneId]
    const own = (candidate) => isWorkspaceConversation(catalog, workspaceId, candidate)
    if (focused !== undefined && keepsFocusedSession(catalog, workspaceId, focused.sessionId)) return false

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
   * `mainView` counts plus whether the session list is ready to trust them.
   *
   * A catalog that is still loading is not an arrival: those references were
   * already there. Only a count that grows after a ready baseline is a 新会话.
   *
   * @returns {{ map: Map<string, number>, ready: boolean }}
   */
  function readMainViewBaseline() {
    const map = new Map()
    let ready = false
    try {
      const catalog = catalogNow()
      ready = catalog.sessionsReady() === true
      for (const row of catalog.mainViewRetentions()) map.set(row.id, row.count)
    } catch (_error) {
      ready = false
    }
    return { map, ready }
  }

  function captureMainViewBaseline() {
    const reading = readMainViewBaseline()
    mainViewBaseline = reading.map
    mainViewBaselineReady = reading.ready
  }

  /**
   * Whether a 全局面板 is covering the conversation cell.
   *
   * `null` and a missing id are the pane view (`activePanelId ?? "conversation"`).
   * Anything else is a 全局面板. A throw means "don't guess": leave the panel
   * to dsh.
   *
   * @returns {boolean}
   */
  function globalPanelOpen() {
    try {
      const panelId = ctx?.layout?.panelInfo?.getSnapshot?.()?.activePanelId
      return panelId !== null && panelId !== undefined
    } catch (_error) {
      return false
    }
  }

  /**
   * Close a 全局面板 so the pane view shows again.
   *
   * The only `selectPanel` call in this plugin. It runs only while the shadow
   * is registered and split is active; otherwise dsh keeps the click. It never
   * passes `'conversation'`, because a non-null id hides the right bar.
   *
   * `force` is for an explicit user navigation (a workspace-row click). The
   * read of `panelInfo` is an optimisation, not evidence: when that face is
   * missing, throws or reports a stale id, skipping `selectPanel(null)` leaves
   * the panel covering the panes and the click looks dead. An explicit click
   * therefore always asks for the pane view, and upstream treats a request
   * while already there as a no-op. Without `force` the detection is kept,
   * because `placeNewSession` runs inside dsh's own `replaceMain` navigation
   * and closing a panel there must not abort that navigation.
   *
   * @param {{ force?: boolean }} [options]
   * @returns {boolean} whether the pane view is showing (or was already)
   */
  function returnToPanesValue(options = {}) {
    if (disposed || !registered || !snapshot.active) return false
    const select = ctx?.layout?.selectPanel
    if (typeof select !== 'function') return false
    if (options?.force !== true && !globalPanelOpen()) return true
    try {
      select(null)
    } catch (error) {
      emit({ error: messageOf(error) })
      return false
    }
    return true
  }

  /**
   * Put a 新会话 into the visible workspace.
   *
   * An idle focused pane is replaced. A running one keeps its turn and the new
   * session opens to its right, under the pane budget. An empty workspace gets
   * its first pane. ADR-0019 does not apply: that rule is for current drifting
   * onto an idle session, and this arrival is the click on 新会话.
   *
   * @param {string} sessionId
   * @returns {boolean} whether the session is now in a pane
   */
  function placeNewSession(sessionId) {
    if (disposed || !registered || !snapshot.active) return false
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (book.locatePaneIn(sessionId) !== null) return false
    notePendingMembership(sessionId)
    const stickyId = currentSessionId()
    returnToPanesValue()
    const layout = book.activeLayout()
    const focused = focusedPane()
    let placed = false
    if (focused === null || layout.root === null || layout.activePaneId === null) {
      placed = openSessionPane(layout, sessionId, book.getActiveWorkspaceId()) === true
    } else if (isSessionRunning(focused.sessionId)) {
      const pending = budget.split(focused.paneId, 'row', { sessionId })
      if (pending !== undefined && typeof pending.catch === 'function') {
        pending.catch((error) => {
          console.error('[dsh-hk-craft] failed to open 新会话 beside the running pane', error)
        })
      }
      placed = book.locatePaneIn(sessionId) !== null
    } else {
      placed = layoutRuntime.layout.replaceFocusedSession(sessionId) === true
    }
    if (placed && stickyId !== null && stickyId !== sessionId) {
      newSessionGuard = { sessionId, stickyId }
    }
    return placed
  }

  /**
   * Read `mainView` growth off the session list.
   *
   * While split is inactive the baseline still advances, so a later activation
   * does not replay arrivals dsh already handled. Notifications from our own
   * retain wait until the layout that caused them is stored.
   */
  function noteNewSessionArrivals() {
    if (disposed || !registered || !snapshot.active) {
      if (!disposed) captureMainViewBaseline()
      return
    }
    if (routingDepth > 0 || revealing) {
      scheduleNewSessionObserve()
      return
    }
    observeNewSessionArrivals()
  }

  function scheduleNewSessionObserve() {
    if (newSessionObserveScheduled) return
    newSessionObserveScheduled = true
    queueMicrotask(() => {
      newSessionObserveScheduled = false
      if (disposed) return
      if (routingDepth > 0 || revealing) {
        scheduleNewSessionObserve()
        return
      }
      observeNewSessionArrivals()
    })
  }

  function observeNewSessionArrivals() {
    if (disposed || !registered || !snapshot.active) return
    const reading = readMainViewBaseline()
    const previous = mainViewBaseline
    const previousReady = mainViewBaselineReady
    mainViewBaseline = reading.map
    mainViewBaselineReady = reading.ready
    // The first ready snapshot is the baseline. Loading finishing is not a click
    // on 新会话, and a list that is loading again cannot prove a count grew.
    if (!reading.ready || !previousReady || previous === null) return
    for (const [sessionId, count] of reading.map) {
      const before = previous.get(sessionId) ?? 0
      if (count > before) placeNewSession(sessionId)
    }
  }

  /** Drop the cold-start deadline, e.g. once the restore has settled or the plugin unloads. */
  function clearBootRevealTimer() {
    if (bootRevealTimer === null) return
    try {
      clearTimeout(bootRevealTimer)
    } catch (_error) {
      // A disposed host may have already torn the timer registry down.
    }
    bootRevealTimer = null
  }

  /**
   * Let the plugin move dsh's current session, without navigating yet.
   *
   * Explicit user actions (activating a session from the empty state, switching
   * the visible workspace, focusing a pane) call this so their reveal is never
   * held back by the cold-start rule.
   *
   * @returns {boolean} whether this call opened the gate
   */
  function openBootRevealGate() {
    if (bootRevealSettled) return false
    bootRevealSettled = true
    clearBootRevealTimer()
    return true
  }

  /**
   * The cold start has settled: open the gate and make the one compensating
   * reveal the plugin still owes the right bar.
   *
   * `revealFocusedPane` refuses when current already names the focused session,
   * so this is a no-op unless the two genuinely disagree. Called when the
   * restore lands (both catalogs ready) and from the deadline.
   */
  function markBootRevealSettled() {
    if (!openBootRevealGate()) return
    if (sessionCurrent === null) {
      // No `uiSession.current` to compare against yet. The attach hook replays
      // this once the shell current becomes readable; before that there is
      // nothing a reveal could move.
      revealDeferred = true
      return
    }
    revealFocusedPane()
  }

  /** Run one callback after the next frame, through the injected seam when present. */
  function scheduleNextFrame(callback) {
    if (typeof options?.scheduleFrame === 'function') {
      options.scheduleFrame(callback)
      return
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => callback())
      return
    }
    if (typeof setTimeout === 'function') {
      const handle = setTimeout(callback, 0)
      if (typeof handle?.unref === 'function') handle.unref()
    }
  }

  /**
   * Give the focused pane's conversation the first frame of a cold start.
   *
   * Only the first activation of this process arms it: reloading the shadow or
   * re-activating later must not re-defer the other panes. The next frame
   * publishes `mountFocusedOnly: false`, which mounts everything; no pane is
   * ever unmounted by this window.
   */
  function armFocusedOnlyMount() {
    if (mountFocusedOnlyArmed || disposed) return
    mountFocusedOnlyArmed = true
    mountFocusedOnly = true
    scheduleNextFrame(() => {
      if (disposed || !mountFocusedOnly) return
      mountFocusedOnly = false
      emit({ ...statePatch(snapshot.active), mountFocusedOnly })
    })
  }

  /**
   * Bound the cold start even when a catalog never reports ready.
   *
   * The deadline only opens the reveal gate; it never changes which workspace
   * the restore picked. `options.bootRevealTimeoutMs` is a test seam.
   */
  function startBootRevealDeadline() {
    if (bootRevealSettled || bootRevealTimer !== null) return
    const configured = options?.bootRevealTimeoutMs
    const timeout = Number.isFinite(configured) ? configured : BOOT_REVEAL_TIMEOUT_MS
    if (typeof setTimeout !== 'function' || !(timeout >= 0)) return
    bootRevealTimer = setTimeout(() => {
      bootRevealTimer = null
      markBootRevealSettled()
    }, timeout)
    if (typeof bootRevealTimer?.unref === 'function') bootRevealTimer.unref()
  }

  /**
   * Point the shell's current session at the focused pane.
   *
   * The right bar reads that current, not the pane. `ui-workspace` keeps its
   * own `mainView` on the native selection, so current stays there until
   * `openSession` moves it. The changes-review tab then asks for the pane's
   * event sequence under the native session and renders the missing copy.
   * Calling this after the pane is already focused makes current follow the
   * pane; `syncCurrent` still applies a later native current onto the pane.
   *
   * Nothing happens before the cold-start restore settles unless the caller is
   * an explicit user action (`force`): navigating during that window is what
   * made a restart load a second conversation.
   *
   * @param {{ force?: boolean }} [request] `force` is a user-initiated reveal
   * @returns {boolean} whether `openSession` was called
   */
  function revealFocusedPane(request = {}) {
    if (revealing || routingDepth > 0 || disposed || !snapshot.active) return false
    const forced = request?.force === true
    if (forced) {
      // An explicit user action is allowed to move current during the cold
      // start, and must be allowed to retry a pair an earlier automatic attempt
      // gave up on: that earlier attempt may have run before the shell could
      // mount the Session view.
      openBootRevealGate()
      revealMiss = null
    } else if (!bootRevealSettled) return false
    if (sessionCurrent === null) return false
    revealDeferred = false
    const focused = focusedPane()
    const sessionId = focused?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const currentId = currentSessionId()
    if (currentId === sessionId) {
      revealMiss = null
      return false
    }
    const miss = `${sessionId}\0${currentId ?? ''}`
    if (!forced && revealMiss === miss) return false
    const face = uiWorkspaceFace()
    if (face == null || typeof face.openSession !== 'function') return false
    let opened = false
    revealing = true
    try {
      // Call through the face: `openSession` is a prototype method and reads
      // `this.replaceMain`, so a detached call throws instead of navigating.
      face.openSession(sessionId)
      opened = true
      /**
       * Remember the pair only once the shell accepted the navigation. Its
       * refusal is not "already settled": a cold start can call this before
       * `sessions.list` publishes a restored Session (`sessions.retain:
       * unknown session <id>`). Keeping the miss then silences every later
       * automatic reveal for that pair, and the right bar stays on the Session
       * this plugin replaced — the workspace its terminal then opens in.
       */
      revealMiss = miss
    } catch (error) {
      console.error('[dsh-hk-craft] failed to show the focused session in the right bar', error)
      revealMiss = null
    } finally {
      revealing = false
    }
    if (opened && currentSessionId() === sessionId) revealMiss = null
    // A shell that refused the navigation (`sessions.retain: unknown session`
    // while its list is still loading) has not been moved at all: ask again on
    // the next frames until it can. A call it accepted but did not apply is
    // the loop `revealMiss` exists for, so that case is not retried here.
    if (!forced && !opened && bootRevealSettled) scheduleFocusedReveal()
    return opened
  }

  /**
   * One explicit reveal, plus the bounded follow-up that catches a shell still
   * mounting the previous Session.
   *
   * Shared by the public controller method and the right-bar panel's open wait,
   * so a tool click right after a workspace switch keeps asking until the bar
   * has adopted the focused Session.
   *
   * @returns {boolean} whether `openSession` was called on this attempt
   */
  function revealFocusedSessionValue() {
    const revealed = revealFocusedPane({ force: true })
    scheduleFocusedReveal()
    return revealed
  }

  /** Drop a pending explicit-reveal retry without touching the shell. */
  function clearRevealRetry() {
    if (revealRetryTimer === null) return
    try {
      clearTimeout(revealRetryTimer)
    } catch (_error) {
      // A disposed host may already have torn the timer registry down.
    }
    revealRetryTimer = null
  }

  /**
   * Retry one explicit reveal until the shell current names the focused pane.
   *
   * `uiWorkspace.openSession` moves current synchronously in the shell's store
   * but the right bar's Session view and its adopted layout mount on a later
   * render. A single attempt can therefore be too early: the bar keeps the
   * previous workspace's Session, and opening a tool from there creates the
   * terminal in that Session's directory. This bounded retry closes that gap
   * without fighting a later user navigation (it stops as soon as the focused
   * pane changes) or a shell that truly refuses to move current.
   *
   * @param {number} [attempts] - remaining retries after the first frame.
   * @returns {boolean} whether a target Session was scheduled.
   */
  function scheduleFocusedReveal(attempts = 6) {
    if (disposed || !snapshot.active) return false
    const target = focusedPane()?.sessionId
    if (typeof target !== 'string' || target === '') return false
    openBootRevealGate()
    clearRevealRetry()
    const attempt = (remaining) => {
      if (disposed || focusedPane()?.sessionId !== target || currentSessionId() === target) return
      revealFocusedPane({ force: true })
      if (currentSessionId() === target || remaining <= 0) return
      revealRetryTimer = setTimeout(() => {
        revealRetryTimer = null
        attempt(remaining - 1)
      }, 200)
      if (typeof revealRetryTimer?.unref === 'function') revealRetryTimer.unref()
    }
    scheduleNextFrame(() => attempt(attempts))
    return true
  }

  function uiWorkspaceFace() {
    if (attachedWorkspace !== null) return attachedWorkspace
    try {
      if (typeof ctx?.get === 'function') return ctx.get('uiWorkspace')
      return ctx?.uiWorkspace
    } catch (_error) {
      // A service that this context did not inject is not an error here: the
      // caller treats an absent navigation face as "nothing to reveal".
      return undefined
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
   * that already finished. The right bar is pulled back onto that running
   * pane instead.
   */
  function syncCurrent() {
    if (revealing || routingDepth > 0 || disposed || !snapshot.active) return
    const sessionId = currentSessionId()
    if (sessionId === null) return
    const focused = focusedPane()
    // A 新会话 just took the focused pane. The sticky current still names the
    // session that pane was showing; following it would swap the new one back
    // out. A later current that names some other session is a real navigation.
    if (newSessionGuard !== null) {
      const showingNew = focused !== null && focused.sessionId === newSessionGuard.sessionId
      if (!showingNew) {
        newSessionGuard = null
      } else if (sessionId === newSessionGuard.stickyId) {
        return
      } else if (sessionId !== newSessionGuard.sessionId) {
        newSessionGuard = null
      }
    }
    if (focused !== null && focused.sessionId === sessionId) return
    if (
      focused !== null &&
      isSessionRunning(focused.sessionId) &&
      !isSessionRunning(sessionId)
    ) {
      // The running pane stays. Pull current back to it so the right bar does
      // not stay on the idle session the shell still names.
      revealFocusedPane()
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
      activateValue(sessionId)
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

  /**
   * Enter or restore split mode. The face method is the contract; this is the
   * body, so `syncCurrent` can call it without going back out through `face`.
   *
   * @param {string} [sessionId]
   * @returns {boolean}
   */
  function activateValue(sessionId) {
    if (disposed) return false
    if (!registered) {
      emit({ error: 'pane main entry is not registered yet' })
      return false
    }
    const explicit = typeof sessionId === 'string' && sessionId !== ''
    if (explicit) {
      bootOwned = false
      // A user action, not the cold start: its reveal must not wait for the
      // restore to settle, and it mounts every pane at once.
      openBootRevealGate()
      if (mountFocusedOnly) {
        mountFocusedOnly = false
        mountFocusedOnlyArmed = true
      }
    } else {
      startBootRevealDeadline()
      armFocusedOnlyMount()
    }
    ensureCatalogSubscription()
    refreshProbe()
    pruneLoadedWorkspaces()

    let target
    let targetWorkspace
    let fallbackTarget
    const previousWorkspaceId = book.getActiveWorkspaceId()
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
    // Already showing this session in the workspace that is on screen: nothing
    // to retain. A workspace change still has to reconcile, even when the
    // stored focus is already the requested session — otherwise that tree is
    // published with no pane references and mainView stays on the old one.
    const workspaceUnchanged = book.getActiveWorkspaceId() === previousWorkspaceId
    if (snapshot.active && workspaceUnchanged) {
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
    /**
     * Close a 全局面板 and show the pane view again.
     *
     * This is the explicit-navigation face (a workspace-row click), so it
     * always asks for the pane view instead of trusting a `panelInfo` read.
     * The call is a no-op when this plugin does not own the conversation cell
     * (shadow not registered or split inactive). Never selects `'conversation'`.
     *
     * @returns {boolean}
     */
    returnToPanes() {
      return returnToPanesValue({ force: true })
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
      return activateValue(sessionId)
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
      // An explicit user switch: let the right bar follow this workspace's
      // focused pane from now on, even before both catalogs are ready.
      openBootRevealGate()
      if (catalogNow().complete()) bootSettled = true
      focusOrOpenWorkspaceConversation(workspaceId)
      revealFocusedPane()
      scheduleFocusedReveal()
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
      // `uiWorkspace` and `uiSession` resolve independently, so the boot
      // settlement can run before this face exists. That attempt could not
      // read the shell current and deferred itself; replay it now.
      if (revealDeferred && bootRevealSettled) {
        revealDeferred = false
        revealFocusedPane()
      }
      return unsubscribeCurrent
    },
    /**
     * Remember `uiWorkspace`, the face that moves the shell current (and so the
     * native right bar) onto the focused pane. Must come from the client
     * entry's `ctx.inject(['uiWorkspace'])`: the root context cannot see it.
     *
     * @param {any} face `uiWorkspace`, or null to detach
     * @returns {() => void} detaches this exact face
     */
    attachWorkspace(face) {
      attachedWorkspace = face ?? null
      return () => {
        if (attachedWorkspace === face) attachedWorkspace = null
      }
    },
    /**
     * Make the shell current, and therefore the right bar, name the focused
     * pane. A no-op when they already agree or no workspace service is attached.
     *
     * @returns {boolean}
     */
    revealFocusedSession() {
      return revealFocusedSessionValue()
    },
    /** Plugin unload: release everything. Unregistering the shadow hands `conversation` back. */
    dispose() {
      if (disposed) return
      disposed = true
      clearBootRevealTimer()
      clearRevealRetry()
      revealDeferred = false
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
        mountFocusedOnly: false,
        restoringPanes: false,
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
