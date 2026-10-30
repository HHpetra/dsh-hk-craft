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
function renderSection({ current = false, started = true, panes, openWorkspace = () => {} } = {}) {
  const { workspaces, sessions, statuses } = snapshots({ current, started })
  return WorkspaceSection({
    t: (key) => zh[key] ?? key,
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(statuses),
    panes,
    openWorkspace,
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
