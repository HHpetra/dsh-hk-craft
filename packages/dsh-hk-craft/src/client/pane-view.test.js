'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const {
  PANE_CONTENT_OCCURRENCE,
  PaneFrame,
  PaneViewToggle,
  createPaneBody,
  createPaneConversationViews,
  paneViewOfSession,
  workspaceGroups,
} = require('./pane-view.js')

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
    subscribeViewAvailability: () => () => {},
    isTrajectoryAvailable: () => true,
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
    // The pane replaces the factory's `views` local slot so its layout record,
    // not ui-conversation's own View store, chooses the rendered View.
    assert.equal(typeof renders[0].options.slots.views, 'function')
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


test('paneViewOfSession reads the pane layout record across loaded workspaces', () => {
  const state = {
    layouts: {
      w1: { panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'chat' } } },
      w2: { panes: { p2: { paneId: 'p2', sessionId: 's2', view: 'trajectory' } } },
    },
    panes: {},
  }

  assert.equal(paneViewOfSession(state, 's1'), 'chat')
  assert.equal(paneViewOfSession(state, 's2'), 'trajectory')
  assert.equal(paneViewOfSession(state, 'gone'), 'chat')
  assert.equal(
    paneViewOfSession({ layouts: {}, panes: { p9: { paneId: 'p9', sessionId: 's9', view: 'trajectory' } } }, 's9'),
    'trajectory',
  )
})

test('the views override renders conversation.session with the layout view', () => {
  const restore = installFakeReact()
  try {
    const state = {
      layouts: {
        w1: {
          panes: {
            p1: { paneId: 'p1', sessionId: 's1', view: 'chat' },
            p2: { paneId: 'p2', sessionId: 's2', view: 'trajectory' },
          },
        },
      },
      panes: {},
    }
    const switches = []
    const controller = {
      subscribe: () => () => {},
      getSnapshot: () => state,
      subscribeViewAvailability: () => () => {},
      isTrajectoryAvailable: () => true,
      setView: (paneId, view) => {
        switches.push([paneId, view])
        return true
      },
    }
    const Views = createPaneConversationViews(controller)
    const renders = []
    Views({
      sessionId: 's2',
      renderSlot: (name, props) => {
        renders.push({ name, props })
        return null
      },
    })

    assert.equal(renders.length, 1)
    assert.equal(renders[0].name, 'conversation.session')
    assert.equal(renders[0].props.view, 'trajectory')
    // The shell's in-conversation openView jump (tool-call inspect) must be
    // routed into this pane's layout, not swallowed by the forced view.
    renders[0].props.openView('chat')
    assert.deepEqual(switches, [['p2', 'chat']])
  } finally {
    restore()
  }
})

test('the views override falls back to chat while developer tools hide trajectory', () => {
  const restore = installFakeReact()
  try {
    const state = {
      layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'trajectory' } } } },
      panes: {},
    }
    const controller = {
      subscribe: () => () => {},
      getSnapshot: () => state,
      subscribeViewAvailability: () => () => {},
      isTrajectoryAvailable: () => false,
      setView: () => true,
    }
    const Views = createPaneConversationViews(controller)
    const renders = []
    Views({
      sessionId: 's1',
      renderSlot: (name, props) => {
        renders.push({ name, props })
        return null
      },
    })

    assert.equal(renders.length, 1)
    assert.equal(renders[0].name, 'conversation.session')
    assert.equal(renders[0].props.view, 'chat')
  } finally {
    restore()
  }
})

/** @param {string} paneId @param {string} sessionId */
function pane(paneId, sessionId) {
  return { paneId, sessionId, view: 'chat' }
}

/** Every element in the fake-React tree, so header assertions can search. */
function elementsOf(element, out = []) {
  if (element === null || typeof element !== 'object') return out
  out.push(element)
  for (const child of element.props?.children ?? []) elementsOf(child, out)
  return out
}

/** The controller face the header reads; `t` returns the key, so copy is visible. */
function headerController({ trajectory = true, calls = [] } = {}) {
  return {
    calls,
    paneReference: () => ({ sessionId: 's1' }),
    closePane: (paneId) => calls.push(['close', paneId]),
    focusPane: () => {},
    setView: (paneId, view) => {
      calls.push(['view', paneId, view])
      return true
    },
    subscribeViewAvailability: () => () => {},
    isTrajectoryAvailable: () => trajectory,
  }
}

test('the pane header offers exactly a view toggle and a close button', () => {
  const restore = installFakeReact()
  try {
    const controller = headerController()
    const frame = PaneFrame({
      controller,
      pane: pane('p1', 's1'),
      rect: { x: 0, y: 0, width: 1, height: 1 },
      focused: false,
      kit: { SessionProvider: () => null, renderSlot: () => null },
      t: (key) => key,
    })

    const header = frame.props.children[0]
    const actions = header.props.children.slice(1)
    assert.equal(actions.length, 2, 'the header must not keep a split/more button row')
    assert.equal(actions[0].type, PaneViewToggle)
    assert.equal(actions[1].props['data-hkcraft-pane-close'], 'p1')
    assert.equal(actions[1].props['aria-label'], 'pane.close')
    assert.equal(actions[1].props.title, 'pane.close (Ctrl+Shift+X)')

    const all = elementsOf(frame)
    assert.equal(
      all.some((element) => element.props?.['data-hkcraft-pane-more'] !== undefined),
      false,
      'the ⋯ menu is gone',
    )
    assert.equal(
      all.some((element) => element.props?.role === 'menu'),
      false,
      'no split menu is rendered',
    )
    for (const element of all) {
      const text = `${element.props?.title ?? ''} ${element.props?.['aria-label'] ?? ''}`
      assert.equal(text.includes('pane.splitRight'), false)
      assert.equal(text.includes('pane.splitDown'), false)
    }
  } finally {
    restore()
  }
})

test('the view toggle names the other view and switches it with one click', () => {
  const restore = installFakeReact()
  try {
    const calls = []
    const controller = headerController({ calls })
    const t = (key) => key

    const chat = PaneViewToggle({ controller, pane: pane('p1', 's1'), t })
    assert.equal(chat.props['data-hkcraft-view-toggle'], 'chat')
    assert.equal(chat.props['aria-label'], 'pane.view.title: pane.view.chat → pane.view.trajectory')
    assert.deepEqual(chat.props.children, ['pane.view.trajectory'])
    chat.props.onClick()

    const trajectory = PaneViewToggle({
      controller,
      pane: { ...pane('p1', 's1'), view: 'trajectory' },
      t,
    })
    assert.equal(trajectory.props['data-hkcraft-view-toggle'], 'trajectory')
    assert.equal(trajectory.props['aria-label'], 'pane.view.title: pane.view.trajectory → pane.view.chat')
    assert.deepEqual(trajectory.props.children, ['pane.view.chat'])
    trajectory.props.onClick()

    assert.deepEqual(calls, [
      ['view', 'p1', 'trajectory'],
      ['view', 'p1', 'chat'],
    ])
  } finally {
    restore()
  }
})

test('the view toggle is absent while developer tools hide the trajectory view', () => {
  const restore = installFakeReact()
  try {
    const controller = headerController({ trajectory: false })

    assert.equal(PaneViewToggle({ controller, pane: pane('p1', 's1'), t: (key) => key }), null)
  } finally {
    restore()
  }
})

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
