'use strict'

/**
 * Sidebar workspace rows: which light a workspace carries, and which row is the
 * current one.
 *
 * Pure on purpose. dsh record shapes never reach this file — `dsh-workspaces.js`
 * turns live snapshots into the plain shapes below, so an upstream rename is a
 * one-file fix and every rule here stays unit-testable in Node.
 *
 * Light precedence (ticket 02, spec §7): red > yellow > green.
 *   red    a session in this workspace is waiting for the user (approval,
 *          question, plan review) or failed
 *   yellow a session is running
 *   green  no active session (idle, or the workspace is empty)
 */

/** @typedef {'green' | 'yellow' | 'red'} WorkspaceLight */

const LIGHT_GREEN = 'green'
const LIGHT_YELLOW = 'yellow'
const LIGHT_RED = 'red'

/**
 * The light for one workspace given its members' signals.
 *
 * Red short-circuits: the first red-worthy member wins regardless of position,
 * so a workspace with a queued question never hides behind a green sibling.
 *
 * @param {ReadonlyArray<{ running?: boolean, waiting?: boolean, errored?: boolean } | null | undefined> | unknown} signals
 * @returns {WorkspaceLight}
 */
function workspaceLight(signals) {
  if (!Array.isArray(signals)) return LIGHT_GREEN
  let running = false
  for (const signal of signals) {
    if (signal === null || signal === undefined || typeof signal !== 'object') continue
    if (signal.errored === true || signal.waiting === true) return LIGHT_RED
    if (signal.running === true) running = true
  }
  return running ? LIGHT_YELLOW : LIGHT_GREEN
}

/**
 * One session's contribution to its workspace light.
 *
 * `waiting` is deliberately kind-agnostic: every value of dsh's pending
 * interaction union (approval / question / plan-review) is the user's move, and
 * an unknown future kind would still block that session.
 *
 * @param {{ running?: boolean } | undefined} summary session list row
 * @param {{ running?: boolean, pendingInteraction?: { kind?: string } | null } | undefined} status unified UI status
 * @returns {{ running: boolean, waiting: boolean, errored: boolean }}
 */
function sessionSignal(summary, status) {
  const pending = status?.pendingInteraction
  return {
    running: status?.running === true || summary?.running === true,
    waiting: pending !== undefined && pending !== null,
    // dsh's client status projection has no failure bit today (see
    // `dsh-workspaces.js`); the field is here so wiring one in is a one-line change.
    errored: false,
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
 * the single `mainView` retention (see `dsh-workspaces.js`).
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
 * Project the shell's workspace/session snapshots into the rows the section
 * renders.
 *
 * Archived sessions are excluded: they are not reachable from this sidebar any
 * more, so they must not keep a workspace red. Sessions dsh no longer knows are
 * skipped. An unready workspace snapshot yields no rows; an unready session list
 * still yields rows, all green (names show up first, lights catch up).
 *
 * @param {{ phase?: string, items?: ReadonlyArray<any>, archivedSessionIds?: ReadonlyArray<string> } | undefined} workspaces
 * @param {{ phase?: string, byId?: Record<string, any> } | undefined} sessions
 * @param {Map<string, any> | Record<string, any> | undefined} statuses
 * @returns {Array<{ workspaceId: string, title: string, light: WorkspaceLight, current: boolean }>}
 */
function projectWorkspaceSection(workspaces, sessions, statuses) {
  if (workspaces?.phase !== 'ready') return []
  const items = Array.isArray(workspaces.items) ? workspaces.items : []
  const archived = new Set(workspaces.archivedSessionIds ?? [])
  const byId = sessions?.byId ?? {}
  const current = mainSessionId(sessions)
  return items.map((item) => {
    const memberIds = Array.isArray(item?.sessionIds) ? item.sessionIds : []
    const signals = []
    for (const sessionId of memberIds) {
      if (archived.has(sessionId)) continue
      const summary = byId[sessionId]
      if (summary === undefined || summary === null) continue
      signals.push(sessionSignal(summary, readStatus(statuses, sessionId)))
    }
    return {
      workspaceId: item?.workspaceId,
      title: item?.title,
      light: workspaceLight(signals),
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
  LIGHT_GREEN,
  LIGHT_YELLOW,
  LIGHT_RED,
  workspaceLight,
  sessionSignal,
  projectWorkspaceSection,
  displayWorkspaceName,
}
