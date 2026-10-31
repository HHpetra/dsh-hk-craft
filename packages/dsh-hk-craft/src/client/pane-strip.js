'use strict'

/**
 * The pane strip model (ticket 06).
 *
 * The strip is an index of open conversations: one entry per pane in the
 * visible workspace's layout tree, in `leaves()` order (depth-first,
 * left→right / top→bottom). There is no second container level and no
 * per-session list anywhere — the entry set, the order and the keyboard
 * shortcuts all come from the same tree the panes render from. Adding a
 * conversation (`+`) splits the focused pane beside itself and then evens the
 * row by pane count, so the strip order stays the on-screen left-to-right order.
 *
 * dsh shapes never reach this file. `pane-view.js` feeds it the live session
 * list and status map, and paints the plain entries; the pure rules below stay
 * unit-testable in Node without React.
 */

const { leaves } = require('./layout-tree.js')
const { readStatus, sessionSignal } = require('./workspace-status.js')
const { FOCUS_LIMIT, focusShortcutLabel } = require('./pane-shortcuts.js')

/** Ctrl+1..4 address the first four open conversations (ticket 06). */
const STRIP_SHORTCUT_LIMIT = FOCUS_LIMIT

const STRIP_STATUS_RUNNING = 'running'
const STRIP_STATUS_WAITING = 'waiting'
const STRIP_STATUS_IDLE = 'idle'

/**
 * The open conversations of a layout, in render order.
 *
 * `index` is the 1-based position in this list (not in the raw node walk), so a
 * dropped pane record can never shift the shortcut of the entries after it.
 * This projection is the single numbering used by the strip and by Ctrl+1..4.
 *
 * @param {{root?: object|null, panes?: Record<string, {paneId: string, sessionId: string}>, activePaneId?: string|null}} layout
 * @returns {{paneId: string, sessionId: string, index: number, focused: boolean}[]}
 */
function openConversationItems(layout) {
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
 * The pane whose open conversation is at 1-based `index` in the strip, or null.
 *
 * Uses the same projection as the strip, so the number a user sees on an entry
 * is the number the chord focuses even when a pane record was dropped.
 *
 * @param {object} layout
 * @param {number} index 1-based strip position
 * @returns {string|null}
 */
function paneIdForStripIndex(layout, index) {
  if (!Number.isInteger(index) || index < 1 || index > STRIP_SHORTCUT_LIMIT) return null
  return openConversationItems(layout)[index - 1]?.paneId ?? null
}

/**
 * One entry's status dot kind.
 *
 * Precedence mirrors the sidebar lights (red > yellow > green): waiting for the
 * user beats a running turn. dsh's client status has no failure bit (see
 * `workspace-status.js` and `doc/upstream-contracts.md#session-summary-fields`),
 * so there is no error state.
 *
 * @param {{running?: boolean}|undefined} summary session list row
 * @param {{running?: boolean, pendingInteraction?: object|null}|undefined} status live status map entry
 * @returns {'running'|'waiting'|'idle'}
 */
function paneStatusKind(summary, status) {
  const signal = sessionSignal(summary, status)
  if (signal.waiting) return STRIP_STATUS_WAITING
  if (signal.running) return STRIP_STATUS_RUNNING
  return STRIP_STATUS_IDLE
}

/**
 * The title shown on an entry: the conversation title, or the localized
 * placeholder.
 *
 * @param {unknown} title stored conversation title
 * @param {string} untitled localized placeholder
 * @returns {string}
 */
function conversationTitle(title, untitled) {
  const text = typeof title === 'string' ? title.trim() : ''
  return text === '' ? untitled : text
}

/**
 * The entries the strip renders: tree order, title, live status, shortcut hint.
 *
 * @param {object} layout controller snapshot / layout tree
 * @param {{byId?: Record<string, any>}|undefined} sessions `sessions.list` snapshot
 * @param {Map<string, any>|Record<string, any>|undefined} statuses `sessionStatus` map
 * @param {string} untitled localized placeholder for a missing title
 * @returns {{paneId: string, sessionId: string, index: number, focused: boolean, title: string, status: string, shortcut?: string}[]}
 */
function projectStrip(layout, sessions, statuses, untitled) {
  const byId = sessions?.byId ?? {}
  return openConversationItems(layout).map((item) => {
    const status = paneStatusKind(byId[item.sessionId], readStatus(statuses, item.sessionId))
    return {
      ...item,
      title: conversationTitle(byId[item.sessionId]?.title, untitled),
      status,
      ...(item.index <= STRIP_SHORTCUT_LIMIT ? { shortcut: focusShortcutLabel(item.index) } : {}),
    }
  })
}

module.exports = {
  STRIP_SHORTCUT_LIMIT,
  STRIP_STATUS_RUNNING,
  STRIP_STATUS_WAITING,
  STRIP_STATUS_IDLE,
  openConversationItems,
  paneIdForStripIndex,
  paneStatusKind,
  conversationTitle,
  projectStrip,
}
