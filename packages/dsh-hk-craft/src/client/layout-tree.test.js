'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LAYOUT_VERSION,
  createLayout,
  openPane,
  split,
  evenRow,
  tile,
  close,
  leaves,
  findLeafPath,
  focus,
  resize,
  clampRatio,
  minRatioFor,
  ratioFromDrag,
  normalizeLayout,
  replaceSession,
  setView,
  paneOfSession,
  renamePanes,
  swap,
} = require('./layout-tree.js')
const { computeLayout } = require('./layout-geometry.js')

/** @param {string} paneId @param {string} sessionId */
function pane(paneId, sessionId) {
  return { paneId, sessionId, view: 'chat' }
}

const P1 = pane('p1', 's1')
const P2 = pane('p2', 's2')
const P3 = pane('p3', 's3')

/** One workspace layout with a single pane already open. */
function single() {
  return openPane(createLayout('w1'), P1)
}

test('a new layout is empty and versioned', () => {
  assert.deepEqual(createLayout('w1'), {
    version: LAYOUT_VERSION,
    workspaceId: 'w1',
    root: null,
    panes: {},
    activePaneId: null,
  })
  assert.equal(LAYOUT_VERSION, 1)
})

test('opening a pane in an empty layout makes it the whole tree and the focus', () => {
  const layout = single()

  assert.deepEqual(layout.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(layout.panes, { p1: P1 })
  assert.equal(layout.activePaneId, 'p1')
  assert.deepEqual(leaves(layout.root), ['p1'])
})

test('opening a second pane in a non-empty layout is refused, not appended blindly', () => {
  const layout = single()
  assert.equal(openPane(layout, P2), layout)
})

test('splitting a leaf right puts the new pane beside it and focuses the new pane', () => {
  const layout = split(single(), 'p1', 'row', P2)

  assert.deepEqual(layout.root, {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', paneId: 'p1' },
    b: { kind: 'leaf', paneId: 'p2' },
  })
  assert.deepEqual(leaves(layout.root), ['p1', 'p2'])
  assert.equal(layout.activePaneId, 'p2')
  assert.deepEqual(Object.keys(layout.panes).sort(), ['p1', 'p2'])
})

test('splitting down uses a column split', () => {
  const layout = split(single(), 'p1', 'col', P2)
  assert.equal(layout.root.dir, 'col')
  assert.equal(layout.root.ratio, 0.5)
  assert.deepEqual(leaves(layout.root), ['p1', 'p2'])
})

test('splitting a nested leaf only rewrites that leaf', () => {
  const two = split(single(), 'p1', 'row', P2)
  const three = split(two, 'p1', 'col', P3)

  assert.deepEqual(leaves(three.root), ['p1', 'p3', 'p2'])
  assert.deepEqual(three.root, {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: {
      kind: 'split',
      dir: 'col',
      ratio: 0.5,
      a: { kind: 'leaf', paneId: 'p1' },
      b: { kind: 'leaf', paneId: 'p3' },
    },
    b: { kind: 'leaf', paneId: 'p2' },
  })
})

test('splitting an unknown pane or with an unknown direction changes nothing', () => {
  const layout = single()
  assert.equal(split(layout, 'missing', 'row', P2), layout)
  assert.equal(split(layout, 'p1', 'diagonal', P2), layout)
  assert.equal(split(layout, 'p1', 'row', P1), layout)
})

test('an even row gives every pane exactly 1/N of the width', () => {
  assert.equal(evenRow([]), null)
  assert.equal(evenRow('p1'), null)

  for (let count = 2; count <= 7; count += 1) {
    const ids = Array.from({ length: count }, (_, index) => `p${index + 1}`)
    const root = evenRow(ids)
    const rects = computeLayout(root).panes

    assert.deepEqual(rects.map((rect) => rect.paneId), ids)
    for (const rect of rects) {
      // `computeLayout` rounds fractions to 1e-6.
      assert.ok(
        Math.abs(rect.width - 1 / count) < 1e-6,
        `${count} panes: ${rect.paneId} must be ${1 / count} wide, got ${rect.width}`,
      )
      assert.equal(rect.y, 0)
      assert.equal(rect.height, 1)
    }
  }
})

test('tiling inserts the new pane beside the anchor and re-evenly divides every column', () => {
  const two = split(single(), 'p1', 'row', P2)
  // A manually widened pane must not survive the next new conversation.
  const stretched = resize(two, [], 0.8)
  const three = tile(stretched, P3, 'p1')

  assert.deepEqual(leaves(three.root), ['p1', 'p3', 'p2'])
  const rects = computeLayout(three.root).panes
  for (const rect of rects) assert.ok(Math.abs(rect.width - 1 / 3) < 1e-6)
  assert.equal(three.activePaneId, 'p3')
  assert.deepEqual(three.panes.p3, P3)
})

test('tiling without a known anchor appends the new pane at the end', () => {
  const two = split(single(), 'p1', 'row', P2)
  const three = tile(two, P3, 'missing')

  assert.deepEqual(leaves(three.root), ['p1', 'p2', 'p3'])
  assert.equal(three.activePaneId, 'p3')
})

test('tiling an empty layout opens the first pane', () => {
  const layout = tile(createLayout('w1'), P1, 'p1')

  assert.deepEqual(layout.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(layout.panes, { p1: P1 })
  assert.equal(layout.activePaneId, 'p1')
})

test('tiling an already-open pane or a malformed pane changes nothing', () => {
  const layout = split(single(), 'p1', 'row', P2)

  assert.equal(tile(layout, P1, 'p1'), layout)
  assert.equal(tile(layout, null, 'p1'), layout)
  assert.equal(tile(layout, { paneId: '', sessionId: 's9' }, 'p1'), layout)
})

test('leaf paths address each node by a/b steps, in render order', () => {
  const layout = split(split(single(), 'p1', 'row', P2), 'p1', 'col', P3)

  assert.deepEqual(findLeafPath(layout.root, 'p1'), ['a', 'a'])
  assert.deepEqual(findLeafPath(layout.root, 'p3'), ['a', 'b'])
  assert.deepEqual(findLeafPath(layout.root, 'p2'), ['b'])
  assert.equal(findLeafPath(layout.root, 'missing'), null)
})

test('focusing an existing pane moves the focus; an unknown pane is ignored', () => {
  const layout = split(single(), 'p1', 'row', P2)
  const focused = focus(layout, 'p1')

  assert.equal(focused.activePaneId, 'p1')
  assert.equal(focus(focused, 'p1'), focused)
  assert.equal(focus(focused, 'missing'), focused)
})

test('closing the only pane empties the layout', () => {
  const layout = close(single(), 'p1')

  assert.deepEqual(layout, {
    version: 1,
    workspaceId: 'w1',
    root: null,
    panes: {},
    activePaneId: null,
  })
})

test('closing the right pane promotes its sibling into the parent slot', () => {
  const two = split(single(), 'p1', 'row', P2)
  const after = close(two, 'p2')

  assert.deepEqual(after.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(after.panes, { p1: P1 })
  assert.equal(after.activePaneId, 'p1')
})

test('closing the left pane promotes its sibling too', () => {
  const two = split(single(), 'p1', 'row', P2)
  const after = close(two, 'p1')

  assert.deepEqual(after.root, { kind: 'leaf', paneId: 'p2' })
  assert.deepEqual(after.panes, { p2: P2 })
  assert.equal(after.activePaneId, 'p2')
})

test('closing a nested pane collapses only the split that held it', () => {
  const three = split(split(single(), 'p1', 'row', P2), 'p1', 'col', P3)
  const after = close(three, 'p3')

  assert.deepEqual(leaves(after.root), ['p1', 'p2'])
  assert.deepEqual(after.root, {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', paneId: 'p1' },
    b: { kind: 'leaf', paneId: 'p2' },
  })
  assert.deepEqual(Object.keys(after.panes).sort(), ['p1', 'p2'])
})

test('a whole sibling subtree promotes when its neighbour closes', () => {
  const three = split(split(single(), 'p1', 'row', P2), 'p1', 'col', P3)
  const after = close(three, 'p2')

  assert.deepEqual(leaves(after.root), ['p1', 'p3'])
  assert.deepEqual(after.root, {
    kind: 'split',
    dir: 'col',
    ratio: 0.5,
    a: { kind: 'leaf', paneId: 'p1' },
    b: { kind: 'leaf', paneId: 'p3' },
  })
})

test('closing a focused left pane focuses the sibling leaf that takes its place', () => {
  const three = split(split(single(), 'p1', 'row', P2), 'p1', 'col', P3)
  const after = close(three, 'p1')

  // row(col(p1, p3), p2) → row(p3, p2): p3 takes the slot p1 held.
  assert.deepEqual(leaves(after.root), ['p3', 'p2'])
  assert.equal(after.activePaneId, 'p3')
})

test('closing a focused right pane focuses the adjacent leaf of the promoted sibling', () => {
  const three = split(split(single(), 'p1', 'row', P2), 'p2', 'col', P3)
  // row(p1, col(p2, p3)) — p3 is the bottom of the right column.
  const after = close(three, 'p3')

  assert.deepEqual(leaves(after.root), ['p1', 'p2'])
  assert.equal(after.activePaneId, 'p2')
})

test('closing an unfocused pane keeps the current focus', () => {
  const two = split(single(), 'p1', 'row', P2)
  const focused = focus(two, 'p1')
  const after = close(focused, 'p2')

  assert.equal(after.activePaneId, 'p1')
})

test('closing an unknown pane changes nothing', () => {
  const layout = single()
  assert.equal(close(layout, 'missing'), layout)
})

test('ratios are clamped into the usable band, with degenerate input neutralised', () => {
  assert.equal(clampRatio(0.5), 0.5)
  assert.equal(clampRatio(0), 0.1)
  assert.equal(clampRatio(1), 0.9)
  assert.equal(clampRatio(-4), 0.1)
  assert.equal(clampRatio(Number.NaN), 0.5)
  assert.equal(clampRatio(Number.POSITIVE_INFINITY), 0.5)
  assert.equal(clampRatio("0.3"), 0.5)
  assert.equal(clampRatio(undefined), 0.5)
  assert.equal(clampRatio(0.05, { min: 0.02, max: 0.98 }), 0.05)
})

test('the pixel minimum widens the ratio band on a small split', () => {
  assert.equal(minRatioFor(1000), 0.12)
  assert.equal(minRatioFor(400), 0.3)
  assert.equal(minRatioFor(100), 0.5)
  assert.equal(minRatioFor(0), 0.1)
  assert.equal(minRatioFor(Number.NaN), 0.1)
  assert.equal(minRatioFor(1000, 50), 0.1)
})

test('a separator drag converts pointer delta into a clamped ratio', () => {
  assert.equal(ratioFromDrag({ startRatio: 0.5, deltaPx: 100, sizePx: 1000 }), 0.6)
  assert.equal(ratioFromDrag({ startRatio: 0.5, deltaPx: -200, sizePx: 1000 }), 0.3)
  // 400px split, 120px minimum: the band is [0.3, 0.7].
  assert.equal(ratioFromDrag({ startRatio: 0.5, deltaPx: -999, sizePx: 400 }), 0.3)
  assert.equal(ratioFromDrag({ startRatio: 0.5, deltaPx: 999, sizePx: 400 }), 0.7)
  assert.equal(ratioFromDrag({ startRatio: 0.5, deltaPx: 50, sizePx: 0 }), 0.5)
})

test('resizing a split stores the clamped ratio on that node only', () => {
  const two = split(single(), 'p1', 'row', P2)
  assert.equal(two.root.ratio, 0.5)

  const wide = resize(two, [], 0.75)
  assert.equal(wide.root.ratio, 0.75)
  assert.equal(resize(two, [], 0.99).root.ratio, 0.9)
  assert.equal(resize(two, [], 0.001).root.ratio, 0.1)
  assert.equal(resize(two, [], "wide"), two)
})

test('resizing a nested split addresses it by its a/b path and leaves the parent alone', () => {
  const three = split(split(single(), 'p1', 'row', P2), 'p1', 'col', P3)
  const after = resize(three, ["a"], 0.7)

  assert.equal(after.root.ratio, 0.5)
  assert.equal(after.root.a.ratio, 0.7)
  assert.equal(resize(three, ["b"], 0.7), three)
  assert.equal(resize(three, ["a", "a"], 0.7), three)
  assert.equal(resize(three, ["nope"], 0.7), three)
})

test('replacing a session keeps the pane identity, the tree and the view', () => {
  const two = split(single(), "p1", "row", P2)
  const viewed = setView(two, "p2", "trajectory")
  const after = replaceSession(viewed, "p1", "s9")

  assert.deepEqual(after.root, viewed.root)
  assert.deepEqual(after.panes.p1, { paneId: "p1", sessionId: "s9", view: "chat" })
  assert.equal(after.panes.p2.view, "trajectory")
  assert.equal(after.activePaneId, "p2")
  assert.equal(replaceSession(after, "p1", "s9"), after)
  assert.equal(replaceSession(after, "missing", "s9"), after)
})

test('setting a view only touches that pane', () => {
  const two = split(single(), "p1", "row", P2)
  const after = setView(two, "p1", "trajectory")

  assert.equal(after.panes.p1.view, "trajectory")
  assert.equal(after.panes.p2.view, "chat")
  assert.equal(setView(two, "p1", "bogus"), two)
  assert.equal(setView(two, "missing", "chat"), two)
})

test('a session maps back to the pane that holds it', () => {
  const two = split(single(), "p1", "row", P2)
  assert.equal(paneOfSession(two, "s2"), "p2")
  assert.equal(paneOfSession(two, "s9"), undefined)
})

test('splitting and closing the new pane is a structural round-trip', () => {
  const original = resize(split(single(), "p1", "row", P2), [], 0.65)
  const splitAgain = split(original, "p2", "col", P3)
  const restored = close(splitAgain, "p3")

  assert.deepEqual(restored.root, original.root)
  assert.deepEqual(restored.panes, original.panes)
  assert.equal(restored.activePaneId, "p2")
})

test('a stored layout survives JSON and normalisation unchanged', () => {
  const layout = resize(split(split(single(), "p1", "row", P2), "p1", "col", P3), ["a"], 0.4)
  const decoded = normalizeLayout(JSON.parse(JSON.stringify(layout)))

  assert.deepEqual(decoded, layout)
})

test('normalisation prunes leaves whose pane is gone and repairs the focus', () => {
  const three = split(split(single(), "p1", "row", P2), "p1", "col", P3)
  const panes = { p1: three.panes.p1, p2: three.panes.p2 }
  const pruned = normalizeLayout({ ...three, panes, activePaneId: "p3" })

  assert.deepEqual(leaves(pruned.root), ["p1", "p2"])
  assert.deepEqual(Object.keys(pruned.panes).sort(), ["p1", "p2"])
  assert.equal(pruned.activePaneId, "p1")
})

test('normalisation collapses orphan pane records and out-of-band ratios', () => {
  const layout = {
    version: 7,
    workspaceId: "w1",
    root: { kind: "split", dir: "row", ratio: 42, a: { kind: "leaf", paneId: "p1" }, b: { kind: "leaf", paneId: "ghost" } },
    panes: { p1: { paneId: "p1", sessionId: "s1", view: "chat" }, stray: { paneId: "stray", sessionId: "s8" } },
    activePaneId: "stray",
  }
  const normalized = normalizeLayout(layout)

  assert.deepEqual(normalized.root, { kind: "leaf", paneId: "p1" })
  assert.deepEqual(Object.keys(normalized.panes), ["p1"])
  assert.equal(normalized.root.ratio, undefined)
  assert.equal(normalized.activePaneId, "p1")
  assert.equal(normalized.version, 1)
})

test('normalisation turns an empty or corrupt layout into the empty state', () => {
  assert.deepEqual(normalizeLayout(null), {
    version: 1,
    workspaceId: null,
    root: null,
    panes: {},
    activePaneId: null,
  })
  const empty = normalizeLayout({ root: null, panes: { orphan: { paneId: "orphan", sessionId: "s" } }, activePaneId: "orphan" })
  assert.equal(empty.root, null)
  assert.deepEqual(empty.panes, {})
  assert.equal(empty.activePaneId, null)
})

test('transitions never mutate their input', () => {
  const original = split(single(), "p1", "row", P2)
  const snapshot = JSON.parse(JSON.stringify(original))

  split(original, "p2", "col", P3)
  tile(original, P3, "p1")
  close(original, "p2")
  resize(original, [], 0.8)
  replaceSession(original, "p1", "s9")
  setView(original, "p1", "trajectory")
  focus(original, "p1")

  assert.deepEqual(original, snapshot)
})

test('renaming pane ids rewrites the tree, the records and the focus, keeping shape', () => {
  const layout = resize(split(single(), "p1", "row", P2), [], 0.4)
  const renamed = renamePanes(layout, new Map([["p1", "pane-restored"]]))

  assert.deepEqual(leaves(renamed.root), ["pane-restored", "p2"])
  assert.equal(renamed.root.ratio, 0.4)
  assert.deepEqual(Object.keys(renamed.panes).sort(), ["p2", "pane-restored"])
  assert.deepEqual(renamed.panes["pane-restored"], {
    paneId: "pane-restored",
    sessionId: "s1",
    view: "chat",
  })
  assert.equal(renamed.activePaneId, "p2")
})

test('renaming an empty mapping or an unknown id changes nothing', () => {
  const layout = split(single(), "p1", "row", P2)
  assert.equal(renamePanes(layout, new Map()), layout)
  assert.equal(renamePanes(layout, new Map([["ghost", "x"]])), layout)
})

test('swapping two panes exchanges their sessions and views but not the tree', () => {
  // row(p1, col(p2, p3)) with a non-default ratio and a remembered view: the
  // swap must leave the shape, the ratio and the focus exactly as they were.
  const three = resize(split(split(single(), 'p1', 'row', P2), 'p1', 'col', P3), [], 0.37)
  const before = setView(three, 'p1', 'trajectory')
  const after = swap(before, 'p1', 'p2')

  assert.equal(after.root, before.root)
  assert.deepEqual(after.root, before.root)
  assert.equal(after.root.ratio, 0.37)
  assert.deepEqual(after.panes.p1, { paneId: 'p1', sessionId: 's2', view: 'chat' })
  assert.deepEqual(after.panes.p2, { paneId: 'p2', sessionId: 's1', view: 'trajectory' })
  assert.deepEqual(after.panes.p3, before.panes.p3)
  assert.deepEqual(leaves(after.root), ['p1', 'p3', 'p2'])
  assert.equal(after.activePaneId, before.activePaneId)
  assert.equal(after.workspaceId, before.workspaceId)
  assert.equal(after.version, before.version)
  // The swap is symmetric and does not depend on argument order.
  assert.deepEqual(swap(before, 'p2', 'p1'), after)
})

test('swapping a pane with itself or an unknown pane changes nothing', () => {
  const two = split(single(), 'p1', 'row', P2)

  assert.equal(swap(two, 'p1', 'p1'), two)
  assert.equal(swap(two, 'p1', 'missing'), two)
  assert.equal(swap(two, 'missing', 'p1'), two)
  const noRecords = { ...two, panes: {} }
  assert.equal(swap(noRecords, 'p1', 'p2'), noRecords)
})

test('a swap never mutates its input', () => {
  const two = split(single(), 'p1', 'row', P2)
  const snapshot = JSON.parse(JSON.stringify(two))

  swap(two, 'p1', 'p2')

  assert.deepEqual(two, snapshot)
})

test('renaming the focused pane moves the focus to its new id', () => {
  const layout = focus(split(single(), "p1", "row", P2), "p1")
  const renamed = renamePanes(layout, new Map([["p1", "pane-9"]]))

  assert.equal(renamed.activePaneId, "pane-9")
  assert.equal(layout.activePaneId, "p1")
})
