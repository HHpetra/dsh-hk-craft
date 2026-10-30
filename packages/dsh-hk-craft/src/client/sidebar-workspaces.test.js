'use strict'

/**
 * The workspace row is the sidebar's one interactive control. Ticket 01 splits
 * it into a row container, a primary select control and an inline action slot
 * without changing what the user sees or can do.
 *
 * These tests render the component with a React stand-in — the same approach as
 * `pane-view.test.js` — and assert what a user (or the next ticket) can observe:
 * the click target, the accessible name, the current marker and the action
 * slot's stable marker. Styles and hover feedback stay on the manual smoke list.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const { WorkspaceSection } = require('./sidebar-workspaces.js')
const { zh } = require('./locale.js')

/**
 * A React stand-in covering only the calls the section makes. The component
 * resolves `react` lazily, so installing this through `Module._load` reaches the
 * same module instance it uses.
 */
function installFakeReact() {
  const originalLoad = Module._load
  const fake = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
  }
  Module._load = function load(request, parent, isMain) {
    if (request === 'react') return fake
    return originalLoad.call(this, request, parent, isMain)
  }
  return () => {
    Module._load = originalLoad
  }
}

/** Flatten the children arrays a fake element carries into one list. */
function childrenOf(element) {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node !== null && node !== undefined && typeof node === 'object') out.push(node)
  }
  walk(element.props.children)
  return out
}

/** Every element below `element`, depth first. */
function descendants(element) {
  return childrenOf(element).flatMap((child) => [child, ...descendants(child)])
}

/** The first element below `element` carrying `attribute`. */
function findByAttribute(element, attribute) {
  if (element === null || element === undefined || typeof element !== 'object') return null
  if (element.props?.[attribute] !== undefined) return element
  for (const child of childrenOf(element)) {
    const found = findByAttribute(child, attribute)
    if (found !== null) return found
  }
  return null
}

/** Every element below `element` carrying `attribute`, depth first. */
function findAllByAttribute(element, attribute) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.props?.[attribute] !== undefined) {
      out.push(node)
      return
    }
    for (const child of childrenOf(node)) walk(child)
  }
  walk(element)
  return out
}

/** One workspace row, matched by its stable marker. */
function rowOf(tree, workspaceId) {
  return findAllByAttribute(tree, 'data-hkcraft-workspace-row').find(
    (row) => row.props['data-hkcraft-workspace-row'] === workspaceId,
  )
}

/** Two workspaces, one with a member session so the light has something to read. */
function snapshots({ current = false } = {}) {
  return {
    workspaces: {
      phase: 'ready',
      items: [
        { workspaceId: 'w1', title: 'Project A', sessionIds: ['s1'] },
        { workspaceId: 'w2', title: 'default-workspace', sessionIds: [] },
      ],
      archivedSessionIds: [],
    },
    sessions: {
      phase: 'ready',
      ids: ['s1'],
      byId: { s1: { id: 's1', running: false, retainedBy: current ? { mainView: 1 } : {} } },
    },
    statuses: new Map(),
  }
}

/** Render the section with the shell hooks stubbed out. */
function renderSection({ current = false, openWorkspace = () => {}, reorderWorkspace = () => {} } = {}) {
  const { workspaces, sessions, statuses } = snapshots({ current })
  return WorkspaceSection({
    t: (key) => zh[key] ?? key,
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(statuses),
    openWorkspace,
    reorderWorkspace,
  })
}

test('a workspace row is a container with a separate select button and an action slot', () => {
  const restore = installFakeReact()
  try {
    const tree = renderSection()
    const row = findByAttribute(tree, 'data-hkcraft-workspace-row')

    assert.notEqual(row, null, 'the row container must be identifiable for pointer handling')
    assert.equal(row.type, 'div', 'the row itself must not be the button any more')
    assert.equal(row.props['data-hkcraft-workspace-row'], 'w1')

    const select = childrenOf(row).find((child) => child.type === 'button')
    assert.notEqual(select, undefined, 'the row must keep a primary select control')
    assert.equal(select.props.type, 'button', 'the select control must stay keyboard focusable')
    assert.deepEqual(
      descendants(select).filter((element) => element.type === 'button'),
      [],
      'the primary select control must not contain another button',
    )

    const action = childrenOf(row).find(
      (child) => child.props?.['data-hkcraft-workspace-action'] !== undefined,
    )
    assert.notEqual(action, undefined, 'the row must reserve an inline action slot')
    assert.equal(
      childrenOf(action).length,
      0,
      'ticket 01 leaves the action slot empty; later tickets fill it',
    )
    assert.equal(
      descendants(select).includes(action),
      false,
      'the action slot must be a sibling of the select control, never nested inside it',
    )
  } finally {
    restore()
  }
})

test('the select control keeps the workspace name, light and click target', () => {
  const restore = installFakeReact()
  try {
    const opened = []
    const tree = renderSection({ openWorkspace: (workspaceId) => opened.push(workspaceId) })

    const buttons = descendants(tree).filter((element) => element.type === 'button')
    const select = buttons.find((button) => button.props['aria-label']?.startsWith('Project A'))

    assert.notEqual(select, undefined, 'the row keeps a control named after its workspace')
    assert.equal(select.props['aria-label'], 'Project A — 无活动会话')
    assert.equal(select.props.title, 'Project A — 无活动会话')

    select.props.onClick()
    assert.deepEqual(opened, ['w1'], 'clicking still opens or switches that workspace')
  } finally {
    restore()
  }
})

test('the current workspace still marks its select control', () => {
  const restore = installFakeReact()
  try {
    const tree = renderSection({ current: true })
    const buttons = descendants(tree).filter((element) => element.type === 'button')
    const current = buttons.find((button) => button.props['aria-label']?.startsWith('Project A'))

    assert.equal(current.props['aria-current'], 'true')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Drag to reorder (ticket 04). The row container is the pointer target; a press
// only becomes a drag after 6px, and the drop row is hit-tested because pointer
// capture keeps the move events on the source row.
// ---------------------------------------------------------------------------

/** A pointer event shaped like the subset the row handlers read. */
function pointerEvent(clientX, clientY, { target = null } = {}) {
  return {
    button: 0,
    pointerId: 7,
    clientX,
    clientY,
    target: target ?? { closest: () => null },
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
    preventDefault() {},
  }
}

/** The element `document.elementFromPoint` returns for a row under the pointer. */
function fakeRowElement(workspaceId, rect) {
  const element = {
    getBoundingClientRect: () => rect,
    getAttribute: (name) => (name === 'data-hkcraft-workspace-row' ? workspaceId : null),
    closest(selector) {
      return selector === '[data-hkcraft-workspace-row]' ? element : null
    },
  }
  return element
}

/** Run `body` with `document.elementFromPoint` resolving to `element`. */
function withElementFromPoint(element, body) {
  const previous = globalThis.document
  globalThis.document = { elementFromPoint: () => element }
  try {
    body()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

/** The row's primary control, which is what a click opens the workspace with. */
function selectOf(row) {
  return childrenOf(row).find((child) => child.type === 'button')
}

test('a press shorter than six pixels still opens the workspace', () => {
  const restore = installFakeReact()
  try {
    const opened = []
    const reorders = []
    const tree = renderSection({
      openWorkspace: (workspaceId) => opened.push(workspaceId),
      reorderWorkspace: (...args) => reorders.push(args),
    })
    const row = rowOf(tree, 'w2')

    row.props.onPointerDown(pointerEvent(50, 50))
    row.props.onPointerMove(pointerEvent(54, 53)) // 5px: still a click
    row.props.onPointerUp(pointerEvent(54, 53))
    selectOf(row).props.onClick()

    assert.deepEqual(reorders, [], 'a click must not write an order')
    assert.deepEqual(opened, ['w2'], 'the click still opens the workspace')
  } finally {
    restore()
  }
})

test('a drag past six pixels reorders and swallows the click that follows', () => {
  const restore = installFakeReact()
  try {
    const opened = []
    const reorders = []
    const tree = renderSection({
      openWorkspace: (workspaceId) => opened.push(workspaceId),
      reorderWorkspace: (sourceId, beforeId) => {
        reorders.push([sourceId, beforeId])
        return Promise.resolve()
      },
    })
    const source = rowOf(tree, 'w2')

    // w2 is dragged onto the upper half of w1, so it must land before w1.
    withElementFromPoint(fakeRowElement('w1', { top: 100, height: 30 }), () => {
      source.props.onPointerDown(pointerEvent(50, 150))
      source.props.onPointerMove(pointerEvent(50, 110))
      source.props.onPointerUp(pointerEvent(50, 110))
    })
    // The browser follows pointerup with a click on the source row's control.
    selectOf(source).props.onClick()

    assert.deepEqual(reorders, [['w2', 'w1']])
    assert.deepEqual(opened, [], 'the click after a drag must be swallowed')
  } finally {
    restore()
  }
})

test('the lower half of the last row appends the dragged workspace', () => {
  const restore = installFakeReact()
  try {
    const reorders = []
    const tree = renderSection({
      reorderWorkspace: (sourceId, beforeId) => {
        reorders.push([sourceId, beforeId])
      },
    })
    const source = rowOf(tree, 'w1')

    withElementFromPoint(fakeRowElement('w2', { top: 100, height: 30 }), () => {
      source.props.onPointerDown(pointerEvent(50, 140))
      source.props.onPointerMove(pointerEvent(50, 125)) // lower half of the last row
      source.props.onPointerUp(pointerEvent(50, 125))
    })

    assert.deepEqual(reorders, [['w1', undefined]], 'an undefined anchor means append')
  } finally {
    restore()
  }
})

test('dropping a row back where it already is writes nothing', () => {
  const restore = installFakeReact()
  try {
    const opened = []
    const reorders = []
    const tree = renderSection({
      openWorkspace: (workspaceId) => opened.push(workspaceId),
      reorderWorkspace: (...args) => reorders.push(args),
    })
    const source = rowOf(tree, 'w1')

    // w1 on the upper half of w2 would already be w1 before w2.
    withElementFromPoint(fakeRowElement('w2', { top: 100, height: 30 }), () => {
      source.props.onPointerDown(pointerEvent(50, 140))
      source.props.onPointerMove(pointerEvent(50, 105))
      source.props.onPointerUp(pointerEvent(50, 105))
    })
    selectOf(source).props.onClick()

    assert.deepEqual(reorders, [], 'a no-op drop must not write an order')
    assert.deepEqual(opened, [], 'the drag still swallowed the click')
  } finally {
    restore()
  }
})

test('a press on the row action slot never starts a drag', () => {
  const restore = installFakeReact()
  try {
    const opened = []
    const reorders = []
    const tree = renderSection({
      openWorkspace: (workspaceId) => opened.push(workspaceId),
      reorderWorkspace: (...args) => reorders.push(args),
    })
    const source = rowOf(tree, 'w2')
    const actionTarget = {
      closest: (selector) => (selector === '[data-hkcraft-workspace-action]' ? {} : null),
    }

    withElementFromPoint(fakeRowElement('w1', { top: 100, height: 30 }), () => {
      source.props.onPointerDown(pointerEvent(50, 150, { target: actionTarget }))
      source.props.onPointerMove(pointerEvent(50, 110))
      source.props.onPointerUp(pointerEvent(50, 110))
    })
    selectOf(source).props.onClick()

    assert.deepEqual(reorders, [], 'a row action press must not reorder')
    assert.deepEqual(opened, ['w2'], 'and it must not swallow the click either')
  } finally {
    restore()
  }
})

test('only one reorder request may be in flight at a time', () => {
  const restore = installFakeReact()
  try {
    const reorders = []
    const tree = renderSection({
      reorderWorkspace: (sourceId, beforeId) => {
        reorders.push([sourceId, beforeId])
        return new Promise(() => {})
      },
    })
    const source = rowOf(tree, 'w2')
    const drag = () => {
      withElementFromPoint(fakeRowElement('w1', { top: 100, height: 30 }), () => {
        source.props.onPointerDown(pointerEvent(50, 150))
        source.props.onPointerMove(pointerEvent(50, 110))
        source.props.onPointerUp(pointerEvent(50, 110))
      })
    }

    drag()
    drag()

    assert.equal(reorders.length, 1, 'a second drag must not race the first request')
  } finally {
    restore()
  }
})
