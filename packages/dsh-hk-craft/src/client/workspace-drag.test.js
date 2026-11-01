'use strict'

/**
 * The workspace row drag gesture. The regression these tests lock down is the
 * pointer-capture timing: capturing the row on pointerdown retargets the
 * compatibility click to the row, so the select button's onClick never runs and
 * a workspace click cannot open its workspace. Capture must wait until the press
 * actually becomes a drag; a click below the threshold stays a normal click.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { useWorkspaceDrag } = require('./workspace-drag.js')

/** Only the two React hooks this hook reads. State identity is irrelevant here. */
function fakeReact() {
  return {
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
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

function pointerEvent(clientX, clientY, currentTarget) {
  return {
    button: 0,
    pointerId: 7,
    clientX,
    clientY,
    target: { closest: () => null },
    currentTarget,
    preventDefault() {},
  }
}

/** @param {string[]} [order] */
function gesture(order = ['w1', 'w2'], reorders = []) {
  return useWorkspaceDrag(fakeReact(), {
    order,
    reorderWorkspace: (sourceId, beforeId) => {
      reorders.push([sourceId, beforeId])
      return Promise.resolve()
    },
  })
}

test('a press below the drag threshold never captures the pointer', () => {
  const drag = gesture()
  const calls = []
  const target = captureTarget(calls)
  const down = drag.onRowPointerDown({ workspaceId: 'w2' })

  down(pointerEvent(10, 10, target))
  drag.onRowPointerMove(pointerEvent(13, 14, target)) // 5px: still a click
  drag.onRowPointerUp(pointerEvent(13, 14, target))

  assert.deepEqual(calls, [], 'a click must keep the button as its click target')
  assert.equal(drag.consumeSuppressedClick(), false, 'a click is not swallowed')
})

test('crossing the threshold captures the pointer and releasing ends the capture', () => {
  const drag = gesture()
  const calls = []
  const target = captureTarget(calls)
  const down = drag.onRowPointerDown({ workspaceId: 'w2' })

  down(pointerEvent(10, 10, target))
  drag.onRowPointerMove(pointerEvent(10, 30, target)) // 20px: a drag
  drag.onRowPointerUp(pointerEvent(10, 30, target))

  assert.deepEqual(calls, [
    ['capture', 7],
    ['release', 7],
  ])
})

test('a cancelled drag releases only a capture it actually took', () => {
  const drag = gesture()
  const calls = []
  const target = captureTarget(calls)

  // Cancel before the threshold: no capture was taken, so nothing is released.
  drag.onRowPointerDown({ workspaceId: 'w2' })(pointerEvent(10, 10, target))
  drag.onRowPointerCancel(pointerEvent(10, 10, target))
  assert.deepEqual(calls, [])

  // Cancel after the threshold: release the capture and leave no drag state.
  drag.onRowPointerDown({ workspaceId: 'w2' })(pointerEvent(10, 10, target))
  drag.onRowPointerMove(pointerEvent(10, 30, target))
  drag.onRowPointerCancel(pointerEvent(10, 30, target))
  assert.deepEqual(calls, [['capture', 7], ['release', 7]])
  assert.equal(drag.drag, null)
})

test('a row whose capture is unavailable still starts and ends a drag', () => {
  const drag = gesture()
  const down = drag.onRowPointerDown({ workspaceId: 'w2' })
  const event = {
    ...pointerEvent(10, 10, {}),
    preventDefault() {},
  }

  assert.doesNotThrow(() => {
    down(event)
    drag.onRowPointerMove(pointerEvent(10, 30, {}))
    drag.onRowPointerUp(pointerEvent(10, 30, {}))
  })
})

/** Point every hit-test at one workspace row, then restore `document`. */
function withRowUnderPointer(workspaceId, body) {
  const previous = globalThis.document
  globalThis.document = {
    elementFromPoint() {
      return {
        closest(selector) {
          return selector === '[data-hkcraft-workspace-row]' ? this : null
        },
        getAttribute(name) {
          return name === 'data-hkcraft-workspace-row' ? workspaceId : null
        },
        getBoundingClientRect() {
          return { top: 0, height: 40 }
        },
      }
    },
  }
  try {
    body()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

test('a press released outside the row is not promoted into a drag by a later move', () => {
  const reorders = []
  const drag = gesture(['w1', 'w2'], reorders)
  const calls = []
  const target = captureTarget(calls)
  withRowUnderPointer('w2', () => {
    drag.onRowPointerDown({ workspaceId: 'w1' })(pointerEvent(10, 10, target))
    drag.onRowPointerMove({ ...pointerEvent(10, 30, target), buttons: 0 })
    drag.onRowPointerUp(pointerEvent(10, 30, target))
  })

  assert.deepEqual(calls, [])
  assert.deepEqual(reorders, [])
})

test('a click on the action slot does not submit a drag whose pointerup was lost', () => {
  const reorders = []
  const drag = gesture(['w1', 'w2'], reorders)
  const calls = []
  const target = captureTarget(calls)
  const action = {
    closest(selector) {
      return selector === '[data-hkcraft-workspace-action]' ? {} : null
    },
  }
  withRowUnderPointer('w2', () => {
    drag.onRowPointerDown({ workspaceId: 'w1' })({ ...pointerEvent(10, 10, target), buttons: 1 })
    drag.onRowPointerMove({ ...pointerEvent(10, 30, target), buttons: 1 })
    drag.onRowPointerDown({ workspaceId: 'w2' })({
      ...pointerEvent(10, 30, target),
      target: action,
    })
    drag.onRowPointerUp(pointerEvent(10, 30, target))
  })

  assert.deepEqual(reorders, [])
})

test('a press on the row action slot never starts the gesture', () => {
  const drag = gesture()
  const calls = []
  const target = captureTarget(calls)
  const action = {
    closest(selector) {
      return selector === '[data-hkcraft-workspace-action]' ? {} : null
    },
  }

  drag.onRowPointerDown({ workspaceId: 'w2' })({
    ...pointerEvent(10, 10, target),
    target: action,
  })
  drag.onRowPointerMove(pointerEvent(10, 30, target))
  drag.onRowPointerUp(pointerEvent(10, 30, target))

  assert.deepEqual(calls, [])
})
