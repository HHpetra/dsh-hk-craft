'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { withFakeReact } = require('./fake-react.js')

const {
  PANE_CONTENT_OCCURRENCE,
  PaneFrame,
  PaneEmptyState,
  PaneWorkspace,
  PaneStrip,
  PaneViewToggle,
  createPaneBody,
  createPaneHost,
  createPaneConversationViews,
  paneViewOfSession,
  workspaceGroups,
} = require('./pane-view.js')
const { zh } = require('./locale.js')

/**
 * A React stand-in for the pane body render: only the calls `PaneBody` makes.
 * `pane-view.js` resolves `react` lazily, so the shared installer routes it to
 * this instance.
 */
const fakeReact = {
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
    close: { bySession: () => {} },
    view: {
      restoreViewFor: () => {},
      subscribeViewAvailability: () => () => {},
      isTrajectoryAvailable: () => true,
    },
  }
}

test('a pane mounts the embedded conversation.content occurrence', () => {
  withFakeReact(fakeReact, () => {
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
  })
})

test('a blank pane still asks for the hero state', () => {
  withFakeReact(fakeReact, () => {
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
  })
})

test('a restarted conversation whose list blank is stale still mounts the transcript', () => {
  withFakeReact(fakeReact, () => {
    const renders = []
    const PaneBody = createPaneBody(fakeController())
    PaneBody({
      sessionId: 's1',
      useSession: (selector) =>
        selector({
          blank: true,
          awaitingFirstTurn: false,
          running: false,
          promptAttempted: false,
          openState: 'open',
        }),
      useSessions: (selector) =>
        selector({
          byId: {
            s1: {
              id: 's1',
              blank: true,
              projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 10 } },
            },
          },
        }),
      renderFactorySlot: (_name, input) => {
        renders.push(input)
        return null
      },
    })

    assert.equal(renders[0].phase, 'active')
    assert.equal(renders[0].hero, false)
  })
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
  withFakeReact(fakeReact, () => {
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
      view: {
        subscribeViewAvailability: () => () => {},
        isTrajectoryAvailable: () => true,
        setView: (paneId, view) => {
          switches.push([paneId, view])
          return true
        },
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
  })
})

test('the views override falls back to chat while developer tools hide trajectory', () => {
  withFakeReact(fakeReact, () => {
    const state = {
      layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'trajectory' } } } },
      panes: {},
    }
    const controller = {
      subscribe: () => () => {},
      getSnapshot: () => state,
      view: {
        subscribeViewAvailability: () => () => {},
        isTrajectoryAvailable: () => false,
        setView: () => true,
      },
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
  })
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
    close: { request: (paneId) => calls.push(['close', paneId]) },
    layout: {
      paneReference: () => ({ sessionId: 's1' }),
      focusPane: () => {},
    },
    view: {
      setView: (paneId, view) => {
        calls.push(['view', paneId, view])
        return true
      },
      subscribeViewAvailability: () => () => {},
      isTrajectoryAvailable: () => trajectory,
    },
  }
}

test('keyboard focus inside a pane focuses that pane', () => {
  withFakeReact(fakeReact, () => {
    const calls = []
    const controller = headerController()
    controller.layout.focusPane = (paneId) => calls.push(paneId)
    const frame = PaneFrame({
      controller,
      pane: pane('p1', 's1'),
      rect: { x: 0, y: 0, width: 1, height: 1 },
      focused: false,
      kit: { SessionProvider: () => null, renderSlot: () => null },
      t: (key) => key,
    })
    frame.props.onFocusCapture()
    assert.deepEqual(calls, ['p1'])

    const focused = PaneFrame({
      controller,
      pane: pane('p1', 's1'),
      rect: { x: 0, y: 0, width: 1, height: 1 },
      focused: true,
      kit: { SessionProvider: () => null, renderSlot: () => null },
      t: (key) => key,
    })
    focused.props.onFocusCapture()
    assert.deepEqual(calls, ['p1'])
  })
})

test('pressing an already focused pane reveals its session before the click', () => {
  withFakeReact(fakeReact, () => {
    const revealed = []
    const focusedCalls = []
    const controller = headerController()
    controller.layout.focusPane = (paneId) => focusedCalls.push(paneId)
    controller.revealFocusedSession = () => {
      revealed.push('s1')
      return true
    }
    const frame = PaneFrame({
      controller,
      pane: pane('p1', 's1'),
      rect: { x: 0, y: 0, width: 1, height: 1 },
      focused: true,
      kit: { SessionProvider: () => null, renderSlot: () => null },
      t: (key) => key,
    })

    frame.props.onPointerDownCapture()

    assert.deepEqual(focusedCalls, [])
    assert.deepEqual(revealed, ['s1'])
  })
})

test('focusing a strip tab focuses that pane', () => {
  withFakeReact(fakeReact, () => {
    const calls = []
    const controller = {
      close: { request: () => {} },
      budget: { newPane: () => {} },
      layout: {
        focusPane: (paneId) => calls.push(paneId),
        swapPanes: () => {},
      },
    }
    const state = {
      root: {
        kind: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', paneId: 'p1' },
        b: { kind: 'leaf', paneId: 'p2' },
      },
      panes: {
        p1: { paneId: 'p1', sessionId: 's1', view: 'chat' },
        p2: { paneId: 'p2', sessionId: 's2', view: 'chat' },
      },
      activePaneId: 'p1',
    }
    const view = PaneStrip({
      controller,
      state,
      maxPanes: 4,
      kit: {
        useSessions: (selector) => selector({ byId: { s1: { title: 'One' }, s2: { title: 'Two' } } }),
        useSessionStatus: (selector) => selector({}),
      },
      t: (key) => key,
    })
    const tab = elementWhere(view, (node) => node.props?.['data-hkcraft-strip-item'] === 'p2')
    tab.props.onFocus()
    assert.deepEqual(calls, ['p2'])
  })
})

test('the pane header offers a view toggle and a close button when no seats are supplied', () => {
  withFakeReact(fakeReact, () => {
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
    assert.equal(
      header.props.children[0].props.style.flex,
      '0 1 auto',
      'the title keeps its content width so the controls sit next to it',
    )
    const actions = header.props.children.filter(Boolean).slice(1)
    assert.equal(actions.length, 2, 'the header must not keep a split/more button row')
    assert.equal(actions[0].type, PaneViewToggle)
    assert.equal(actions[1].props['data-hkcraft-pane-close'], 'p1')
    assert.equal(actions[1].props.style.marginLeft, 'auto', 'the close button owns the far right edge')
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
  })
})

test('the view toggle names the other view and switches it with one click', () => {
  withFakeReact(fakeReact, () => {
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
  })
})

test('the view toggle is absent while developer tools hide the trajectory view', () => {
  withFakeReact(fakeReact, () => {
    const controller = headerController({ trajectory: false })

    assert.equal(PaneViewToggle({ controller, pane: pane('p1', 's1'), t: (key) => key }), null)
  })
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

/* ── strip action group: empty seats take no box ─────────────────────────── */

/** The element children a fake React element carries, flattening arrays. */
function elementChildren(element) {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node !== null && node !== undefined && typeof node === 'object') out.push(node)
  }
  walk(element?.props?.children)
  return out
}

test('both pane-header seats receive that pane session and its own width cap', () => {
  withFakeReact(fakeReact, () => {
    const ModeSeat = () => null
    const SubagentsSeat = () => null
    const sessions = { byId: { s2: { id: 's2', title: 'Second' } } }
    const statuses = new Map()
    const frame = PaneFrame({
      controller: headerController(),
      pane: pane('p2', 's2'),
      rect: { x: 0, y: 0, width: 1, height: 1 },
      focused: true,
      kit: {
        SessionProvider: () => null,
        renderSlot: () => null,
        useSessions: (selector) => selector(sessions),
        useSessionStatus: (selector) => selector(statuses),
      },
      t: (key) => key,
      seats: { mode: ModeSeat, subagents: SubagentsSeat },
    })

    const header = frame.props.children[0]
    assert.equal(header.props.children.length, 5, 'title + mode + subagents + view + close')
    const modeElement = header.props.children[1]
    const subagentElement = header.props.children[2]
    assert.equal(modeElement.type, ModeSeat)
    assert.equal(subagentElement.type, SubagentsSeat)
    assert.equal(header.props.children[3].type, PaneViewToggle)

    assert.equal(modeElement.props.sessionId, 's2')
    assert.equal(subagentElement.props.sessionId, 's2')
    // Both seats read the same catalog, not the raw snapshots: the header is the
    // only place that knows which hooks dsh's slot kit supplies.
    assert.equal(modeElement.props.catalog, subagentElement.props.catalog)
    assert.equal(modeElement.props.catalog.session('s2').title, 'Second')
    assert.deepEqual(
      [modeElement.props.seatStyle.maxWidth, subagentElement.props.seatStyle.maxWidth],
      [140, 160],
    )
  })
})

/** @returns {object|undefined} the first element whose props satisfy `predicate` */
function elementWhere(node, predicate) {
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = elementWhere(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node === 'string' || typeof node === 'number') return undefined
  if (predicate(node)) return node
  return elementWhere(node.props?.children, predicate)
}

/** The strip's `+` element for one snapshot and pane cap. */
function stripPlus(maxPanes) {
  const controller = {
    close: { request: () => {} },
    budget: { newPane: () => {} },
    layout: { focusPane: () => {}, swapPanes: () => {} },
  }
  const state = {
    root: { kind: 'leaf', paneId: 'p1' },
    panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'chat' } },
    activePaneId: 'p1',
  }
  const t = (key, params) => (zh[key] ?? key).replace('{n}', String(params?.n ?? ''))
  const view = PaneStrip({
    controller,
    state,
    maxPanes,
    kit: {
      useSessions: (selector) => selector({ byId: { s1: { title: 'One' } } }),
      useSessionStatus: (selector) => selector({}),
    },
    t,
  })
  return { view, plus: elementWhere(view, (node) => node.props?.['data-hkcraft-strip-new'] === '') }
}

test('the strip split control is disabled at the pane cap and explains why', () => {
  withFakeReact(fakeReact, () => {
    const { plus } = stripPlus(1)

    assert.notEqual(plus, undefined)
    assert.equal(plus.props.disabled, false)
    assert.equal(plus.props['aria-disabled'], 'true')
    assert.equal(plus.props['data-hkcraft-strip-budget'], 'true')
    assert.equal(plus.props.title, zh['strip.budget'].replace('{n}', '1'))
  })
})

/** The strip element for a right-bar availability pair. */
function stripWithRightbar({
  available,
  expanded,
  tools = [],
  toggle = () => {},
  openTool = () => {},
  reveal = () => {},
}) {
  const controller = {
    close: { request: () => {} },
    budget: { newPane: () => {} },
    focusPane: () => {},
    swapPanes: () => {},
    revealFocusedSession: reveal,
    panel: { toggle, openTool },
  }
  const state = {
    root: { kind: 'leaf', paneId: 'p1' },
    panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'chat' } },
    activePaneId: 'p1',
  }
  const t = (key) => zh[key] ?? key
  const view = PaneStrip({
    controller,
    state,
    rightbarAvailable: available,
    rightbarExpanded: expanded,
    rightbarTools: tools,
    kit: {
      useSessions: (selector) => selector({ byId: { s1: { title: 'One' } } }),
      useSessionStatus: (selector) => selector({}),
    },
    t,
  })
  return {
    view,
    button: elementWhere(view, (node) => node.props?.['data-hkcraft-rightbar-toggle'] === ''),
  }
}

test('the strip renders one rightbar toggle and clicks it through the controller', () => {
  withFakeReact(fakeReact, () => {
    const calls = []
    const { button } = stripWithRightbar({
      available: true,
      expanded: false,
      toggle: () => {
        calls.push('toggle')
      },
    })

    assert.notEqual(button, undefined)
    assert.equal(button.props['aria-pressed'], 'false')
    assert.equal(button.props['aria-label'], '打开右侧边栏')
    const glyph = button.props.children[0]
    assert.equal(glyph.type, 'svg')
    button.props.onClick()
    assert.deepEqual(calls, ['toggle'])
  })
})

test('the strip hides the expand icon while the right bar is open', () => {
  withFakeReact(fakeReact, () => {
    const { button } = stripWithRightbar({ available: true, expanded: true })
    assert.equal(button, undefined)
  })
})

test('the strip opens each native right-bar tool from its icon', () => {
  withFakeReact(fakeReact, () => {
    function FilesIcon() {
      return null
    }
    function TerminalIcon() {
      return null
    }
    const calls = []
    const reveals = []
    const { view } = stripWithRightbar({
      available: true,
      expanded: true,
      tools: [
        { kind: 'files', entryId: 'workspace', providerId: 'files', title: '文件', icon: FilesIcon },
        { kind: 'terminal', entryId: 'new', providerId: 'terminal', title: '终端', icon: TerminalIcon },
      ],
      reveal: () => reveals.push('reveal'),
      openTool: (kind, sessionId) => {
        calls.push([kind, sessionId])
      },
    })
    const files = elementWhere(view, (node) => node.props?.['data-hkcraft-rightbar-tool'] === 'files')
    const terminal = elementWhere(view, (node) => node.props?.['data-hkcraft-rightbar-tool'] === 'terminal')
    assert.equal(files.props['aria-label'], '文件')
    assert.equal(elementWhere(files, (node) => node.type === FilesIcon) !== undefined, true)
    assert.equal(terminal.props['aria-label'], '终端')
    files.props.onClick()
    terminal.props.onClick()
    // A tool click must reveal the focused pane first and open the page on that
    // pane's Session, not on the right bar's possibly stale mounted Session.
    assert.deepEqual(reveals, ['reveal', 'reveal'])
    assert.deepEqual(calls, [['files', 's1'], ['terminal', 's1']])
  })
})

test('the strip hides the rightbar toggle when the service is absent', () => {
  withFakeReact(fakeReact, () => {
    const { button } = stripWithRightbar({ available: false, expanded: false })
    assert.equal(button, undefined)
  })
})

test('the pane host stays mounted when split mode is off', () => {
  withFakeReact(fakeReact, () => {
    const controller = {
      subscribe: () => () => {},
      getSnapshot: () => ({
        active: false,
        error: null,
        workspaceId: null,
        layouts: {},
        root: null,
        panes: {},
        activePaneId: null,
        maxPanes: 4,
        pendingClose: null,
        rightbarAvailable: false,
        rightbarExpanded: false,
      }),
      refreshProbe: () => {},
    }
    const view = createPaneHost(controller)({ t: (key) => zh[key] ?? key })
    assert.notEqual(view, null)
    assert.equal(view.type, fakeReact.Fragment)
  })
})

test('an empty workspace explains a split-mode error', () => {
  withFakeReact(fakeReact, () => {
    const view = PaneWorkspace({
      controller: {
        watchConversations: () => () => {},
        recentConversations: async () => [],
        budget: { newInFocused: () => {} },
      },
      workspaceId: null,
      layout: { root: null, panes: {}, activePaneId: null },
      visible: true,
      error: 'cannot retain',
      t: (key) => zh[key] ?? key,
    })
    const emptySeat = elementWhere(view, (node) => node.type === PaneEmptyState)
    assert.notEqual(emptySeat, undefined)
    assert.equal(emptySeat.props.error, 'cannot retain')

    const empty = PaneEmptyState({
      controller: { watchConversations: () => () => {} },
      workspaceId: null,
      visible: true,
      error: 'cannot retain',
      t: (key) => zh[key] ?? key,
    })
    const error = elementWhere(empty, (node) => node.props?.['data-hkcraft-empty-error'] === '')
    assert.notEqual(error, undefined)
    assert.deepEqual(error.props.children, ['cannot retain'])
  })
})

test('a later React stand-in is the one the next pane render uses', () => {
  const render = (mark) =>
    PaneEmptyState({
      controller: { watchConversations: () => () => {} },
      workspaceId: null,
      visible: false,
      t: (key) => key,
    }).react === mark
  const standIn = (mark) => ({
    ...fakeReact,
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children },
      react: mark,
    }),
  })
  assert.equal(
    withFakeReact(standIn('first'), () => render('first')),
    true,
  )
  assert.equal(
    withFakeReact(standIn('second'), () => render('second')),
    true,
  )
})

test('the strip split control stays enabled with 0 panes as the cap', () => {
  withFakeReact(fakeReact, () => {
    const { plus } = stripPlus(0)

    assert.notEqual(plus, undefined)
    assert.equal(plus.props.disabled, false)
    assert.equal(plus.props['aria-disabled'], undefined)
    assert.equal(plus.props['data-hkcraft-strip-budget'], undefined)
  })
})

test('a pane waiting for the first frame keeps its header and an empty body', () => {
  withFakeReact(fakeReact, () => {
    const rendered = []
    const frame = PaneFrame({
      controller: headerController(),
      pane: pane('p1', 's1'),
      rect: { x: 0, y: 0, width: 1, height: 1 },
      focused: false,
      bodyAllowed: false,
      kit: {
        SessionProvider: () => null,
        renderSlot: () => {
          rendered.push('body')
          return null
        },
      },
      t: (key) => key,
    })

    assert.equal(rendered.length, 0, 'the conversation is not mounted yet')
    const header = frame.props.children[0]
    assert.equal(header.props['data-hkcraft-pane-header'], '', 'the header is there from the first frame')
    const body = frame.props.children[1]
    assert.equal(body.props.children[0], null, 'the body area is empty, not a skeleton')
  })
})