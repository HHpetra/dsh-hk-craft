'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_MAX_PANES,
  PANE_SETTINGS_KEY,
  PANE_SETTINGS_VERSION,
  normalizeMaxPanes,
  readMaxPanes,
  writeMaxPanes,
  paneBudgetBlocked,
  paneCount,
  createSplitBudget,
} = require('./pane-budget.js')
const { createLayout, openPane, split } = require('./layout-tree.js')

/** @param {string} paneId @param {string} sessionId */
function pane(paneId, sessionId) {
  return { paneId, sessionId, view: 'chat' }
}

/** A layout with `count` panes in one row. */
function layoutOf(count) {
  let value = openPane(createLayout('w1'), pane('p1', 's1'))
  for (let index = 2; index <= count; index += 1) {
    value = split(value, `p${index - 1}`, 'row', pane(`p${index}`, `s${index}`))
  }
  return value
}

/** @returns {{getItem: Function, setItem: Function, removeItem: Function, values: Map}} */
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

test('the default pane cap is four', () => {
  assert.equal(DEFAULT_MAX_PANES, 4)
})

test('normalizeMaxPanes accepts non-negative whole numbers and digit strings', () => {
  assert.equal(normalizeMaxPanes(0), 0)
  assert.equal(normalizeMaxPanes(4), 4)
  assert.equal(normalizeMaxPanes('6'), 6)
  assert.equal(normalizeMaxPanes(' 12 '), 12)
  assert.equal(normalizeMaxPanes(0, 9), 0)
})

test('normalizeMaxPanes falls back for negative, fractional, empty and non-numeric input', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '', '  ', '4.5', 'four', true, null, undefined, {}]) {
    assert.equal(normalizeMaxPanes(value), DEFAULT_MAX_PANES, `value ${String(value)}`)
  }
  assert.equal(normalizeMaxPanes(-1, 9), 9)
})

test('paneCount counts the layout leaves and paneBudgetBlocked follows the cap', () => {
  assert.equal(paneCount(createLayout('w1')), 0)
  assert.equal(paneCount(layoutOf(4)), 4)

  assert.equal(paneBudgetBlocked(layoutOf(3), 4), false)
  assert.equal(paneBudgetBlocked(layoutOf(4), 4), true)
  assert.equal(paneBudgetBlocked(layoutOf(9), 4), true)
  assert.equal(paneBudgetBlocked(layoutOf(9), 0), false)
  // A missing snapshot field means the default cap, not "unlimited".
  assert.equal(paneBudgetBlocked(layoutOf(4), undefined), true)
})

test('readMaxPanes returns the default when the store is absent, corrupt or foreign', () => {
  assert.equal(readMaxPanes(null), 4)
  assert.equal(readMaxPanes({}), 4)
  assert.equal(readMaxPanes(memoryStorage()), 4)
  assert.equal(readMaxPanes(memoryStorage({ [PANE_SETTINGS_KEY]: '{not json' })), 4)
  assert.equal(readMaxPanes(memoryStorage({ [PANE_SETTINGS_KEY]: JSON.stringify({ version: 99, maxPanes: 2 }) })), 4)
  assert.equal(readMaxPanes(memoryStorage({ [PANE_SETTINGS_KEY]: JSON.stringify({ version: 1, maxPanes: -2 }) })), 4)
})

test('readMaxPanes reads a stored zero as unlimited', () => {
  const storage = memoryStorage({
    [PANE_SETTINGS_KEY]: JSON.stringify({ version: PANE_SETTINGS_VERSION, maxPanes: 0 }),
  })
  assert.equal(readMaxPanes(storage), 0)
})

test('writeMaxPanes normalises before writing and reports storage failures without throwing', () => {
  const storage = memoryStorage()
  assert.deepEqual(writeMaxPanes(storage, '3'), { ok: true, maxPanes: 3 })
  assert.deepEqual(JSON.parse(storage.getItem(PANE_SETTINGS_KEY)), {
    version: PANE_SETTINGS_VERSION,
    maxPanes: 3,
  })

  assert.deepEqual(writeMaxPanes(storage, -2), { ok: true, maxPanes: 4 })
  assert.deepEqual(writeMaxPanes(null, 2), { ok: false, maxPanes: 2, message: '' })
  assert.deepEqual(
    writeMaxPanes(
      {
        setItem() {
          throw new Error('quota')
        },
      },
      2,
    ),
    { ok: false, maxPanes: 2, message: 'quota' },
  )
})

/**
 * The holder with a fake layout book, so each test states only the part that
 * matters. `defer` keeps `sessions.create` unresolved: that window is where the
 * reservation rules live.
 */
function withBudget({ cap = 4, open = 1, also = {}, storage, defer = false, fails = false } = {}) {
  const store =
    storage ??
    memoryStorage({
      [PANE_SETTINGS_KEY]: JSON.stringify({ version: PANE_SETTINGS_VERSION, maxPanes: cap }),
    })
  const calls = { create: [], apply: [], openSession: [], focus: [], replace: [], switch: [], errors: [], republish: 0 }
  const pending = []
  const layoutMap = new Map()
  let paneSeq = 0
  let disposed = false

  function keyOf(workspaceId) {
    return workspaceId === null || workspaceId === undefined ? 'unscoped' : workspaceId
  }
  function seed(workspaceId, count = open) {
    let value = createLayout(workspaceId ?? null)
    if (count > 0) {
      value = openPane(value, pane('p1', 's1'))
      for (let index = 2; index <= count; index += 1) {
        value = split(value, `p${index - 1}`, 'row', pane(`p${index}`, `s${index}`))
      }
    }
    layoutMap.set(keyOf(workspaceId), value)
    return value
  }
  function layoutFor(workspaceId) {
    const key = keyOf(workspaceId)
    if (!layoutMap.has(key)) layoutMap.set(key, createLayout(workspaceId ?? null))
    return layoutMap.get(key)
  }

  const book = {
    layoutOf: (workspaceId) => layoutFor(workspaceId),
    activeLayout: () => layoutFor('w1'),
    getActiveWorkspaceId: () => 'w1',
    locatePane(paneId) {
      for (const [workspaceId, layout] of layoutMap) {
        if (layout.panes[paneId] !== undefined) return { workspaceId, pane: layout.panes[paneId] }
      }
      return null
    },
    locatePaneIn(sessionId) {
      for (const layout of layoutMap.values()) {
        for (const item of Object.values(layout.panes)) {
          if (item.sessionId === sessionId) return { workspaceId: 'w1', paneId: item.paneId }
        }
      }
      return null
    },
  }
  if (open > 0) seed('w1')
  for (const [workspaceId, count] of Object.entries(also)) seed(workspaceId, count)

  const budget = createSplitBudget({
    storage: store,
    book,
    isDisposed: () => disposed,
    isRegistered: () => true,
    isActive: () => true,
    emit: (patch) => calls.errors.push(patch),
    republish: () => {
      calls.republish += 1
    },
    workspaceOf: (sessionId) => (sessionId === 's9' ? 'w2' : 'w1'),
    focusedWorkspaceId: () => 'w1',
    ensureWorkspace: (workspaceId) => {
      layoutFor(workspaceId)
      return true
    },
    apply: (next, workspaceId) => {
      calls.apply.push(workspaceId)
      layoutMap.set(keyOf(workspaceId), next)
      return true
    },
    freshPane: (sessionId) => ({ paneId: `p${++paneSeq + 10}`, sessionId, view: 'chat' }),
    openSessionPane: (layout, sessionId, workspaceId) => {
      calls.openSession.push({ sessionId, workspaceId })
      return true
    },
    focusPane: (paneId) => {
      calls.focus.push(paneId)
      return true
    },
    replaceFocused: (sessionId) => {
      calls.replace.push(sessionId)
      return true
    },
    switchWorkspace: (workspaceId) => {
      calls.switch.push(workspaceId)
      return true
    },
    createSession: (workspaceId) => {
      calls.create.push(workspaceId)
      if (fails) return Promise.reject(new Error('create failed'))
      if (defer) {
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      }
      return Promise.resolve('new-1')
    },
  })

  return {
    budget,
    calls,
    pending,
    layoutFor,
    dispose() {
      disposed = true
    },
  }
}
test('the holder owns the cap and reports a failed write without losing it', () => {
  const storage = memoryStorage()
  const holder = withBudget({ storage })

  assert.deepEqual(holder.budget.snapshotPatch(), { maxPanes: 4, maxPanesError: null })
  assert.equal(holder.budget.setMaxPanes('6'), 6)
  assert.deepEqual(holder.budget.snapshotPatch(), { maxPanes: 6, maxPanesError: null })
  assert.deepEqual(JSON.parse(storage.getItem(PANE_SETTINGS_KEY)), {
    version: PANE_SETTINGS_VERSION,
    maxPanes: 6,
  })

  const refused = withBudget({
    storage: {
      setItem() {
        throw new Error('quota')
      },
    },
  })
  assert.equal(refused.budget.setMaxPanes(2), 2)
  assert.deepEqual(refused.budget.snapshotPatch(), { maxPanes: 2, maxPanesError: 'quota' })
})

test('a split reserves its slot before creating the session', async () => {
  const holder = withBudget({ cap: 2, open: 1, defer: true })

  const splitting = holder.budget.split('p1', 'row')
  assert.equal(holder.budget.splitBlock('w1'), 'budget')
  // The reservation is visible to subscribers without the tree changing.
  assert.equal(holder.calls.republish, 1)
  assert.deepEqual(holder.calls.create, ['w1'])

  holder.pending[0].resolve('new-1')
  assert.equal(await splitting, true)
  assert.deepEqual(holder.calls.apply, ['w1'])
  assert.equal(holder.budget.splitBlock('w1'), 'budget')
})

test('a split over the cap creates no session and says why', async () => {
  const holder = withBudget({ cap: 1, open: 1 })

  assert.equal(await holder.budget.split('p1', 'row'), false)
  assert.deepEqual(holder.calls.create, [])
  assert.match(holder.calls.errors.at(-1).error, /pane limit \(1\)/)
})

test('a failed create gives the reservation back so a retry can pass', async () => {
  const holder = withBudget({ cap: 2, open: 1, fails: true })

  assert.equal(await holder.budget.split('p1', 'row'), false)
  assert.equal(holder.budget.splitBlock('w1'), undefined)
  assert.match(holder.calls.errors.at(-1).error, /create failed/)
})

test('the first pane of an empty workspace is guarded, not reserved against the cap', async () => {
  const holder = withBudget({ cap: 4, open: 0, defer: true })

  const opening = holder.budget.newInFocused('w1')
  assert.equal(await holder.budget.newInFocused('w1'), false)
  assert.deepEqual(holder.calls.create, ['w1'])
  assert.equal(holder.budget.splitBlock('w1'), undefined)

  holder.pending[0].resolve('new-1')
  assert.equal(await opening, true)
  assert.deepEqual(holder.calls.openSession, [{ sessionId: 'new-1', workspaceId: 'w1' }])
})

test('/clear replaces the focused conversation instead of opening a pane', async () => {
  const holder = withBudget({ cap: 4, open: 2 })

  assert.equal(holder.layoutFor('w1').activePaneId, 'p2')
  assert.equal(await holder.budget.newInFocused('w1'), true)
  assert.equal(holder.layoutFor('w1').panes.p2.sessionId, 'new-1')
  assert.equal(holder.layoutFor('w1').panes.p1.sessionId, 's1')
  assert.deepEqual(holder.calls.apply, ['w1'])
  assert.deepEqual(holder.calls.openSession, [])
  assert.deepEqual(holder.calls.replace, [])
})

test('/clear stays on the pane it started in when focus moves before create resolves', async () => {
  const holder = withBudget({ cap: 4, open: 2, defer: true })
  const creating = holder.budget.newInFocused('w1')
  holder.layoutFor('w1').activePaneId = 'p1'

  holder.pending[0].resolve('new-1')
  assert.equal(await creating, true)
  const layout = holder.layoutFor('w1')
  assert.equal(layout.activePaneId, 'p1')
  assert.equal(layout.panes.p2.sessionId, 'new-1')
  assert.equal(layout.panes.p1.sessionId, 's1')
})

test('/clear does not write into another pane when its pane is gone', async () => {
  const holder = withBudget({ cap: 4, open: 2, defer: true })
  const creating = holder.budget.newInFocused('w1')
  const layout = holder.layoutFor('w1')
  layout.panes = { p1: layout.panes.p1 }
  layout.root = { kind: 'leaf', paneId: 'p1' }
  layout.activePaneId = 'p1'

  holder.pending[0].resolve('new-1')
  assert.equal(await creating, false)
  assert.equal(holder.layoutFor('w1').panes.p1.sessionId, 's1')
  assert.equal(holder.layoutFor('w1').panes.p2, undefined)
  assert.deepEqual(holder.calls.apply, [])
})

test('openInNewPane refuses a full workspace before switching to it', async () => {
  const holder = withBudget({ cap: 1, open: 1, also: { w2: 1 } })

  assert.equal(await holder.budget.openInNewPane('s9'), false)
  assert.deepEqual(holder.calls.switch, [])
  assert.deepEqual(holder.calls.create, [])
  assert.match(holder.calls.errors.at(-1).error, /pane limit/)
})

test('openInNewPane focuses an already mounted conversation instead of adding a pane', async () => {
  const holder = withBudget({ cap: 4, open: 2 })

  assert.equal(await holder.budget.openInNewPane('s1'), false)
  assert.deepEqual(holder.calls.focus, ['p1'])
  assert.deepEqual(holder.calls.apply, [])
})

test('a disposed holder refuses every entry point', async () => {
  const holder = withBudget({ cap: 4, open: 1 })
  holder.dispose()

  assert.equal(await holder.budget.split('p1', 'row'), false)
  assert.equal(await holder.budget.newPane(), false)
  assert.equal(await holder.budget.openInNewPane('s9'), false)
  assert.equal(await holder.budget.newInFocused('w1'), false)
  assert.equal(holder.budget.splitBlock('w1'), undefined)
  assert.deepEqual(holder.calls.create, [])
})