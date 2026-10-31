'use strict'

/**
 * The pure half of the pane strip's subagent viewer.
 *
 * A seat in the strip's pinned native-action group follows the focused strip
 * entry, reads that conversation's direct-child catalog from the raw
 * `useSessions` snapshot (`projectionsBySession[sessionId].values.subagentCatalog`
 * — see `doc/upstream-contracts.md#subagent-catalog-direct-children`), and hands
 * plain rows to the dumb React seat (`pane-subagents-view.js`) and its
 * `openInNewPane` pick.
 *
 * dsh record shapes never leak past this file: catalog entries, the status map
 * and the session summaries are normalized into the row model below, so an
 * upstream rename is a one-file fix and every rule stays Node-testable without a
 * DOM. Nested catalogs, hover-open, retry and breadcrumbs are out of scope for
 * this seat.
 */

const { readStatus } = require('./workspace-status.js')

const SUBAGENT_MODE_ONE_SHOT = 'one-shot'
const SUBAGENT_MODE_EXTERNAL = 'external'
const SUBAGENT_MODE_CONTINUABLE = 'continuable'
const SUBAGENT_MODE_UNKNOWN = 'unknown'

/** @type {Record<string, string>} mode ids the catalog union may carry */
const SUBAGENT_MODE_KEYS = Object.freeze({
  [SUBAGENT_MODE_ONE_SHOT]: 'subagent.mode.oneShot',
  [SUBAGENT_MODE_CONTINUABLE]: 'subagent.mode.continuable',
  [SUBAGENT_MODE_UNKNOWN]: 'subagent.mode.unknown',
  [SUBAGENT_MODE_EXTERNAL]: 'subagent.mode.external',
})

const SUBAGENT_ACTIVITY_RUNNING = 'running'
const SUBAGENT_ACTIVITY_COMPLETED = 'completed'
const SUBAGENT_ACTIVITY_IDLE = 'idle'

/** @type {Record<string, string>} activity ids the projection may carry */
const SUBAGENT_ACTIVITY_KEYS = Object.freeze({
  [SUBAGENT_ACTIVITY_RUNNING]: 'subagent.activity.running',
  [SUBAGENT_ACTIVITY_COMPLETED]: 'subagent.activity.completed',
  [SUBAGENT_ACTIVITY_IDLE]: 'subagent.activity.idle',
})

/**
 * The raw direct-child catalog of one session, or `undefined` when the
 * projection has not produced one. An explicit empty array is a ready empty
 * catalog and is returned as-is; only the projection's absence hides the seat.
 *
 * @param {object|undefined} sessions raw `useSessions` snapshot
 * @param {string} sessionId focused conversation
 * @returns {object[]|undefined}
 */
function catalogEntriesOf(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const snapshot = sessions?.projectionsBySession?.[sessionId]
  const entries = snapshot?.values?.subagentCatalog
  return Array.isArray(entries) ? entries : undefined
}

/**
 * Normalize a catalog mode id to one of the four documented modes. A future
 * upstream mode must still render and stay navigable, so it reads as unknown.
 *
 * @param {unknown} mode
 * @returns {string}
 */
function subagentModeOf(mode) {
  if (mode === SUBAGENT_MODE_ONE_SHOT) return SUBAGENT_MODE_ONE_SHOT
  if (mode === SUBAGENT_MODE_CONTINUABLE) return SUBAGENT_MODE_CONTINUABLE
  if (mode === SUBAGENT_MODE_EXTERNAL) return SUBAGENT_MODE_EXTERNAL
  return SUBAGENT_MODE_UNKNOWN
}

/**
 * The display label for one catalog entry: its durable label, otherwise the id
 * (the same fallback the native header uses).
 *
 * @param {{label?: unknown, id?: unknown}} [entry]
 * @returns {string}
 */
function subagentLabelOf(entry) {
  const label = typeof entry?.label === 'string' ? entry.label.trim() : ''
  if (label !== '') return label
  return typeof entry?.id === 'string' ? entry.id.trim() : ''
}

/**
 * One direct child's activity. External tasks have no local execution, so they
 * carry no activity at all. Running prefers the live status map and falls back
 * to the summary row; a finished child reads completed only when its latest
 * closed turn recorded a normal completion.
 *
 * @param {string} mode normalized catalog mode
 * @param {{running?: boolean, projectionValues?: object}|undefined} summary session summary row
 * @param {{running?: boolean}|undefined} status live status map entry
 * @returns {'running'|'completed'|'idle'|null}
 */
function subagentActivityOf(mode, summary, status) {
  if (mode === SUBAGENT_MODE_EXTERNAL) return null
  const running = (status?.running ?? summary?.running) === true
  if (running) return SUBAGENT_ACTIVITY_RUNNING
  if (summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true) {
    return SUBAGENT_ACTIVITY_COMPLETED
  }
  return SUBAGENT_ACTIVITY_IDLE
}

/**
 * Project the focused conversation's direct children into the seat model.
 *
 * `null` means "do not render the entry" — no focused conversation, no catalog
 * projection, or no usable rows. `total` counts every direct child (external
 * included, like the native header); `running` counts the local running ones.
 *
 * @param {object|undefined} sessions raw `useSessions` snapshot
 * @param {string} sessionId focused conversation
 * @param {Map<string, any>|Record<string, any>|undefined} statuses `sessionStatus` snapshot
 * @returns {{sessionId: string, total: number, running: number, rows: object[]}|null}
 */
function projectSubagentCatalog(sessions, sessionId, statuses) {
  const entries = catalogEntriesOf(sessions, sessionId)
  if (entries === undefined) return null
  const summaries = sessions?.byId ?? {}
  const rows = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    const mode = subagentModeOf(entry.mode)
    rows.push({
      id,
      label: subagentLabelOf(entry),
      mode,
      modeKey: SUBAGENT_MODE_KEYS[mode],
      activity: subagentActivityOf(mode, summaries[id], readStatus(statuses, id)),
      // External tasks have no local Session to open; every other mode may be
      // opened in a pane (unknown included, like the native catalog).
      navigable: mode !== SUBAGENT_MODE_EXTERNAL,
    })
  }
  if (rows.length === 0) return null
  return {
    sessionId,
    total: rows.length,
    running: rows.filter((row) => row.activity === SUBAGENT_ACTIVITY_RUNNING).length,
    rows,
  }
}

/**
 * Ask the shell to re-read one parent conversation's projections, once. The
 * service is optional and may reject; the dropdown stays usable either way.
 *
 * @param {((sessionId: string) => unknown)|undefined} refreshCatalog
 * @param {string} sessionId
 * @returns {void}
 */
function requestCatalogRefresh(refreshCatalog, sessionId) {
  if (typeof refreshCatalog !== 'function') return
  if (typeof sessionId !== 'string' || sessionId === '') return
  try {
    const attempt = refreshCatalog(sessionId)
    if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
      attempt.catch(() => {})
    }
  } catch (_error) {
    // The seat must never fail because an optional projection read failed.
  }
}

/**
 * Open one catalog row through the pane controller's public "new pane" path.
 *
 * The controller focuses the child when a pane already holds it and otherwise
 * splits a new pane beside the focused one, so the viewer never mounts a
 * conversation twice. External
 * rows are inert: they have no local Session to retain. A controller failure is
 * reported through its snapshot, not here.
 *
 * @param {{openInNewPane?: (sessionId: string) => unknown}|undefined} controller
 * @param {{id: string, navigable: boolean}|null} row projected catalog row
 * @returns {boolean} whether an open was attempted
 */
function openSubagentInPane(controller, row) {
  if (row === null || row === undefined || row.navigable !== true) return false
  if (typeof controller?.openInNewPane !== 'function') return false
  try {
    // A direct child is just a Session id here: `sessions.retain` derives the
    // subagent address from the parent catalog (upstream contracts).
    const attempt = controller.openInNewPane(row.id)
    if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
      attempt.catch(() => {})
    }
    return true
  } catch (_error) {
    return false
  }
}

module.exports = {
  SUBAGENT_MODE_ONE_SHOT,
  SUBAGENT_MODE_EXTERNAL,
  SUBAGENT_MODE_CONTINUABLE,
  SUBAGENT_MODE_UNKNOWN,
  SUBAGENT_MODE_KEYS,
  SUBAGENT_ACTIVITY_RUNNING,
  SUBAGENT_ACTIVITY_COMPLETED,
  SUBAGENT_ACTIVITY_IDLE,
  SUBAGENT_ACTIVITY_KEYS,
  catalogEntriesOf,
  subagentModeOf,
  subagentLabelOf,
  subagentActivityOf,
  projectSubagentCatalog,
  requestCatalogRefresh,
  openSubagentInPane,
}
