'use strict'

/**
 * The tab strip model (ticket 06).
 *
 * Tabs *are* panes: the strip is a projection of the layout tree, one row per
 * leaf in `leaves()` order (depth-first, left→right / top→bottom). There is no
 * second tab level and no per-session list anywhere — the row set, the order
 * and the keyboard shortcuts all come from the same tree the panes render from.
 *
 * dsh shapes never reach this file. `pane-view.js` feeds it the live session
 * list and status map, and paints the plain rows; the pure rules below stay
 * unit-testable in Node without React.
 */

const { leaves } = require('./layout-tree.js')
const { readStatus, sessionSignal } = require('./workspace-status.js')
const { FOCUS_LIMIT, focusShortcutLabel, tabShortcutIndex } = require('./pane-shortcuts.js')

/** Ctrl+1..4 address the first four tabs (ticket 06; no shortcut beyond four). */
const TAB_SHORTCUT_LIMIT = FOCUS_LIMIT

const TAB_STATUS_RUNNING = 'running'
const TAB_STATUS_WAITING = 'waiting'
const TAB_STATUS_ERROR = 'error'
const TAB_STATUS_IDLE = 'idle'

/**
 * The tabs of a layout, in render order.
 *
 * `index` is the 1-based position in this list (not in the raw node walk), so a
 * dropped pane record can never shift the shortcut of the tabs after it.
 *
 * @param {{root?: object|null, panes?: Record<string, {paneId: string, sessionId: string}>, activePaneId?: string|null}} layout
 * @returns {{paneId: string, sessionId: string, index: number, focused: boolean}[]}
 */
function tabItems(layout) {
  const ordered = leaves(layout?.root ?? null)
  const panes = layout?.panes ?? {}
  const activePaneId = layout?.activePaneId ?? null
  /** @type {{paneId: string, sessionId: string, index: number, focused: boolean}[]} */
  const items = []
  for (const paneId of ordered) {
    const pane = panes[paneId]
    if (pane === undefined || pane === null) continue
    if (typeof pane.sessionId !== 'string' || pane.sessionId === '') continue
    items.push({
      paneId,
      sessionId: pane.sessionId,
      index: items.length + 1,
      focused: paneId === activePaneId,
    })
  }
  return items
}

/**
 * The tab that Ctrl+`index` should focus (1-based), or null when there is none.
 *
 * @param {object} layout
 * @param {number} index 1-based tab number
 * @returns {string|null}
 */
function paneIdForTabIndex(layout, index) {
  if (!Number.isInteger(index) || index < 1 || index > TAB_SHORTCUT_LIMIT) return null
  return leaves(layout?.root ?? null)[index - 1] ?? null
}

/**
 * A tab's status dot kind.
 *
 * Precedence mirrors the sidebar lights (red > yellow > green): an error beats
 * a pending interaction, which beats a running turn. dsh's client status today
 * has no failure bit (see `workspace-status.js`), so `error` only appears when
 * a caller supplies one; the branch is ready for the day a projection has it.
 *
 * @param {{running?: boolean, errored?: boolean}|undefined} summary session list row
 * @param {{running?: boolean, pendingInteraction?: object|null, errored?: boolean}|undefined} status live status map entry
 * @returns {'running'|'waiting'|'error'|'idle'}
 */
function tabStatusKind(summary, status) {
  if (summary?.errored === true || status?.errored === true) return TAB_STATUS_ERROR
  const signal = sessionSignal(summary, status)
  if (signal.waiting) return TAB_STATUS_WAITING
  if (signal.running) return TAB_STATUS_RUNNING
  return TAB_STATUS_IDLE
}

/**
 * The title shown on a tab: the session title, or the localized placeholder.
 *
 * @param {unknown} title stored session title
 * @param {string} untitled localized placeholder
 * @returns {string}
 */
function tabTitle(title, untitled) {
  const text = typeof title === 'string' ? title.trim() : ''
  return text === '' ? untitled : text
}

/**
 * The rows the strip renders: tree order, title, live status, shortcut hint.
 *
 * @param {object} layout controller snapshot / layout tree
 * @param {{byId?: Record<string, any>}|undefined} sessions `sessions.list` snapshot
 * @param {Map<string, any>|Record<string, any>|undefined} statuses `sessionStatus` map
 * @param {string} untitled localized placeholder for a missing title
 * @returns {{paneId: string, sessionId: string, index: number, focused: boolean, title: string, status: string, shortcut?: string}[]}
 */
function projectTabs(layout, sessions, statuses, untitled) {
  const byId = sessions?.byId ?? {}
  return tabItems(layout).map((tab) => {
    const status = tabStatusKind(byId[tab.sessionId], readStatus(statuses, tab.sessionId))
    return {
      ...tab,
      title: tabTitle(byId[tab.sessionId]?.title, untitled),
      status,
      ...(tab.index <= TAB_SHORTCUT_LIMIT ? { shortcut: focusShortcutLabel(tab.index) } : {}),
    }
  })
}

module.exports = {
  TAB_SHORTCUT_LIMIT,
  TAB_STATUS_RUNNING,
  TAB_STATUS_WAITING,
  TAB_STATUS_ERROR,
  TAB_STATUS_IDLE,
  tabItems,
  paneIdForTabIndex,
  tabShortcutIndex,
  tabStatusKind,
  tabTitle,
  projectTabs,
}
