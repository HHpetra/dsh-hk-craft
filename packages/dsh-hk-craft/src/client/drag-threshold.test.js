'use strict'

/**
 * The one drag rule every pointer gesture in the plugin shares: a press becomes
 * a drag only after it travels more than the threshold.
 *
 * Two gestures depend on it — the sidebar workspace rows and the pane strip
 * entries — and getting it wrong breaks something visible in both: a press that
 * turns into a drag by accident stops being a click, so the row would not open
 * its workspace and the tab would not focus its pane.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { DRAG_THRESHOLD_PX, crossedDragThreshold } = require('./drag-threshold.js')

test('a press becomes a drag only after it moves more than six pixels', () => {
  assert.equal(DRAG_THRESHOLD_PX, 6)
  assert.equal(crossedDragThreshold(10, 10, 15, 10), false, '5px is still a click')
  assert.equal(crossedDragThreshold(10, 10, 10, 15), false)
  assert.equal(crossedDragThreshold(10, 10, 16, 10), false, 'exactly 6px is still a click')
  assert.equal(crossedDragThreshold(10, 10, 10, 16), false)
  assert.equal(crossedDragThreshold(10, 10, 16.01, 10), true, 'more than 6px starts the drag')
  assert.equal(crossedDragThreshold(10, 10, 16, 18), true, 'distance, not per-axis travel')
})

test('the threshold is a distance and accepts an explicit value', () => {
  assert.equal(crossedDragThreshold(0, 0, 3, 4), false, 'a 5px diagonal stays a click')
  assert.equal(crossedDragThreshold(0, 0, 0, 9, 10), false, 'under a custom 10px threshold')
  assert.equal(crossedDragThreshold(0, 0, 0, 10, 10), false, 'the threshold itself is still a click')
  assert.equal(crossedDragThreshold(0, 0, 0, 10.01, 10), true, 'just past the custom threshold starts it')
  assert.equal(crossedDragThreshold(0, 0, 0, 7), true, 'just past the default 6px threshold')
})

test('a malformed pointer sample never starts a drag', () => {
  assert.equal(crossedDragThreshold(undefined, 0, 10, 0), false)
  assert.equal(crossedDragThreshold(0, 0, Number.NaN, 0), false)
})