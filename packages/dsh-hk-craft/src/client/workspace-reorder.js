'use strict'

/**
 * Workspace drag reordering, as two pure rules.
 *
 * `sidebar-workspaces.js` owns the pointer plumbing (capture, hit testing,
 * indicator, click suppression); this module owns the math that is worth
 * pinning down: when a press becomes a drag, and which host anchor a release
 * produces. dsh's `workspaces.insertBefore` is the writer; the component never
 * keeps an order of its own.
 *
 * The host order is `workspaces.list().items` (`doc/upstream-contracts.md#
 * workspace-display-order`). A drop is described by the row under the pointer
 * and the half of it the pointer is in: the upper half inserts the source
 * before that row, the lower half before the row after it, which makes the
 * lower half of the last row an append.
 */

/** Drags shorter than this stay clicks (the 6px threshold). */
const REORDER_DRAG_THRESHOLD_PX = 6

/**
 * Has the pointer travelled farther than the threshold, so the press counts as
 * a drag?
 *
 * "移动超过 6px" is literal: exactly 6px still opens the workspace, and only a
 * move *past* the threshold starts a reorder.
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
function crossedDragThreshold(startX, startY, clientX, clientY, threshold = REORDER_DRAG_THRESHOLD_PX) {
  const values = [startX, startY, clientX, clientY, threshold]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return false
  return Math.hypot(clientX - startX, clientY - startY) > threshold
}

/**
 * Which half of a row the pointer is over.
 *
 * The midpoint belongs to the lower half, so the two halves tile the row
 * without a gap. A row that cannot be measured (detached, hidden, collapsed)
 * yields no side, and the drop is ignored.
 *
 * @param {{ top?: number, height?: number } | null | undefined} rect `getBoundingClientRect()`
 * @param {number} clientY
 * @returns {'before' | 'after' | null}
 */
function dropSideFor(rect, clientY) {
  const top = rect?.top
  const height = rect?.height
  if (typeof top !== 'number' || !Number.isFinite(top)) return null
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null
  if (typeof clientY !== 'number' || !Number.isFinite(clientY)) return null
  return clientY >= top + height / 2 ? 'after' : 'before'
}

/**
 * The `workspaces.insertBefore` anchor for a drop, or null when it is a no-op.
 *
 * `order` is the host's current workspace order. The source is removed first,
 * then the anchor is read from the remaining list, so "after the target" means
 * "before whatever followed the target" and "after the last row" means "before
 * nothing", i.e. append (`beforeId === undefined`). A drop that would produce
 * the same order (source already in place, source dropped on itself) returns
 * null, so the component writes nothing.
 *
 * @param {ReadonlyArray<string> | undefined | null} order workspace ids in host order
 * @param {string} sourceId the dragged workspace
 * @param {string} targetId the row under the pointer
 * @param {'before' | 'after'} side which half of the target row
 * @returns {{ beforeId: string | undefined } | null}
 */
function dropAnchor(order, sourceId, targetId, side) {
  if (!Array.isArray(order)) return null
  if (side !== 'before' && side !== 'after') return null
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') return null
  if (sourceId === targetId) return null
  const sourceIndex = order.indexOf(sourceId)
  const targetIndex = order.indexOf(targetId)
  if (sourceIndex === -1 || targetIndex === -1) return null

  const remaining = order.filter((id) => id !== sourceId)
  const anchorIndex = remaining.indexOf(targetId) + (side === 'after' ? 1 : 0)
  const next = [...remaining.slice(0, anchorIndex), sourceId, ...remaining.slice(anchorIndex)]
  if (next.every((id, index) => id === order[index])) return null
  return { beforeId: remaining[anchorIndex] }
}

module.exports = {
  REORDER_DRAG_THRESHOLD_PX,
  crossedDragThreshold,
  dropSideFor,
  dropAnchor,
}
