'use strict'

/**
 * Sidebar workspace rows: which light a workspace carries, and which row is the
 * current one.
 *
 * Pure on purpose. dsh record shapes never reach this file — `dsh-workspaces.js`
 * turns live snapshots into the plain shapes below, so an upstream rename is a
 * one-file fix and every rule here stays unit-testable in Node.
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
 * `doc/upstream-contracts.md#session-summary-fields`.
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
 * One session's contribution to its workspace light.
 *
 * `waiting` is deliberately kind-agnostic: every value of dsh's pending
 * interaction union (approval / question / plan-review) is the user's move, and
 * an unknown future kind would still block that session. `started` is the
 * summary row's `blank` field inverted: only the Host knows whether a message was
 * ever sent, and a session's pending/running state never implies it. `unread`
 * comes from the shell's `completionUnread`, which is set when a non-current
 * session stops running and cleared when it becomes current or starts again.
 *
 * @param {{ running?: boolean, blank?: boolean } | undefined} summary session list row
 * @param {{ running?: boolean, pendingInteraction?: { kind?: string } | null, completionUnread?: boolean } | undefined} status unified UI status
 * @returns {{ running: boolean, waiting: boolean, started: boolean, unread: boolean }}
 */
function sessionSignal(summary, status) {
  const pending = status?.pendingInteraction
  return {
    running: status?.running === true || summary?.running === true,
    waiting: pending !== undefined && pending !== null,
    started: summary?.blank === false,
    unread: status?.completionUnread === true,
  }
}

/**
 * Read one entry out of dsh's status map (a `Map` in the shell, but plain
 * records are accepted so tests and future projections do not need a Map).
 *
 * @param {Map<string, unknown> | Record<string, unknown> | undefined} statuses
 * @param {string} sessionId
 * @returns {any}
 */
function readStatus(statuses, sessionId) {
  if (statuses === undefined || statuses === null) return undefined
  if (typeof statuses.get === 'function') return statuses.get(sessionId)
  return statuses[sessionId]
}

/**
 * The session the shell currently shows in the main view — dsh derives it from
 * the single `mainView` retention (see
 * `doc/upstream-contracts.md#retention-sources-and-the-single-mainview-derivation`).
 *
 * This is the one implementation of that scan; the pane host consumes it too.
 *
 * @param {{ byId?: Record<string, { id?: string, retainedBy?: { mainView?: number } }> } | undefined} sessions
 * @returns {string | undefined}
 */
function mainSessionId(sessions) {
  const byId = sessions?.byId ?? {}
  for (const key of Object.keys(byId)) {
    const row = byId[key]
    if (row === null || row === undefined) continue
    if ((row.retainedBy?.mainView ?? 0) > 0) return row.id ?? key
  }
  return undefined
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
 * Project the shell's workspace/session snapshots into the rows the section
 * renders.
 *
 * Archived sessions are excluded: they are not reachable from this sidebar any
 * more, so they must not keep a workspace red (or turn it green). Sessions dsh no
 * longer knows are skipped. An unready workspace snapshot yields no rows; an
 * unready session list cannot prove that a conversation finished, so every row is
 * gray (names show up first, lights catch up).
 *
 * `enabledWorkspaces` is the sidebar's "was this workspace ever opened in split"
 * set. A row whose workspace is not in it is gray regardless of its sessions.
 * Omitting it (or passing null) degrades to "all enabled", which only loses the
 * never-opened gray.
 *
 * @param {{ phase?: string, items?: ReadonlyArray<any>, archivedSessionIds?: ReadonlyArray<string> } | undefined} workspaces
 * @param {{ phase?: string, byId?: Record<string, any> } | undefined} sessions
 * @param {Map<string, any> | Record<string, any> | undefined} statuses
 * @param {Set<string> | ReadonlyArray<string> | null | undefined} [enabledWorkspaces]
 * @returns {Array<{ workspaceId: string, title: string, light: WorkspaceLight, current: boolean }>}
 */
function projectWorkspaceSection(workspaces, sessions, statuses, enabledWorkspaces) {
  if (workspaces?.phase !== 'ready') return []
  const items = Array.isArray(workspaces.items) ? workspaces.items : []
  const archived = new Set(workspaces.archivedSessionIds ?? [])
  const byId = sessions?.byId ?? {}
  // A snapshot that is still loading may keep the previous `byId` around; those
  // rows cannot prove that a conversation finished, so they contribute no
  // signals. An absent `phase` is the plain test/fake shape and counts as ready.
  const sessionsReady =
    sessions !== undefined && sessions !== null && (sessions.phase === undefined || sessions.phase === 'ready')
  const current = mainSessionId(sessions)
  const isEnabled = enabledLookup(enabledWorkspaces)
  return items.map((item) => {
    const memberIds = Array.isArray(item?.sessionIds) ? item.sessionIds : []
    const signals = []
    for (const sessionId of sessionsReady ? memberIds : []) {
      if (archived.has(sessionId)) continue
      const summary = byId[sessionId]
      if (summary === undefined || summary === null) continue
      signals.push(sessionSignal(summary, readStatus(statuses, sessionId)))
    }
    return {
      workspaceId: item?.workspaceId,
      title: item?.title,
      light: isEnabled(item?.workspaceId) ? workspaceLight(signals) : LIGHT_GRAY,
      current: current !== undefined && memberIds.includes(current),
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
  sessionSignal,
  readStatus,
  mainSessionId,
  projectWorkspaceSection,
  displayWorkspaceName,
}
