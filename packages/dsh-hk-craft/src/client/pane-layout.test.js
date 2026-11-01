'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createLayout, openPane, split: splitLayout } = require('./layout-tree.js')
const { createPaneLayout } = require('./pane-layout.js')

/** One workspace with `count` panes in a row; the last one holds the focus. */
function bookWith(count) {
  let value = openPane(createLayout('w1'), { paneId: 'p1', sessionId: 's1', view: 'chat' })
  for (let index = 2; index <= count; index += 1) {
    value = splitLayout(value, `p${index - 1}`, 'row', {
      paneId: `p${index}`,
      sessionId: `s${index}`,
      view: 'chat',
    })
  }
  const layouts = new Map([['w1', value]])
  let active = 'w1'
  return {
    layouts,
    layoutOf: (workspaceId) => layouts.get(workspaceId ?? 'w1'),
    activeLayout: () => layouts.get(active),
    getActiveWorkspaceId: () => active,
    activeKey: () => active,
    allLayouts: () => Object.fromEntries(layouts),
    layoutsMap: () => Object.fromEntries(layouts),
    locatePane(paneId) {
      for (const [workspaceId, layout] of layouts) {
        if (layout.panes[paneId] !== undefined) return { workspaceId, pane: layout.panes[paneId] }
      }
      return null
    },
    locatePaneIn(sessionId) {
      for (const [workspaceId, layout] of layouts) {
        for (const pane of Object.values(layout.panes)) {
          if (pane.sessionId === sessionId) return { workspaceId, paneId: pane.paneId }
        }
      }
      return null
    },
    store(workspaceId, next) {
      layouts.set(workspaceId ?? 'w1', next)
    },
    switchTo(workspaceId) {
      const changed = active !== workspaceId
      active = workspaceId
      return { changed, previous: 'w1' }
    },
  }
}

function withLayoutRuntime({ count = 2, viewSwitch, disposed = false } = {}) {
  const calls = { apply: [], switch: [], errors: [], activated: [], listeners: new Set() }
  const book = bookWith(count)
  let isDisposed = disposed

  const runtime = createPaneLayout({
    book,
    layoutTree: require('./layout-tree.js'),
    apply: (next, workspaceId) => {
      calls.apply.push(workspaceId)
      book.store(workspaceId ?? book.getActiveWorkspaceId(), next)
      return true
    },
    emit: (patch) => calls.errors.push(patch),
    isDisposed: () => isDisposed,
    isRegistered: () => true,
    switchWorkspace: (workspaceId) => {
      calls.switch.push(workspaceId)
      book.switchTo(workspaceId)
      return true
    },
    paneReference: (paneId) => (book.locatePane(paneId) === null ? undefined : { sessionId: book.locatePane(paneId).pane.sessionId }),
    focusedWorkspaceId: () => book.getActiveWorkspaceId(),
    viewSwitch,
    paneIdForStripIndex: (layout, index) => {
      const ids = Object.keys(layout.panes)
      const paneId = ids[index - 1]
      return paneId === undefined ? null : paneId
    },
    openConversationItems: (layout) =>
      Object.values(layout.panes).map((pane, offset) => ({ sessionId: pane.sessionId, index: offset + 1 })),
  })

  return {
    runtime,
    book,
    calls,
    disposeSource() {
      isDisposed = true
    },
  }
}

test('the two faces read the focused pane and its reference', () => {
  const { runtime } = withLayoutRuntime({ count: 2 })

  assert.equal(runtime.layout.focusedPane().paneId, 'p2')
  assert.equal(runtime.layout.paneReference('p1').sessionId, 's1')
  assert.equal(runtime.layout.paneReference('gone'), undefined)
  assert.equal(runtime.layout.focusedWorkspaceId(), 'w1')
  assert.equal(runtime.layout.paneIndexOf('s1'), 1)
  assert.equal(runtime.layout.paneIndexOf('gone'), null)
})

test('focusPaneAt uses the strip projection, not the leaf order', () => {
  const { runtime, calls } = withLayoutRuntime({ count: 2 })

  assert.equal(runtime.layout.focusPaneAt(1), true)
  assert.deepEqual(calls.apply, ['w1'])
  assert.equal(runtime.layout.focusedPane().paneId, 'p1')
  assert.equal(runtime.layout.focusPaneAt(9), false)
})

test('a swap keeps the tree and the focus, and refuses across workspaces', () => {
  const { runtime, book } = withLayoutRuntime({ count: 2 })
  const before = book.activeLayout()

  assert.equal(runtime.layout.swapPanes('p1', 'p2'), true)
  const after = book.activeLayout()
  assert.deepEqual(after.root, before.root)
  assert.equal(after.activePaneId, before.activePaneId)
  assert.equal(after.panes.p1.sessionId, 's2')
  assert.equal(after.panes.p2.sessionId, 's1')

  assert.equal(runtime.layout.swapPanes('p1', 'p1'), false)
  assert.equal(runtime.layout.swapPanes('p1', 'nope'), false)
})

test('setView refuses a trajectory request while the gate is closed', () => {
  const { runtime, calls } = withLayoutRuntime({
    count: 1,
    viewSwitch: { isTrajectoryAvailable: () => false, activate: () => ({ ok: true }) },
  })

  assert.equal(runtime.layout.focusedPane().view, 'chat')
  assert.equal(runtime.view.isTrajectoryAvailable(), false)
  assert.equal(runtime.view.setView('p1', 'trajectory'), false)
  assert.deepEqual(calls.apply, [])
})

test('setView drives the shell binding and then the tree', () => {
  const activated = []
  const { runtime, book } = withLayoutRuntime({
    count: 1,
    viewSwitch: {
      isTrajectoryAvailable: () => true,
      activate: (sessionId, view) => {
        activated.push([sessionId, view])
        return { ok: true }
      },
    },
  })

  assert.equal(runtime.view.setView('p1', 'trajectory'), true)
  assert.deepEqual(activated, [['s1', 'trajectory']])
  assert.equal(book.activeLayout().panes.p1.view, 'trajectory')
  // Asking for the view a pane already has is not a no-op failure.
  assert.equal(runtime.view.setView('p1', 'trajectory'), true)
})

test('a failed binding keeps the remembered view and surfaces the reason', () => {
  const { runtime, book, calls } = withLayoutRuntime({
    count: 1,
    viewSwitch: {
      isTrajectoryAvailable: () => true,
      activate: () => ({ ok: false, error: 'no binding yet' }),
    },
  })

  assert.equal(runtime.view.setView('p1', 'trajectory'), false)
  assert.equal(book.activeLayout().panes.p1.view, 'chat')
  assert.match(calls.errors.at(-1).error, /no binding yet/)
})

test('restoreViewFor re-asserts a remembered trajectory view', () => {
  const activated = []
  const { runtime, book } = withLayoutRuntime({
    count: 1,
    viewSwitch: {
      isTrajectoryAvailable: () => true,
      activate: (sessionId, view) => {
        activated.push([sessionId, view])
        return { ok: true }
      },
    },
  })
  book.store('w1', require('./layout-tree.js').setView(book.activeLayout(), 'p1', 'trajectory'))

  assert.equal(runtime.view.restoreViewFor('s1'), true)
  assert.deepEqual(activated, [['s1', 'trajectory']])
  assert.equal(runtime.view.restoreViewFor('gone'), false)
})

test('re-enabling developer tools re-applies the remembered views, and dispose stops it', () => {
  const activated = []
  const listeners = new Set()
  const { runtime, book } = withLayoutRuntime({
    count: 1,
    viewSwitch: {
      isTrajectoryAvailable: () => true,
      subscribeAvailability(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      activate: (sessionId, view) => {
        activated.push([sessionId, view])
        return { ok: true }
      },
    },
  })
  book.store('w1', require('./layout-tree.js').setView(book.activeLayout(), 'p1', 'trajectory'))

  for (const listener of [...listeners]) listener()
  assert.deepEqual(activated, [['s1', 'trajectory']])

  runtime.dispose()
  assert.equal(listeners.size, 0)
})

test('resize and every entry point refuse once the kernel is disposed', () => {
  const { runtime, calls, disposeSource } = withLayoutRuntime({ count: 1 })
  disposeSource()

  assert.equal(runtime.layout.resize(['a'], 0.3), false)
  assert.equal(runtime.layout.focusPane('p1'), false)
  assert.equal(runtime.layout.focusPaneAt(1), false)
  assert.equal(runtime.layout.swapPanes('p1', 'p1'), false)
  assert.equal(runtime.layout.replaceFocusedSession('s2'), false)
  assert.equal(runtime.layout.paneIndexOf('s1'), null)
  assert.equal(runtime.view.setView('p1', 'chat'), false)
  assert.equal(runtime.view.restoreViewFor('s1'), false)
  assert.deepEqual(calls.apply, [])
})

test('replaceFocusedSession focuses an existing holder instead of mounting twice', () => {
  const { runtime, calls } = withLayoutRuntime({ count: 2 })

  assert.equal(runtime.layout.replaceFocusedSession('s1'), true)
  assert.deepEqual(calls.apply, ['w1'])
  assert.equal(runtime.layout.focusedPane().paneId, 'p1')
})