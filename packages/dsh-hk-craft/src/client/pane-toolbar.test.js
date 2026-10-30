'use strict'

/**
 * Pane strip native-action group (ticket 06).
 *
 * The group only arranges independent seats; the read-only mode badge (ticket
 * 07) and the subagent viewer (ticket 08) each fill one seat without touching
 * the group. These tests cover that contract, not React markup.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  STRIP_SEAT_ORDER,
  stripSeatEntries,
  stripSeatMaxWidth,
} = require('./pane-toolbar.js')

function seat(name) {
  const Component = () => name
  return Component
}

test('an empty toolbar renders no seats', () => {
  assert.deepEqual(stripSeatEntries(undefined), [])
  assert.deepEqual(stripSeatEntries(null), [])
  assert.deepEqual(stripSeatEntries({}), [])
  assert.deepEqual(stripSeatEntries({ mode: null, subagents: null }), [])
})

test('the group keeps the native header order however the seats are supplied', () => {
  const mode = seat('mode')
  const subagents = seat('subagents')
  assert.deepEqual(STRIP_SEAT_ORDER, ['mode', 'subagents'])

  const reversed = stripSeatEntries({ subagents, mode })
  assert.deepEqual(
    reversed.map((entry) => entry.key),
    ['mode', 'subagents'],
  )
  assert.equal(reversed[0].component, mode)
  assert.equal(reversed[1].component, subagents)
})

test('each seat can be filled on its own', () => {
  const mode = seat('mode')
  const subagents = seat('subagents')

  assert.deepEqual(
    stripSeatEntries({ mode }).map((entry) => entry.key),
    ['mode'],
  )
  assert.deepEqual(
    stripSeatEntries({ subagents }).map((entry) => entry.key),
    ['subagents'],
  )
})

test('non-component seat values are ignored instead of crashing the strip', () => {
  const rendered = stripSeatEntries({
    mode: 'a label string is not a seat',
    subagents: { type: 'div' },
  })
  assert.deepEqual(rendered, [])
})

test('names outside the two seats are not rendered (no right-sidebar button)', () => {
  const Tool = seat('tool')
  const rendered = stripSeatEntries({
    rightbar: Tool,
    jobs: Tool,
    mode: Tool,
  })
  assert.deepEqual(
    rendered.map((entry) => entry.key),
    ['mode'],
  )
})

test('the shell caps each seat width so the group cannot squeeze the tabs', () => {
  for (const key of STRIP_SEAT_ORDER) {
    const width = stripSeatMaxWidth(key)
    assert.equal(Number.isInteger(width), true, `${key} needs an integer width cap`)
    assert.equal(width > 0, true, `${key} needs a positive width cap`)
  }
  assert.equal(stripSeatMaxWidth('rightbar'), null)
})
