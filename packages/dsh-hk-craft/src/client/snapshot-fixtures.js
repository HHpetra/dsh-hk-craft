'use strict'

/**
 * Shared builders for dsh's list snapshots and the status map.
 *
 * Why this file exists: before it, a dozen test files rolled their own
 * `{ byId }` / `{ items }` literals, and seven of them omitted `phase`. Since a
 * missing `phase` counts as *ready* (`catalog.js:phaseReady`, ADR-0016), those
 * literals made "still loading" cases pass for the wrong reason. Building
 * fixtures here means a snapshot always states its phase unless the case
 * deliberately asks for the field to be absent (`phase: null`).
 *
 * It is not a `*.test.js` file, so `node --test` never collects it, and nothing
 * reachable from `src/client/index.js` imports it, so esbuild never bundles it
 * into `lib/client.js`.
 */

/**
 * One `sessions.list` row, with the fields the plugin reads and dsh's defaults.
 *
 * @param {string} id session id
 * @param {object} [overrides] row fields to override
 * @returns {object}
 */
function sessionRow(id, overrides = {}) {
  return {
    id,
    title: '',
    running: false,
    blank: false,
    updatedAt: 0,
    retainedBy: {},
    projectionValues: {},
    ...overrides,
  }
}

/**
 * A `sessions.list` snapshot.
 *
 * @param {object[]} [rows] rows built by `sessionRow`
 * @param {{phase?: string|null, projectionsBySession?: object}} [options]
 *   `phase: null` leaves the field out entirely (the plain-test-double shape);
 *   it defaults to `'ready'`
 * @returns {object}
 */
function sessionsSnapshot(rows = [], options = {}) {
  const phase = options.phase === undefined ? 'ready' : options.phase
  const byId = {}
  const ids = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.id !== 'string' || row.id === '') continue
    byId[row.id] = row
    ids.push(row.id)
  }
  const snapshot = { ids, byId }
  if (phase !== null) snapshot.phase = phase
  if (options.projectionsBySession !== undefined) {
    snapshot.projectionsBySession = options.projectionsBySession
  }
  return snapshot
}

/**
 * One `workspaces.list` item.
 *
 * @param {string} workspaceId workspace id
 * @param {object} [overrides] item fields to override
 * @returns {object}
 */
function workspaceItem(workspaceId, overrides = {}) {
  return {
    workspaceId,
    title: workspaceId,
    path: `C:\\${workspaceId}`,
    sessionIds: [],
    ...overrides,
  }
}

/**
 * A `workspaces.list` snapshot.
 *
 * @param {object[]} [items] items built by `workspaceItem`
 * @param {{phase?: string|null, archived?: string[]}} [options]
 *   `phase: null` leaves the field out entirely; it defaults to `'ready'`
 * @returns {object}
 */
function workspacesSnapshot(items = [], options = {}) {
  const phase = options.phase === undefined ? 'ready' : options.phase
  const snapshot = {
    items,
    archivedSessionIds: Array.isArray(options.archived) ? [...options.archived] : [],
    pinnedSessionIds: [],
  }
  if (phase !== null) snapshot.phase = phase
  return snapshot
}

/**
 * One `sessionStatus` entry.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function statusEntry(overrides = {}) {
  return { running: false, pendingInteraction: null, completionUnread: false, ...overrides }
}

/**
 * A `sessionStatus` map, which is a `Map` in the shell.
 *
 * @param {Record<string, object>} [entries] entries built by `statusEntry`
 * @returns {Map<string, object>}
 */
function statusMap(entries = {}) {
  return new Map(Object.entries(entries))
}

module.exports = {
  sessionRow,
  sessionsSnapshot,
  workspaceItem,
  workspacesSnapshot,
  statusEntry,
  statusMap,
}