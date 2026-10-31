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
