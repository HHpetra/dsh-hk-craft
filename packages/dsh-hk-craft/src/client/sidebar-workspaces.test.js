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
 *
 * `useSyncExternalStore` is present because the section subscribes to the pane
 * controller's snapshot (ticket 02); the stand-in runs the subscription once and
 * reads the current snapshot, which is all a static render needs.
 */
function installFakeReact() {
  const originalLoad = Module._load
  const calls = { subscribe: 0 }
  const fake = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => {
      calls.subscribe += 1
      subscribe(() => {})
      return getSnapshot()
    },
  }
  Module._load = function load(request, parent, isMain) {
    if (request === 'react') return fake
    return originalLoad.call(this, request, parent, isMain)
  }
  return {
    calls,
    restore() {
      Module._load = originalLoad
    },
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
function snapshots({ current = false, started = true } = {}) {
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
      byId: {
        s1: { id: 's1', running: false, blank: !started, retainedBy: current ? { mainView: 1 } : {} },
      },
    },
    statuses: new Map(),
  }
}

/** The pane controller face the section reads enablement from (ticket 02). */
function paneFace(enabledIds) {
  const enabled = new Set(enabledIds)
  const calls = { subscribe: 0, getSnapshot: 0 }
  return {
    calls,
    panes: {
      isWorkspaceEnabled: (workspaceId) => enabled.has(workspaceId),
      subscribe() {
        calls.subscribe += 1
        return () => {}
      },
      getSnapshot() {
        calls.getSnapshot += 1
        return { active: true, workspaceId: 'w1' }
      },
    },
  }
}

/** Render the section with the shell hooks stubbed out. */
function renderSection({
  current = false,
  started = true,
  panes,
  openWorkspace = () => {},
  deleteWorkspace = () => {},
  reorderWorkspace = () => {},
} = {}) {
  const { workspaces, sessions, statuses } = snapshots({ current, started })
  return WorkspaceSection({
    t: (key) => zh[key] ?? key,
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(statuses),
    panes,
    openWorkspace,
    deleteWorkspace,
    reorderWorkspace,
  })
}

test('a workspace row is a container with a separate select button and an action slot', () => {
  const fakeReact = installFakeReact()
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
    // Ticket 03 fills the slot with the delete entry; ticket 04 relies on the
    // marker to ignore presses that belong to a row action.
    const actionButtons = descendants(action).filter((element) => element.type === 'button')
    assert.equal(actionButtons.length, 1, 'the action slot holds exactly the delete entry')
    assert.equal(actionButtons[0].props['data-hkcraft-workspace-delete'], 'w1')
    assert.equal(
      descendants(select).includes(action),
      false,
      'the action slot must be a sibling of the select control, never nested inside it',
    )
  } finally {
    fakeReact.restore()
  }
})

test('the delete entry has its own accessible name and never opens the workspace', () => {
  const fakeReact = installFakeReact()
  try {
    const opened = []
    const tree = renderSection({ openWorkspace: (workspaceId) => opened.push(workspaceId) })

    const rows = descendants(tree).filter(
      (element) => element.props?.['data-hkcraft-workspace-row'] !== undefined,
    )
    assert.equal(rows.length, 2)

    for (const row of rows) {
      const workspaceId = row.props['data-hkcraft-workspace-row']
      const action = childrenOf(row).find(
        (child) => child.props?.['data-hkcraft-workspace-action'] !== undefined,
      )
      const del = descendants(action).find((element) => element.type === 'button')
      assert.notEqual(del, undefined, 'every row keeps a delete entry in the action slot')
      assert.equal(del.props.type, 'button')
      assert.equal(del.props['data-hkcraft-workspace-delete'], workspaceId)
      // Independent accessible name: it says both what it does and which row.
      assert.match(del.props['aria-label'], /删除工作区/)
      assert.match(del.props['aria-label'], /Project A|默认工作区/)
      assert.equal(del.props.title, del.props['aria-label'])
      let stopped = 0
      del.props.onClick({ stopPropagation: () => (stopped += 1) })
      assert.equal(stopped, 1, 'a row action must not bubble into a row gesture')
    }

    assert.deepEqual(opened, [], 'pressing delete must not open the workspace')
  } finally {
    fakeReact.restore()
  }
})

test('the select control keeps the workspace name, light and click target', () => {
  const fakeReact = installFakeReact()
  try {
    const opened = []
    const tree = renderSection({ openWorkspace: (workspaceId) => opened.push(workspaceId) })

    const buttons = descendants(tree).filter((element) => element.type === 'button')
    const select = buttons.find((button) => button.props['aria-label']?.startsWith('Project A'))

    assert.notEqual(select, undefined, 'the row keeps a control named after its workspace')
    assert.equal(select.props['aria-label'], 'Project A — 对话已结束')
    assert.equal(select.props.title, 'Project A — 对话已结束')

    select.props.onClick()
    assert.deepEqual(opened, ['w1'], 'clicking still opens or switches that workspace')
  } finally {
    fakeReact.restore()
  }
})

test('a workspace that was never opened in split reads as gray, not as finished', () => {
  const fakeReact = installFakeReact()
  try {
    // No pane controller: the degraded projection assumes every workspace is
    // enabled, and this workspace has a started conversation — so it is green.
    const degraded = renderSection()
    const degradedSelect = descendants(degraded)
      .filter((element) => element.type === 'button')
      .find((button) => button.props['aria-label']?.startsWith('Project A'))
    assert.equal(degradedSelect.props['aria-label'], 'Project A — 对话已结束')

    // With a controller that says "never opened in split", the same workspace is
    // gray even though its stored conversation has finished.
    const { panes } = paneFace([])
    const tree = renderSection({ panes })
    const select = descendants(tree)
      .filter((element) => element.type === 'button')
      .find((button) => button.props['aria-label']?.startsWith('Project A'))
    assert.equal(select.props['aria-label'], 'Project A — 未启用 / 还没有对话结束')
    assert.equal(select.props.title, 'Project A — 未启用 / 还没有对话结束')
  } finally {
    fakeReact.restore()
  }
})

test('an enabled workspace full of blank conversations still reads gray', () => {
  const fakeReact = installFakeReact()
  try {
    const { panes } = paneFace(['w1'])
    const tree = renderSection({ panes, started: false })
    const select = descendants(tree)
      .filter((element) => element.type === 'button')
      .find((button) => button.props['aria-label']?.startsWith('Project A'))
    assert.equal(select.props['aria-label'], 'Project A — 未启用 / 还没有对话结束')
  } finally {
    fakeReact.restore()
  }
})

test('the section subscribes to the pane controller so the light follows an open', () => {
  const fakeReact = installFakeReact()
  try {
    const { panes, calls } = paneFace(['w1'])
    renderSection({ panes })

    assert.equal(calls.subscribe, 1, 'the section must follow the controller snapshot')
    assert.equal(calls.getSnapshot, 1)
  } finally {
    fakeReact.restore()
  }
})

test('the current workspace still marks its select control', () => {
  const fakeReact = installFakeReact()
  try {
    const tree = renderSection({ current: true })
    const buttons = descendants(tree).filter((element) => element.type === 'button')
    const current = buttons.find((button) => button.props['aria-label']?.startsWith('Project A'))

    assert.equal(current.props['aria-current'], 'true')
  } finally {
    fakeReact.restore()
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
  const fakeReact = installFakeReact()
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
    fakeReact.restore()
  }
})

test('a drag past six pixels reorders and swallows the click that follows', () => {
  const fakeReact = installFakeReact()
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
    fakeReact.restore()
  }
})

test('the lower half of the last row appends the dragged workspace', () => {
  const fakeReact = installFakeReact()
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
    fakeReact.restore()
  }
})

test('dropping a row back where it already is writes nothing', () => {
  const fakeReact = installFakeReact()
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
    fakeReact.restore()
  }
})

test('a press on the row action slot never starts a drag', () => {
  const fakeReact = installFakeReact()
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
    fakeReact.restore()
  }
})

test('only one reorder request may be in flight at a time', () => {
  const fakeReact = installFakeReact()
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
    fakeReact.restore()
  }
})
