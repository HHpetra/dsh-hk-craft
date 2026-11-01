'use strict'

/**
 * The one rule every pointer drag in the plugin shares: a press becomes a drag
 * only after the pointer travels farther than the threshold.
 *
 * Two gestures use it — the sidebar workspace rows (`workspace-drag.js`) and the
 * pane strip entries (`pane-strip-drag.js`) — so the distance lives here instead
 * of in both. Each gesture keeps its own hit testing and drop mapping: a strip
 * drop swaps two entries, a workspace drop resolves a host anchor. Only the
 * "is this still a click" answer is shared, because a press that turns into a
 * drag by accident breaks a click in either region.
 */

/** Drags shorter than this stay clicks (the 6px threshold). */
const DRAG_THRESHOLD_PX = 6

/**
 * Has the pointer travelled farther than the threshold, so the press counts as
 * a drag?
 *
 * "移动超过 6px" is literal: exactly 6px still opens the row / focuses the tab,
 * and only a move *past* the threshold starts a drag.
 *
 * Distance, not axis travel: a press that wanders diagonally must cross the
 * threshold the same way a horizontal one does. A malformed sample never starts
 * a drag, so a synthetic event without coordinates cannot swallow a click.
 *
 * @param {number} startX
 * @param {number} startY
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} [threshold] defaults to the spec's 6px
 * @returns {boolean}
 */
function crossedDragThreshold(startX, startY, clientX, clientY, threshold = DRAG_THRESHOLD_PX) {
  const values = [startX, startY, clientX, clientY, threshold]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return false
  return Math.hypot(clientX - startX, clientY - startY) > threshold
}

module.exports = {
  DRAG_THRESHOLD_PX,
  crossedDragThreshold,
}