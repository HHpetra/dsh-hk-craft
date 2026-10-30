'use strict'

/**
 * Workspace drag reordering (ticket 04) is decided by two pure rules: how far a
 * pointer must travel before a press becomes a drag, and where a drop lands in
 * the host's workspace order.
 *
 * These tests pin those rules to worked examples, not to the implementation, so
 * the pointer plumbing in `sidebar-workspaces.js` can change without rewriting
 * them. The gesture itself (capture, indicator, click suppression) is covered by
 * the component tests below and the manual smoke list.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  REORDER_DRAG_THRESHOLD_PX,
  crossedDragThreshold,
  dropSideFor,
  dropAnchor,
} = require('./workspace-reorder.js')

test('a press becomes a workspace drag only after six pixels', () => {
  assert.equal(REORDER_DRAG_THRESHOLD_PX, 6)
  assert.equal(crossedDragThreshold(10, 10, 15, 10), false, '5px is still a click')
  assert.equal(crossedDragThreshold(10, 10, 10, 15), false)
  assert.equal(crossedDragThreshold(10, 10, 16, 10), true, 'exactly 6px starts the drag')
  assert.equal(crossedDragThreshold(10, 10, 10, 16), true)
  assert.equal(crossedDragThreshold(10, 10, 16, 18), true, 'distance, not per-axis travel')
})

test('the threshold is a distance and accepts an explicit value', () => {
  assert.equal(crossedDragThreshold(0, 0, 3, 4), false, 'a 5px diagonal stays a click')
  assert.equal(crossedDragThreshold(0, 0, 0, 9, 10), false, 'at a custom 10px threshold')
  assert.equal(crossedDragThreshold(0, 0, 0, 10, 10), true, 'the threshold is inclusive')
  assert.equal(crossedDragThreshold(0, 0, 0, 10), true, 'at the default 6px threshold')
})

test('a malformed pointer sample never starts a drag', () => {
  assert.equal(crossedDragThreshold(undefined, 0, 10, 0), false)
  assert.equal(crossedDragThreshold(0, 0, Number.NaN, 0), false)
})

test("the drop side is the row's upper or lower half", () => {
  // Row box: 30px tall starting at y=100, so the midpoint is y=115.
  const row = { top: 100, height: 30 }
  assert.equal(dropSideFor(row, 100), 'before')
  assert.equal(dropSideFor(row, 114), 'before')
  assert.equal(dropSideFor(row, 115), 'after', 'the midpoint belongs to the lower half')
  assert.equal(dropSideFor(row, 130), 'after')
})

test('a row that cannot be hit-tested yields no drop side', () => {
  assert.equal(dropSideFor(null, 110), null)
  assert.equal(dropSideFor({ top: Number.NaN, height: 30 }, 110), null)
  assert.equal(dropSideFor({ top: 100, height: 0 }, 110), null)
  assert.equal(dropSideFor({ top: 100, height: -30 }, 110), null)
  assert.equal(dropSideFor({ top: 100, height: Number.POSITIVE_INFINITY }, 110), null)
})

test('the upper half of a row inserts the source before it', () => {
  // c dragged onto the upper half of a: c leaves the end and lands in front.
  assert.deepEqual(dropAnchor(['a', 'b', 'c'], 'c', 'a', 'before'), { beforeId: 'a' })
  assert.deepEqual(dropAnchor(['a', 'b', 'c', 'd'], 'd', 'b', 'before'), { beforeId: 'b' })
})

test('the lower half of a row inserts the source before the next row', () => {
  // a dragged onto the lower half of b: a lands between b and c.
  assert.deepEqual(dropAnchor(['a', 'b', 'c', 'd'], 'a', 'b', 'after'), { beforeId: 'c' })
  // d dragged onto the lower half of a: d lands between a and b.
  assert.deepEqual(dropAnchor(['a', 'b', 'c', 'd'], 'd', 'a', 'after'), { beforeId: 'b' })
})

test('the lower half of the last row appends, with no anchor at all', () => {
  assert.deepEqual(dropAnchor(['a', 'b', 'c'], 'a', 'c', 'after'), { beforeId: undefined })
  assert.equal('beforeId' in dropAnchor(['a', 'b', 'c'], 'a', 'c', 'after'), true)
})

test('a drop that would not change the order is a no-op', () => {
  // b is already before c.
  assert.equal(dropAnchor(['a', 'b', 'c'], 'b', 'c', 'before'), null)
  // b is already after a.
  assert.equal(dropAnchor(['a', 'b', 'c'], 'b', 'a', 'after'), null)
  // A row dropped on either half of itself stays put.
  assert.equal(dropAnchor(['a', 'b', 'c'], 'b', 'b', 'before'), null)
  assert.equal(dropAnchor(['a', 'b', 'c'], 'b', 'b', 'after'), null)
})

test('a source or target the host does not list is a no-op', () => {
  assert.equal(dropAnchor(['a', 'b', 'c'], 'missing', 'a', 'before'), null)
  assert.equal(dropAnchor(['a', 'b', 'c'], 'a', 'missing', 'before'), null)
  assert.equal(dropAnchor([], 'a', 'b', 'before'), null)
  assert.equal(dropAnchor(['a'], 'a', 'a', 'before'), null)
})

test('a malformed order or drop side is a no-op', () => {
  assert.equal(dropAnchor(undefined, 'a', 'b', 'before'), null)
  assert.equal(dropAnchor(null, 'a', 'b', 'before'), null)
  assert.equal(dropAnchor(['a', 'b'], 'a', 'b', 'above'), null)
  assert.equal(dropAnchor(['a', 'b'], 'a', 'b', undefined), null)
})
