'use strict'

/**
 * The pane strip drag gesture.
 *
 * Two behaviours are worth pinning here, because both are invisible until they
 * break in the app:
 *
 * - a press below the threshold stays a click, so pressing a tab still focuses
 *   its pane (the threshold itself is shared, see `drag-threshold.test.js`);
 * - a completed drag swallows exactly one following click, so dropping a tab
 *   does not also focus it.
 *
 * The gesture is also the strip's only DOM-reading code, so the hit test is
 * exercised through a fake `document`.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  usePaneStripDrag,
  insideStripClose,
  stripPaneIdAt,
  swapTargetFor,
} = require('./pane-strip-drag.js')

/** Only the two React hooks this hook reads; the setter records visible updates. */
function fakeReact() {
  const updates = []
  return {
    updates,
    useState: (initial) => [initial, (next) => updates.push(next)],
    useRef: (value) => ({ current: value }),
  }
}

/**
 * Install a `document` whose `elementFromPoint` resolves through `hit`.
 *
 * @param {(clientX: number, clientY: number) => any} hit
 * @returns {() => void} restore
 */
function installDocument(hit) {
  const previous = globalThis.document
  globalThis.document = { elementFromPoint: hit }
  return () => {
    globalThis.document = previous
  }
}

/** A strip entry element that answers the hit test's `closest`. */
function stripEntry(paneId) {
  return {
    closest(selector) {
      return selector === '[data-hkcraft-strip-item]' ? { getAttribute: () => paneId } : null
    },
  }
}

function captureTarget(calls) {
  return {
    setPointerCapture(pointerId) {
      calls.push(['capture', pointerId])
    },
    releasePointerCapture(pointerId) {
      calls.push(['release', pointerId])
    },
  }
}

function pointerEvent(clientX, clientY, currentTarget, target = { closest: () => null }) {
  return {
    button: 0,
    pointerId: 7,
    clientX,
    clientY,
    target,
    currentTarget,
    preventDefault() {},
  }
}

/** @param {(source: string, target: string) => void} [onSwap] */
function gesture(onSwap) {
  const React = fakeReact()
  return { React, drag: usePaneStripDrag(React, onSwap === undefined ? {} : { onSwap }) }
}

// ---------------------------------------------------------------------------
// the pure hit test
// ---------------------------------------------------------------------------

test('a press on an entry close button is never a drag', () => {
  const close = {
    closest(selector) {
      return selector === '[data-hkcraft-strip-close]' ? {} : null
    },
  }
  assert.equal(insideStripClose(close), true)
  assert.equal(insideStripClose({ closest: () => null }), false)
  assert.equal(insideStripClose(undefined), false)
})

test('the entry under the pointer names its pane, through a child element', () => {
  const restore = installDocument(() => {
    const child = { closest: (selector) => (selector === '[data-hkcraft-strip-item]' ? stripEntry('p2').closest(selector) : null) }
    return child
  })
  try {
    assert.equal(stripPaneIdAt(10, 20), 'p2')
  } finally {
    restore()
  }
  assert.equal(stripPaneIdAt(10, 20), null, 'without a document there is no hit test')
})

test('a pointer over nothing, or over an entry without a pane id, resolves to null', () => {
  const restore = installDocument(() => ({ closest: () => null }))
  try {
    assert.equal(stripPaneIdAt(0, 0), null)
  } finally {
    restore()
  }

  const restoreEmpty = installDocument(() => stripEntry(''))
  try {
    assert.equal(stripPaneIdAt(0, 0), null)
  } finally {
    restoreEmpty()
  }
})

test('the swap target is another entry, never the source itself', () => {
  const restore = installDocument((_x, _y) => stripEntry('p2'))
  try {
    assert.equal(swapTargetFor('p1', 10, 10), 'p2')
    assert.equal(swapTargetFor('p2', 10, 10), null, 'dropping on itself is a no-op')
  } finally {
    restore()
  }

  const restoreNothing = installDocument(() => null)
  try {
    assert.equal(swapTargetFor('p1', 10, 10), null)
  } finally {
    restoreNothing()
  }
})

// ---------------------------------------------------------------------------
// the gesture
// ---------------------------------------------------------------------------

test('a press below the threshold stays a click and never captures', () => {
  const restore = installDocument(() => stripEntry('p2'))
  try {
    const calls = []
    const target = captureTarget(calls)
    const { drag } = gesture()

    drag.onEntryPointerDown({ paneId: 'p1' })(pointerEvent(10, 10, target))
    drag.onEntryPointerMove(pointerEvent(13, 14, target)) // 5px: still a click
    drag.onEntryPointerUp(pointerEvent(13, 14, target))

    assert.deepEqual(calls, [['capture', 7], ['release', 7]])
    assert.equal(drag.consumeSuppressedClick(), false, 'a click is not swallowed')
  } finally {
    restore()
  }
})

test('crossing the threshold exposes the drop target and swaps exactly once', () => {
  const restore = installDocument((x) => (x > 100 ? stripEntry('p2') : null))
  try {
    const calls = []
    const target = captureTarget(calls)
    const swaps = []
    const { React, drag } = gesture((source, to) => swaps.push([source, to]))

    drag.onEntryPointerDown({ paneId: 'p1' })(pointerEvent(10, 10, target))
    drag.onEntryPointerMove(pointerEvent(10, 40, target)) // 30px: a drag, over nothing
    drag.onEntryPointerMove(pointerEvent(140, 40, target)) // over p2
    drag.onEntryPointerUp(pointerEvent(140, 40, target))

    assert.deepEqual(React.updates, [
      { sourcePaneId: 'p1', targetPaneId: null },
      { sourcePaneId: 'p1', targetPaneId: 'p2' },
      null,
    ], 'drag start, drop target, then cleared on release')
    assert.deepEqual(swaps, [['p1', 'p2']])
    assert.equal(drag.consumeSuppressedClick(), true, 'the click after a drop is swallowed')
    assert.equal(drag.consumeSuppressedClick(), false, 'and only once')
  } finally {
    restore()
  }
})

test('dropping away from every entry writes nothing, but still swallows the click', () => {
  const restore = installDocument(() => null)
  try {
    const calls = []
    const target = captureTarget(calls)
    const swaps = []
    const { drag } = gesture((source, to) => swaps.push([source, to]))

    drag.onEntryPointerDown({ paneId: 'p1' })(pointerEvent(10, 10, target))
    drag.onEntryPointerMove(pointerEvent(10, 40, target))
    drag.onEntryPointerUp(pointerEvent(10, 40, target))

    assert.deepEqual(swaps, [])
    assert.equal(drag.consumeSuppressedClick(), true, 'a drag is never a click, even with no drop')
  } finally {
    restore()
  }
})

test('a press on the close button does not begin a drag', () => {
  const calls = []
  const target = captureTarget(calls)
  const close = {
    closest(selector) {
      return selector === '[data-hkcraft-strip-close]' ? {} : null
    },
  }
  const { drag } = gesture()

  drag.onEntryPointerDown({ paneId: 'p1' })(pointerEvent(10, 10, target, close))
  drag.onEntryPointerMove(pointerEvent(10, 40, target))
  drag.onEntryPointerUp(pointerEvent(10, 40, target))

  // Capture is taken on pointerdown in this gesture; the press never gets there.
  assert.deepEqual(calls, [])
  assert.equal(drag.consumeSuppressedClick(), false)
})

test('a cancelled drag releases its capture and leaves no drag state', () => {
  const restore = installDocument(() => null)
  try {
    const calls = []
    const target = captureTarget(calls)
    const { drag } = gesture()

    drag.onEntryPointerDown({ paneId: 'p1' })(pointerEvent(10, 10, target))
    drag.onEntryPointerMove(pointerEvent(10, 40, target))
    drag.onEntryPointerCancel(pointerEvent(10, 40, target))

    assert.deepEqual(calls, [['capture', 7], ['release', 7]])
    assert.equal(drag.consumeSuppressedClick(), false, 'a cancelled drag does not eat a click')
  } finally {
    restore()
  }
})

test('a gesture without an onSwap still tracks the drag and swallows its click', () => {
  const restore = installDocument((x) => (x > 100 ? stripEntry('p2') : null))
  try {
    const calls = []
    const target = captureTarget(calls)
    const { drag } = gesture()

    drag.onEntryPointerDown({ paneId: 'p1' })(pointerEvent(10, 10, target))
    drag.onEntryPointerMove(pointerEvent(140, 40, target))
    assert.doesNotThrow(() => drag.onEntryPointerUp(pointerEvent(140, 40, target)))
    assert.equal(drag.consumeSuppressedClick(), true)
  } finally {
    restore()
  }
})

test('a non-primary button or a second pointerup is ignored', () => {
  const calls = []
  const target = captureTarget(calls)
  const { drag } = gesture()

  const rightClick = { ...pointerEvent(10, 10, target), button: 2 }
  drag.onEntryPointerDown({ paneId: 'p1' })(rightClick)
  assert.deepEqual(calls, [])

  drag.onEntryPointerUp(pointerEvent(10, 10, target))
  assert.deepEqual(calls, [], 'a pointerup with no press in flight does nothing')
})