'use strict'

/**
 * Sidebar workspace rows: which light a workspace carries, and which row is the
 * current one.
 *
 * Pure on purpose. It reads the `catalog` read model from `catalog.js`, the
 * enabled-workspace set, and — while split is active — the 可见工作区 id. No
 * pane controller and no dsh record shape reaches this file: an upstream rename
 * is a one-file fix in `catalog.js`, and every rule here stays unit-testable
 * in Node with plain fixtures.
 *
 * The 当前行 and the five-state light are separate answers. The light never
 * looks at the 可见工作区. The 当前行 does, because switching workspaces
 * replaces the pane tree and does not move dsh's current session, so the two
 * can name different workspaces (`GLOSSARY.md`, ADR-0020).
 *
 * Light precedence: red > yellow > green > idle > gray.
 *   red    a session in this workspace is waiting for the user (approval,
 *          question, plan review)
 *   yellow a session is running
 *   green  at least one conversation finished while you were not looking
 *          (dsh's `completionUnread`), and nothing is running or waiting
 *   idle   at least one conversation has started, and nothing is running,
 *          waiting or unread: the workspace is genuinely idle
 *   gray   the workspace was never opened in split, or every conversation in it
 *          is still blank
 *
 * Gray is not "nothing happened recently": it is the absence of a started
 * conversation. A workspace that was never opened in split is gray even while a
 * native session of it runs; the "enabled" gate lives in the projection below,
 * and the sidebar computes that gate from the pane controller's loaded/stored
 * layout keys.
 *
 * There is no error light. dsh exposes no "this turn failed" bit in the client
 * status map or the session summary, and reading a failure would mean opening
 * every session's history — which the sidebar must not do. See
 * `docs/upstream-contracts.md#session-summary-fields`.
 */

/** @typedef {'gray' | 'idle' | 'green' | 'yellow' | 'red'} WorkspaceLight */

const LIGHT_GRAY = 'gray'
const LIGHT_IDLE = 'idle'
const LIGHT_GREEN = 'green'
const LIGHT_YELLOW = 'yellow'
const LIGHT_RED = 'red'

/**
 * The light for one workspace given its members' signals, once the workspace is
 * known to be enabled.
 *
 * Red short-circuits: the first red-worthy member wins regardless of position,
 * so a workspace with a queued question never hides behind a finished sibling.
 * Yellow is remembered while scanning; green needs an unread completion, and
 * idle needs at least one started conversation. A workspace holding only fresh
 * blank sessions stays gray.
 *
 * @param {ReadonlyArray<{ running?: boolean, waiting?: boolean, started?: boolean, unread?: boolean } | null | undefined> | unknown} signals
 * @returns {WorkspaceLight}
 */
function workspaceLight(signals) {
  if (!Array.isArray(signals)) return LIGHT_GRAY
  let running = false
  let unread = false
  let started = false
  for (const signal of signals) {
    if (signal === null || signal === undefined || typeof signal !== 'object') continue
    if (signal.waiting === true) return LIGHT_RED
    if (signal.running === true) running = true
    if (signal.unread === true) unread = true
    if (signal.started === true) started = true
  }
  if (running) return LIGHT_YELLOW
  if (unread) return LIGHT_GREEN
  return started ? LIGHT_IDLE : LIGHT_GRAY
}

/**
 * Turn the caller's "enabled workspaces" value into a membership test.
 *
 * - a Set (or anything with `has`) is used as-is;
 * - an array of ids becomes a Set;
 * - `null`/`undefined`/anything else means "unknown", and every workspace counts
 *   as enabled: degrade to deriving green/yellow/red/gray from the
 *   sessions rather than painting the whole column gray).
 *
 * @param {unknown} enabledWorkspaces
 * @returns {(workspaceId: string) => boolean}
 */
function enabledLookup(enabledWorkspaces) {
  if (enabledWorkspaces === undefined || enabledWorkspaces === null) return () => true
  if (typeof enabledWorkspaces.has === 'function') {
    return (workspaceId) => enabledWorkspaces.has(workspaceId)
  }
  if (Array.isArray(enabledWorkspaces)) {
    const ids = new Set(enabledWorkspaces)
    return (workspaceId) => ids.has(workspaceId)
  }
  return () => true
}

/**
 * The workspace id whose pane tree is on screen.
 *
 * Same rule as `pane-view.js`'s `workspaceGroups`: the snapshot's workspace id
 * when that layout is loaded, otherwise the first loaded layout (the tree the
 * main area actually paints). An id with no loaded layouts falls through to
 * the snapshot's own workspace id, which may be null.
 *
 * @param {{ workspaceId?: string|null, layouts?: object|null }} state snapshot fields, not the controller
 * @returns {string|null|undefined}
 */
function shownWorkspaceId(state) {
  const entries = Object.entries(state.layouts ?? {})
  return state.workspaceId !== null && state.layouts?.[state.workspaceId] !== undefined
    ? state.workspaceId
    : (entries[0]?.[0] ?? state.workspaceId)
}

/**
 * The 可见工作区 the 当前行 should name.
 *
 * - `undefined` — no controller snapshot, or the snapshot says split is off.
 *   The row falls back to dsh's current session.
 * - `null` — split is on, but the screen is not showing a workspace pane tree.
 *   No row is current.
 * - a string — that workspace's tree is the one on screen, including the
 *   first-loaded-layout fallback above.
 *
 * @param {unknown} snapshot pane-controller snapshot; a plain object, never the controller
 * @returns {string|null|undefined}
 */
function visibleWorkspaceIdOf(snapshot) {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return undefined
  if (snapshot.active !== true) return undefined
  const shown = shownWorkspaceId(snapshot)
  if (typeof shown === 'string' && shown !== '') return shown
  return null
}

/**
 * Project the catalog into the rows the section renders.
 *
 * Archived sessions are excluded: they are not reachable from this sidebar any
 * more, so they must not keep a workspace red (or turn it green). An unready
 * workspace catalog yields no rows; an unready session list cannot prove that a
 * conversation finished, so every row is gray (names show up first, lights catch
 * up).
 *
 * `enabledWorkspaces` is the sidebar's "was this workspace ever opened in split"
 * set. A row whose workspace is not in it is gray regardless of its sessions.
 * Omitting it (or passing null) degrades to "all enabled", which only loses the
 * never-opened gray.
 *
 * `visibleWorkspaceId` is the 可见工作区 (`visibleWorkspaceIdOf`). Omit it,
 * or pass `undefined`, and the 当前行 stays on the workspace that holds dsh's
 * current session — the degrade path for "split is off" and "no controller".
 * A string names the row whose pane tree is on screen, even when that
 * disagrees with the current session, and even when the id is not in the
 * inventory (then no row is current: the sidebar must not point at a different
 * workspace than the one on screen). `null` is an active split with no
 * workspace tree showing, and likewise marks no row.
 *
 * @param {{workspaces: () => ReadonlyArray<{id: string, title: string}>, workspacesReady: () => boolean, sessionsReady: () => boolean, sessionsOf: (workspaceId: string) => ReadonlyArray<object>, signal: (sessionId: string) => object, current: () => string|undefined} | null | undefined} catalog the read model
 * @param {Set<string> | ReadonlyArray<string> | null | undefined} [enabledWorkspaces]
 * @param {string|null|undefined} [visibleWorkspaceId]
 * @returns {Array<{ workspaceId: string, title: string, light: WorkspaceLight, current: boolean }>}
 */
function projectWorkspaceSection(catalog, enabledWorkspaces, visibleWorkspaceId) {
  if (catalog === null || catalog === undefined) return []
  if (catalog.workspacesReady() !== true) return []
  const sessionsReady = catalog.sessionsReady() === true
  const followVisible = visibleWorkspaceId !== undefined
  const current = catalog.current()
  const isEnabled = enabledLookup(enabledWorkspaces)
  return catalog.workspaces().map((workspace) => {
    const rows = catalog.sessionsOf(workspace.id)
    const signals = []
    // A loading session list may keep the previous rows around; they cannot
    // prove that a conversation finished, so they contribute no signals.
    for (const row of sessionsReady ? rows : []) {
      if (row.archived === true) continue
      signals.push(catalog.signal(row.id))
    }
    return {
      workspaceId: workspace.id,
      title: workspace.title,
      light: isEnabled(workspace.id) ? workspaceLight(signals) : LIGHT_GRAY,
      current: followVisible
        ? workspace.id === visibleWorkspaceId
        : current !== undefined && rows.some((row) => row.id === current),
    }
  })
}

/**
 * The label for a workspace row. dsh stores the automatic first-use title as the
 * literal `default-workspace` and localizes it at display time.
 *
 * @param {unknown} title stored title
 * @param {string} localizedDefault the localized default name
 * @returns {string}
 */
function displayWorkspaceName(title, localizedDefault) {
  if (typeof title !== 'string' || title === '' || title === 'default-workspace') return localizedDefault
  return title
}

module.exports = {
  LIGHT_GRAY,
  LIGHT_IDLE,
  LIGHT_GREEN,
  LIGHT_YELLOW,
  LIGHT_RED,
  workspaceLight,
  shownWorkspaceId,
  visibleWorkspaceIdOf,
  projectWorkspaceSection,
  displayWorkspaceName,
}
