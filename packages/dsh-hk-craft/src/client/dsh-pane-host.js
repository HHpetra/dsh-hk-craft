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
const { emptyLayout, readLayout, writeLayout } = require('./layout-store.js')

const MAIN_SLOT = 'main'
const PANEL_KEY = 'hkcraft.panes'
const PANE_SLOT = 'hkcraft.pane'
const CONTENT_FACTORY = 'conversation.content'
const PANE_SOURCE = 'hkcraftPane'
/** The single retention dsh reads as "the current session" (ui-workspace:867). */
const MAIN_SOURCE = 'mainView'
/**
 * Internal key for the memory-only layout used when no workspace can be
 * derived. It is not a workspace id: it never reaches storage or a slot prop.
 */
const UNSCOPED_WORKSPACE = '\u0000unscoped'

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
 * Persistence is best-effort and workspace-scoped (`layout-store.js`): every
 * change writes `dsh.hkcraft.layout.v1.<workspaceId>`, and a workspace's layout
 * is read back from that key the first time the workspace is shown. Panes whose
 * session is gone are dropped at restore time.
 *
 * @param {{ sessions: any, layout: any, slots: any, workspaces?: any, get?: (name: string) => any }} ctx
 * @param {{ nextPaneId?: () => string, storage?: any }} [options] `nextPaneId` is a
 *   deterministic id factory for tests; `storage` defaults to `localStorage`
 * @returns {any}
 */
function createPaneController(ctx, options = {}) {
  const sessions = ctx?.sessions
  const layout = ctx?.layout
  const slots = ctx?.slots
  const storage = options.storage === undefined ? defaultStorage() : options.storage

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
  /** @type {Record<string, object>} workspaceId → layout (ticket 08) */
  let layouts = {}
  /**
   * A layout whose workspace cannot be derived (a shell without a workspaces
   * service, or a test fake). It is memory-only: there is no key to persist it
   * under. Once a workspace is known, new panes land in the keyed map; a tree
   * that already lived here is not migrated.
   */
  let unscopedLayout = emptyLayout(null)
  /** The workspace whose tree is visible; null until one is known. */
  let activeWorkspaceId = null
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
  })

  function emit(patch) {
    const next = { ...snapshot, ...patch }
    const changed = Object.keys(next).some((key) => next[key] !== snapshot[key])
    if (!changed) return
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }

  /** The active workspace's layout (the memory-only layout when none is known). */
  function activeLayout() {
    return layoutOf(activeWorkspaceId)
  }

  /** @param {string|null} workspaceId */
  function layoutOf(workspaceId) {
    if (workspaceId === null) return unscopedLayout
    if (layouts[workspaceId] !== undefined) return layouts[workspaceId]
    return emptyLayout(workspaceId)
  }

  /** Every layout that currently owns panes, including the memory-only one. */
  function allLayouts() {
    const all = { ...layouts }
    if (unscopedLayout.root !== null || Object.keys(unscopedLayout.panes).length > 0) {
      all[UNSCOPED_WORKSPACE] = unscopedLayout
    }
    return all
  }

  /** The key the active layout lives under inside `allLayouts()`. */
  function activeKey() {
    return activeWorkspaceId === null ? UNSCOPED_WORKSPACE : activeWorkspaceId
  }

  /** The snapshot fields that mirror the active layout tree. */
  function statePatch(active) {
    const value = activeLayout()
    const focused = value.activePaneId === null ? undefined : value.panes[value.activePaneId]
    return {
      workspaceId: activeWorkspaceId,
      layouts,
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

  /** Every pane id currently loaded, across all workspaces. */
  function paneIdInUse(paneId) {
    for (const layoutValue of Object.values(allLayouts())) {
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
   * Make the retained references match every loaded layout and return the first
   * failure (or null). Stale references are released before new ones are
   * acquired, and the old `mainView` is always released before the new one is
   * taken. Panes of hidden workspaces stay retained under `hkcraftPane` only.
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
    for (const [paneId, held] of [...refs]) {
      const pane = desired.get(paneId)
      if (pane === undefined || pane.sessionId !== held.sessionId) {
        releaseHeld(held)
        refs.delete(paneId)
      }
    }
    for (const pane of desired.values()) {
      if (refs.get(pane.paneId) !== undefined) continue
      try {
        holdPane(pane)
      } catch (error) {
        failed.push({ paneId: pane.paneId, workspaceId: workspaceOfPane(nextLayouts, pane.paneId), error })
      }
    }

    const focused = focusedPaneOf(nextLayouts)
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
          failed.push({ paneId: focused.paneId, workspaceId: activeWorkspaceId, error })
        }
      }
    }
    return {
      failure: failed.length === 0 ? null : messageOf(failed[0].error),
      failed,
    }
  }

  /** @param {Record<string, object>} nextLayouts */
  function focusedPaneOf(nextLayouts) {
    const value = nextLayouts[activeKey()]
    if (value === undefined || value.activePaneId === null) return null
    return value.panes[value.activePaneId] ?? null
  }

  /**
   * @param {Record<string, object>} nextLayouts
   * @param {string} paneId
   * @returns {string}
   */
  function workspaceOfPane(nextLayouts, paneId) {
    for (const [workspaceId, value] of Object.entries(nextLayouts)) {
      if (value.panes[paneId] !== undefined) return workspaceId
    }
    return ''
  }

  /** Persist one workspace's layout; best-effort by design. */
  function persist(value) {
    writeLayout(storage, value)
  }

  /** Store one layout under the active workspace (or the memory-only slot). */
  function commitLayout(value) {
    if (activeWorkspaceId === null) unscopedLayout = value
    else layouts = { ...layouts, [activeWorkspaceId]: value }
    persist(value)
  }

  /** Apply a layout change atomically; a failed reconcile rolls back. */
  function apply(next, workspaceId = activeWorkspaceId) {
    const current = layoutOf(workspaceId)
    if (next === current) return false
    const previous = allLayouts()
    const proposed = { ...previous, [workspaceId === null ? UNSCOPED_WORKSPACE : workspaceId]: next }
    const { failure } = snapshot.active ? reconcileAll(proposed) : { failure: null }
    if (failure !== null) {
      if (snapshot.active) reconcileAll(previous)
      emit({ error: failure })
      return false
    }
    if (workspaceId === null) {
      unscopedLayout = next
    } else {
      layouts = { ...layouts, [workspaceId]: next }
    }
    persist(next)
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
   * Load a workspace's layout the first time it is shown: read its scoped key,
   * reconcile against the live catalog, give restored panes globally unique ids
   * and make the pruned result the persisted truth.
   *
   * @param {string} workspaceId
   * @returns {boolean}
   */
  function ensureWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    if (layouts[workspaceId] !== undefined) return true
    const restored = readLayout(storage, workspaceId, { knownSessionIds: knownSessionsOf(workspaceId) })
    const adopted = adoptPaneIds(workspaceId, restored)
    layouts = { ...layouts, [workspaceId]: adopted }
    persist(adopted)
    return true
  }

  /**
   * Restored pane ids came from a controller instance that knew nothing about
   * the other workspaces, so two keys can hold the same `pane-1`. Pane ids are
   * the renderer's element keys and the reference map's keys, so they must be
   * unique across all loaded workspaces.
   *
   * @param {string} workspaceId
   * @param {object} value
   * @returns {object}
   */
  function adoptPaneIds(workspaceId, value) {
    const taken = new Set()
    for (const [otherId, other] of Object.entries(allLayouts())) {
      if (otherId === workspaceId) continue
      for (const paneId of Object.keys(other.panes)) taken.add(paneId)
    }
    const mapping = new Map()
    for (const paneId of Object.keys(value.panes)) {
      if (taken.has(paneId)) mapping.set(paneId, nextPaneId())
    }
    return mapping.size === 0 ? value : layoutTree.renamePanes(value, mapping)
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
    const value = activeLayout()
    const paneId = value.activePaneId
    return paneId === null ? null : (value.panes[paneId] ?? null)
  }

  function focusedWorkspaceId() {
    if (activeWorkspaceId !== null) return activeWorkspaceId
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

  /** @param {string} paneId @returns {{workspaceId: string|null, pane: object}|null} */
  function locatePane(paneId) {
    const pane = unscopedLayout.panes[paneId]
    if (pane !== undefined) return { workspaceId: null, pane }
    for (const [workspaceId, value] of Object.entries(layouts)) {
      const found = value.panes[paneId]
      if (found !== undefined) return { workspaceId, pane: found }
    }
    return null
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
        emit({ ...statePatch(false), active: false, error: null })
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
    const located = locatePane(paneId)
    if (located === null) return false
    if (located.workspaceId !== activeWorkspaceId) {
      if (!switchWorkspaceValue(located.workspaceId)) return false
    }
    return apply(layoutTree.focus(layoutOf(located.workspaceId), paneId), located.workspaceId)
  }

  /** Close a pane by id; false when it is absent. */
  function closePaneValue(paneId) {
    if (disposed) return false
    const located = locatePane(paneId)
    if (located === null) return false
    return apply(layoutTree.close(layoutOf(located.workspaceId), paneId), located.workspaceId)
  }

  /** Replace the focused pane's session, focusing an existing holder instead. */
  function replaceFocusedValue(sessionId) {
    if (disposed || !registered) return false
    const value = activeLayout()
    const paneId = value.activePaneId
    if (paneId === null) return false
    const holder = locatePaneIn(sessionId)
    if (holder !== null) {
      return holder.paneId === paneId && holder.workspaceId === activeWorkspaceId
        ? true
        : focusPaneValue(holder.paneId)
    }
    const next = layoutTree.replaceSession(value, paneId, sessionId)
    if (next === value) return true
    return apply(next)
  }

  /** @param {string} sessionId */
  function locatePaneIn(sessionId) {
    const unscoped = layoutTree.paneOfSession(unscopedLayout, sessionId)
    if (unscoped !== undefined) return { workspaceId: null, paneId: unscoped }
    for (const [workspaceId, value] of Object.entries(layouts)) {
      const paneId = layoutTree.paneOfSession(value, sessionId)
      if (paneId !== undefined) return { workspaceId, paneId }
    }
    return null
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
    if (workspaceId === activeWorkspaceId) return true
    const previous = activeWorkspaceId
    activeWorkspaceId = workspaceId
    if (snapshot.active) {
      const { failure } = reconcileAll(allLayouts())
      if (failure !== null) {
        activeWorkspaceId = previous
        reconcileAll(allLayouts())
        emit({ error: failure })
        return false
      }
    }
    emit({ ...statePatch(snapshot.active), error: null })
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
    const previous = allLayouts()
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
      const target = sessionId ?? findCurrentSession(sessions)
      const targetWorkspace =
        target === undefined ? focusedWorkspaceId() : (workspaceOf(target) ?? focusedWorkspaceId())
      if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
        if (!ensureWorkspace(targetWorkspace)) {
          emit({ error: `cannot show workspace ${targetWorkspace}` })
          return false
        }
        activeWorkspaceId = targetWorkspace
      }

      const current = activeLayout()
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

      const previous = allLayouts()
      const proposed = { ...previous, [activeKey()]: next }
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
      commitLayout(next)
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
      emit({ ...statePatch(false), active: false, error: null })
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
      const located = locatePane(paneId)
      if (located === null) return false
      const origin = located.pane
      const workspaceId = located.workspaceId
      if (dir !== 'row' && dir !== 'col') return false

      let sessionId = options?.sessionId
      if (sessionId !== undefined) {
        const owningWorkspace = workspaceOf(sessionId)
        if (owningWorkspace !== undefined && workspaceId !== null && owningWorkspace !== workspaceId) {
          // A pane tree only holds sessions of one workspace (spec D3): show the
          // session in its own workspace instead of mounting it across trees.
          if (!ensureWorkspace(owningWorkspace)) {
            emit({ error: `cannot show workspace ${owningWorkspace}` })
            return false
          }
          const holder = locatePaneIn(sessionId)
          if (holder !== null) focusPaneValue(holder.paneId)
          else switchWorkspaceValue(owningWorkspace)
          return false
        }
        const holder = locatePaneIn(sessionId)
        if (holder !== null) {
          if (holder.paneId !== paneId || holder.workspaceId !== workspaceId) {
            focusPaneValue(holder.paneId)
          }
          return false
        }
      } else {
        const owningWorkspace =
          workspaceOf(origin.sessionId) ??
          (workspaceId === null ? undefined : layoutOf(workspaceId).workspaceId) ??
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
      const next = layoutTree.split(layoutOf(workspaceId), paneId, dir, pane)
      if (next === layoutOf(workspaceId)) return false
      return apply(next, workspaceId)
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
      const holder = locatePaneIn(sessionId)
      return holder === null ? false : closePaneValue(holder.paneId)
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
    async newInFocused(workspaceId) {
      if (disposed || !registered) return false
      if (!snapshot.active) return false
      const targetWorkspace = workspaceId ?? focusedWorkspaceId()
      if (typeof targetWorkspace !== 'string' || targetWorkspace === '') return false
      if (!ensureWorkspace(targetWorkspace)) return false
      if (targetWorkspace !== activeWorkspaceId) {
        if (!switchWorkspace(targetWorkspace)) return false
      }
      let sessionId
      try {
        sessionId = await createSession(targetWorkspace)
      } catch (error) {
        emit({ error: messageOf(error) })
        return false
      }
      const current = activeLayout()
      if (current.activePaneId !== null) return replaceFocusedValue(sessionId)
      const pane = { paneId: nextPaneId(), sessionId, view: layoutTree.DEFAULT_VIEW }
      return apply(layoutTree.openPane(current, pane), targetWorkspace)
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
      const located = locatePane(paneId)
      if (located === null) return false
      return apply(
        layoutTree.setView(layoutOf(located.workspaceId), paneId, view),
        located.workspaceId,
      )
    },
    /**
     * Drag a separator: `path` addresses the split (a/b steps from the root) of
     * the visible workspace.
     *
     * @param {string[]} path
     * @param {number} ratio
     * @returns {boolean}
     */
    resize(path, ratio) {
      if (disposed) return false
      return apply(layoutTree.resize(activeLayout(), path, ratio))
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
      layouts = {}
      unscopedLayout = emptyLayout(null)
      activeWorkspaceId = null
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
