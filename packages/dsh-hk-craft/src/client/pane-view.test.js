'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const { PANE_CONTENT_OCCURRENCE, createPaneBody, workspaceGroups } = require('./pane-view.js')

/**
 * A React stand-in for the pane body render: only the calls `PaneBody` makes.
 * `pane-view.js` resolves `react` lazily, so installing this through
 * `Module._load` reaches the same module instance the component uses.
 */
function installFakeReact() {
  const originalLoad = Module._load
  const Fragment = Symbol('Fragment')
  class Component {
    constructor(props) {
      this.props = props
    }
  }
  const fake = {
    Fragment,
    Component,
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

/** The controller face `PaneBody` reads: a snapshot plus the actions it calls. */
function fakeController() {
  const state = {
    active: true,
    workspaceId: null,
    layouts: {},
    root: null,
    panes: {},
    activePaneId: null,
    probe: { ok: true, status: 'present' },
    pendingClose: null,
    closeError: null,
    closeBusy: false,
    error: null,
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => state,
    restoreViewFor: () => {},
    closePaneBySession: () => {},
  }
}

test('a pane mounts the embedded conversation.content occurrence', () => {
  const restore = installFakeReact()
  try {
    const renders = []
    const PaneBody = createPaneBody(fakeController())
    PaneBody({
      sessionId: 's1',
      useSession: (selector) =>
        selector({ blank: false, awaitingFirstTurn: false, running: false, openState: 'open' }),
      useSessions: (selector) => selector({ byId: { s1: { blank: false } } }),
      renderFactorySlot: (name, input, options) => {
        renders.push({ name, input, options })
        return null
      },
    })

    assert.equal(PANE_CONTENT_OCCURRENCE, 'embedded')
    assert.equal(renders.length, 1)
    assert.equal(renders[0].name, 'conversation.content')
    // The pane is not inside `main.conversation`, so it must use the non-root
    // occurrence: only that one carries the pinned composer seat.
    assert.equal(renders[0].input.variant, 'embedded')
    assert.equal(renders[0].input.phase, 'active')
    assert.equal(renders[0].input.hero, false)
    assert.equal(typeof renders[0].options.fallback, 'object')
  } finally {
    restore()
  }
})

test('a blank pane still asks for the hero state', () => {
  const restore = installFakeReact()
  try {
    const renders = []
    const PaneBody = createPaneBody(fakeController())
    PaneBody({
      sessionId: 's2',
      useSession: (selector) =>
        selector({ blank: true, awaitingFirstTurn: false, running: false, openState: 'open' }),
      useSessions: (selector) => selector({ byId: { s2: { blank: true } } }),
      renderFactorySlot: (name, input) => {
        renders.push({ name, input })
        return null
      },
    })

    assert.equal(renders[0].input.variant, 'embedded')
    assert.equal(renders[0].input.phase, 'hero')
    assert.equal(renders[0].input.hero, true)
  } finally {
    restore()
  }
})


/** @param {string} paneId @param {string} sessionId */
function pane(paneId, sessionId) {
  return { paneId, sessionId, view: 'chat' }
}

test('every loaded workspace is rendered, exactly one of them visible', () => {
  const state = {
    workspaceId: 'w2',
    layouts: {
      w1: { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: pane('p1', 's1') }, activePaneId: 'p1' },
      w2: { root: { kind: 'leaf', paneId: 'p2' }, panes: { p2: pane('p2', 's2') }, activePaneId: 'p2' },
    },
    root: { kind: 'leaf', paneId: 'p2' },
    panes: { p2: pane('p2', 's2') },
    activePaneId: 'p2',
  }

  const groups = workspaceGroups(state)

  assert.deepEqual(groups.map((group) => group.workspaceId), ['w1', 'w2'])
  assert.deepEqual(groups.map((group) => group.visible), [false, true])
  assert.deepEqual(groups[0].layout, state.layouts.w1)
})

test('the unscoped layout renders when there is no workspace map', () => {
  const state = {
    workspaceId: null,
    layouts: {},
    root: { kind: 'leaf', paneId: 'p1' },
    panes: { p1: pane('p1', 's1') },
    activePaneId: 'p1',
  }

  const groups = workspaceGroups(state)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].workspaceId, null)
  assert.equal(groups[0].visible, true)
  assert.deepEqual(groups[0].layout.root, state.root)
})

test('an empty active workspace still renders its empty state group', () => {
  const state = {
    workspaceId: 'w1',
    layouts: {
      w1: { root: null, panes: {}, activePaneId: null },
      w2: { root: { kind: 'leaf', paneId: 'p2' }, panes: { p2: pane('p2', 's2') }, activePaneId: 'p2' },
    },
    root: null,
    panes: {},
    activePaneId: null,
  }

  const groups = workspaceGroups(state)

  assert.deepEqual(groups.map((group) => group.workspaceId), ['w1', 'w2'])
  assert.equal(groups[0].visible, true)
  assert.equal(groups[0].layout.root, null)
})

test('a missing active workspace falls back to the first rendered group', () => {
  const state = {
    workspaceId: 'gone',
    layouts: {
      w1: { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: pane('p1', 's1') }, activePaneId: 'p1' },
    },
    root: null,
    panes: {},
    activePaneId: null,
  }

  const groups = workspaceGroups(state)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].visible, true)
})
