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
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
function renderSection({ current = false, openWorkspace = () => {}, deleteWorkspace = () => {} } = {}) {
  const { workspaces, sessions, statuses } = snapshots({ current })
  return WorkspaceSection({
    t: (key) => zh[key] ?? key,
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(statuses),
    openWorkspace,
    deleteWorkspace,
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
    restore()
  }
})

test('the delete entry has its own accessible name and never opens the workspace', () => {
  const restore = installFakeReact()
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
