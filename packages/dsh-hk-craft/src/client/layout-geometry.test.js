'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { computeLayout, SEPARATOR_HIT_PX, SEPARATOR_LINE_PX } = require('./layout-geometry.js')
const { leafNode, splitNode } = require('./layout-tree.js')

test('a single pane fills the workspace', () => {
  const geometry = computeLayout(leafNode('p1'))

  assert.deepEqual(geometry.panes, [{ paneId: 'p1', x: 0, y: 0, width: 1, height: 1 }])
  assert.deepEqual(geometry.separators, [])
})

test('a row split halves the width and leaves a separator on the boundary', () => {
  const geometry = computeLayout(splitNode('row', 0.5, leafNode('p1'), leafNode('p2')))

  assert.deepEqual(
    geometry.panes.map((pane) => [pane.paneId, pane.x, pane.y, pane.width, pane.height]),
    [
      ['p1', 0, 0, 0.5, 1],
      ['p2', 0.5, 0, 0.5, 1],
    ],
  )
  assert.deepEqual(geometry.separators, [
    { path: [], dir: 'row', x: 0.5, y: 0, width: 0, height: 1, ratio: 0.5, extent: 1 },
  ])
})

test('a column split halves the height', () => {
  const geometry = computeLayout(splitNode('col', 0.5, leafNode('p1'), leafNode('p2')))

  assert.deepEqual(
    geometry.panes.map((pane) => [pane.paneId, pane.x, pane.y, pane.width, pane.height]),
    [
      ['p1', 0, 0, 1, 0.5],
      ['p2', 0, 0.5, 1, 0.5],
    ],
  )
  assert.deepEqual(geometry.separators, [
    { path: [], dir: 'col', x: 0, y: 0.5, width: 1, height: 0, ratio: 0.5, extent: 1 },
  ])
})

test('nested splits compose rects and keep separators scoped to their parent', () => {
  const root = splitNode(
    'row',
    0.3,
    splitNode('col', 0.6, leafNode('p1'), leafNode('p3')),
    leafNode('p2'),
  )
  const geometry = computeLayout(root)

  assert.deepEqual(
    geometry.panes.map((pane) => [pane.paneId, pane.x, pane.y, pane.width, pane.height]),
    [
      ['p1', 0, 0, 0.3, 0.6],
      ['p3', 0, 0.6, 0.3, 0.4],
      ['p2', 0.3, 0, 0.7, 1],
    ],
  )
  assert.deepEqual(geometry.separators, [
    { path: ['a'], dir: 'col', x: 0, y: 0.6, width: 0.3, height: 0, ratio: 0.6, extent: 1 },
    { path: [], dir: 'row', x: 0.3, y: 0, width: 0, height: 1, ratio: 0.3, extent: 1 },
  ])
})

test('out-of-band and degenerate ratios are clamped before projecting', () => {
  const wide = computeLayout(splitNode('row', 42, leafNode('p1'), leafNode('p2')))
  assert.equal(wide.panes[0].width, 0.9)

  const collapsed = computeLayout(splitNode('row', -1, leafNode('p1'), leafNode('p2')))
  assert.equal(collapsed.panes[0].width, 0.1)

  const broken = computeLayout(splitNode('col', Number.NaN, leafNode('p1'), leafNode('p2')))
  assert.equal(broken.panes[0].height, 0.5)
})

test('an empty or malformed tree projects to nothing', () => {
  assert.deepEqual(computeLayout(null), { panes: [], separators: [] })
  assert.deepEqual(computeLayout(undefined), { panes: [], separators: [] })
  assert.deepEqual(computeLayout({ kind: 'leaf' }), { panes: [], separators: [] })
})

test('separator sizing constants are exposed for the renderer', () => {
  assert.equal(SEPARATOR_HIT_PX, 8)
  assert.equal(SEPARATOR_LINE_PX, 2)
})

test('a separator carries the size of the split it belongs to, not the workspace', () => {
  // row(0.4, row(0.5, p1, p2), p3): the inner row split is only 0.4 wide.
  const root = splitNode(
    'row',
    0.4,
    splitNode('row', 0.5, leafNode('p1'), leafNode('p2')),
    leafNode('p3'),
  )
  const geometry = computeLayout(root)
  const inner = geometry.separators.find((separator) => separator.path.join('/') === 'a')

  assert.equal(inner.extent, 0.4)
  assert.equal(inner.x, 0.2)
  assert.equal(geometry.separators.find((separator) => separator.path.length === 0).extent, 1)
})
