'use strict'

/**
 * The pane strip's pinned native-action group.
 *
 * The strip is an outer bar with two children: a horizontally scrolling
 * viewport holding the tabs followed by `+`, and this action group, which sits
 * outside the scrollport and never shrinks. The group only arranges its seats —
 * the read-only mode badge and the subagent viewer are
 * independent seats, so each is filled without editing the group.
 *
 * A seat is a React component type `(props) => element`; absent, `null` or any
 * non-function value means "this seat is not filled yet". Seat order is the
 * native conversation header's relative order, never registration order.
 * Unknown names are ignored: the right sidebar is deliberately not a seat in
 * this version (see
 * `doc/upstream-contracts.md#split-panel-hides-the-native-right-bar`), and a
 * future native tool needs an explicit entry here.
 *
 * The seat props are built by `pane-view.js` from the visible layout snapshot;
 * see `PaneStripActions` there. Nothing here imports React or dsh.
 */

const STRIP_SEAT_MODE = 'mode'
const STRIP_SEAT_SUBAGENTS = 'subagents'

/** The only seat names the group renders, in native-header order. */
const STRIP_SEAT_ORDER = [STRIP_SEAT_MODE, STRIP_SEAT_SUBAGENTS]

/**
 * Per-seat width caps, in px. A seat owns its own truncation; the cap keeps a
 * filled seat from squeezing the tab viewport, because the group itself never
 * shrinks (`stripActionsStyle`).
 */
const STRIP_SEAT_MAX_WIDTH = { [STRIP_SEAT_MODE]: 140, [STRIP_SEAT_SUBAGENTS]: 180 }

/**
 * The seats that will render, in the group's fixed order.
 *
 * @param {Record<string, unknown>|null|undefined} seats component types by seat name
 * @returns {{key: string, component: Function}[]}
 */
function stripSeatEntries(seats) {
  const source = seats ?? {}
  const entries = []
  for (const key of STRIP_SEAT_ORDER) {
    const component = source[key]
    if (typeof component === 'function') entries.push({ key, component })
  }
  return entries
}

/**
 * The width cap for one seat, or `null` for a name outside the group.
 *
 * @param {string} key seat name
 * @returns {number|null}
 */
function stripSeatMaxWidth(key) {
  return STRIP_SEAT_MAX_WIDTH[key] ?? null
}

module.exports = {
  STRIP_SEAT_MODE,
  STRIP_SEAT_SUBAGENTS,
  STRIP_SEAT_ORDER,
  STRIP_SEAT_MAX_WIDTH,
  stripSeatEntries,
  stripSeatMaxWidth,
}
