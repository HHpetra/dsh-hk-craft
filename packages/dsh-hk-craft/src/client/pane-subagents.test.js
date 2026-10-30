'use strict'

/**
 * The pane strip's subagent viewer seat.
 *
 * The seat is dumb: `pane-subagents.js` projects the focused conversation's
 * `subagentCatalog` into plain rows, `pane-subagents-view.js` only paints those
 * rows, and a pick routes to the pane controller. These tests cover the
 * projection, the open seam and the refresh helper; the dropdown's pointer/keyboard
 * feel is on the manual smoke list (spec "Testing Decisions").
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { withFakeReact } = require('./fake-react.js')

const {
  SUBAGENT_ACTIVITY_COMPLETED,
  SUBAGENT_ACTIVITY_IDLE,
  SUBAGENT_ACTIVITY_KEYS,
  SUBAGENT_ACTIVITY_RUNNING,
  SUBAGENT_MODE_CONTINUABLE,
  SUBAGENT_MODE_EXTERNAL,
  SUBAGENT_MODE_KEYS,
  SUBAGENT_MODE_ONE_SHOT,
  SUBAGENT_MODE_UNKNOWN,
  openSubagentInPane,
  projectSubagentCatalog,
  requestCatalogRefresh,
  subagentLabelOf,
  subagentModeOf,
} = require('./pane-subagents.js')
const { createSubagentSeat } = require('./pane-subagents-view.js')
const { zh, en } = require('./locale.js')

/**
 * A `sessions.list` snapshot with one focused session whose catalog is
 * `entries`. `summaries` are the rows the status fallback reads.
 *
 * @param {object[]|undefined} entries
 * @param {{summaries?: Record<string, any>, sessionId?: string, state?: string}} [options]
 */
function sessionSnapshot(entries, options = {}) {
  const sessionId = options.sessionId ?? 's1'
  return {
    ids: [sessionId],
    phase: 'ready',
    byId: options.summaries ?? {},
    projectionsBySession: {
      [sessionId]: {
        state: options.state ?? 'ready',
        values: entries === undefined ? {} : { subagentCatalog: entries },
      },
    },
  }
}

/** A React stand-in for the seat render: only the calls `pane-subagents.js` makes. */
const fakeReact = {
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children },
  }),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Every element in the fake-React tree. */
function elementsOf(element, out = []) {
  if (element === null || typeof element !== 'object') return out
  out.push(element)
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : []) elementsOf(child, out)
  return out
}

/** The text content of a fake-React tree. */
function textOf(element) {
  if (element === null || element === undefined) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  const children = element.props?.children
  return (Array.isArray(children) ? children : []).map(textOf).join(' ')
}

test('the entry stays hidden until the focused session has a catalog', () => {
  assert.equal(projectSubagentCatalog(undefined, 's1', undefined), null)
  assert.equal(projectSubagentCatalog({}, 's1', undefined), null)
  assert.equal(projectSubagentCatalog(sessionSnapshot(undefined), 's1', undefined), null)
  assert.equal(projectSubagentCatalog(sessionSnapshot(undefined), '', undefined), null)
  assert.equal(projectSubagentCatalog(sessionSnapshot([]), 's1', undefined), null)
  // A projection value that is not an array is a malformed read, not a catalog.
  assert.equal(
    projectSubagentCatalog(sessionSnapshot({ not: 'a list' }), 's1', undefined),
    null,
  )
  // Entries without an id cannot be labelled or opened, so they never make an
  // otherwise empty entry visible.
  assert.equal(projectSubagentCatalog(sessionSnapshot([{ mode: 'one-shot' }]), 's1', undefined), null)
})

test('direct children keep the catalog order and fall back to their id', () => {
  const sessions = sessionSnapshot(
    [
      { id: 'a', createdAt: 1, mode: 'continuable', label: 'Reviewer' },
      { id: 'b', createdAt: 2, mode: 'one-shot', label: '   ' },
      { id: 'c', createdAt: 3, mode: 'external', label: 'Cloud task' },
      { id: 'd', createdAt: 4, mode: 'future-mode' },
    ],
    {
      summaries: {
        a: { running: true },
        b: { running: false },
        d: { running: false },
      },
    },
  )

  const model = projectSubagentCatalog(sessions, 's1', new Map([['b', { running: true }]]))

  assert.equal(model.sessionId, 's1')
  assert.equal(model.total, 4)
  assert.equal(model.running, 2)
  assert.deepEqual(
    model.rows.map((row) => [row.id, row.label, row.mode, row.modeKey, row.activity, row.navigable]),
    [
      ['a', 'Reviewer', SUBAGENT_MODE_CONTINUABLE, 'subagent.mode.continuable', SUBAGENT_ACTIVITY_RUNNING, true],
      ['b', 'b', SUBAGENT_MODE_ONE_SHOT, 'subagent.mode.oneShot', SUBAGENT_ACTIVITY_RUNNING, true],
      ['c', 'Cloud task', SUBAGENT_MODE_EXTERNAL, 'subagent.mode.external', null, false],
      ['d', 'd', SUBAGENT_MODE_UNKNOWN, 'subagent.mode.unknown', SUBAGENT_ACTIVITY_IDLE, true],
    ],
  )
})

test('activity reads the status map first and falls back to the session summary', () => {
  const entries = [
    { id: 'stale', mode: 'continuable', label: 'Stale summary' },
    { id: 'summary', mode: 'continuable', label: 'Summary says running' },
    { id: 'record', mode: 'continuable', label: 'Record status map' },
  ]
  const sessions = sessionSnapshot(entries, {
    summaries: {
      stale: { running: true },
      summary: { running: true },
      record: { running: false },
    },
  })

  const model = projectSubagentCatalog(
    sessions,
    's1',
    // A plain record is accepted too, like `workspace-status.js` does.
    { stale: { running: false }, record: { running: true } },
  )

  assert.deepEqual(
    model.rows.map((row) => [row.id, row.activity]),
    [
      ['stale', SUBAGENT_ACTIVITY_IDLE],
      ['summary', SUBAGENT_ACTIVITY_RUNNING],
      ['record', SUBAGENT_ACTIVITY_RUNNING],
    ],
  )
})

test('a finished child is completed only when its latest closed turn completed', () => {
  const sessions = sessionSnapshot(
    [
      { id: 'done', mode: 'one-shot', label: 'Done' },
      { id: 'failed', mode: 'one-shot', label: 'Uncertain' },
      { id: 'fresh', mode: 'one-shot', label: 'No closed turn' },
    ],
    {
      summaries: {
        done: { running: false, projectionValues: { subagentTiming: { lastTurnCompleted: true } } },
        failed: { running: false, projectionValues: { subagentTiming: { lastTurnCompleted: false } } },
        fresh: { running: false },
      },
    },
  )

  const model = projectSubagentCatalog(sessions, 's1', undefined)

  assert.deepEqual(
    model.rows.map((row) => [row.id, row.activity]),
    [
      ['done', SUBAGENT_ACTIVITY_COMPLETED],
      ['failed', SUBAGENT_ACTIVITY_IDLE],
      ['fresh', SUBAGENT_ACTIVITY_IDLE],
    ],
  )
})

test('external tasks are listed but never navigable and carry no activity', () => {
  const sessions = sessionSnapshot(
    [{ id: 'cloud', mode: 'external', label: 'External task' }],
    { summaries: { cloud: { running: true } } },
  )

  const model = projectSubagentCatalog(sessions, 's1', new Map([['cloud', { running: true }]]))

  assert.equal(model.total, 1)
  assert.equal(model.running, 0)
  assert.deepEqual(model.rows[0], {
    id: 'cloud',
    label: 'External task',
    mode: SUBAGENT_MODE_EXTERNAL,
    modeKey: 'subagent.mode.external',
    activity: null,
    navigable: false,
  })
})

test('mode ids outside the catalog union read as unknown', () => {
  assert.equal(subagentModeOf('one-shot'), SUBAGENT_MODE_ONE_SHOT)
  assert.equal(subagentModeOf('continuable'), SUBAGENT_MODE_CONTINUABLE)
  assert.equal(subagentModeOf('external'), SUBAGENT_MODE_EXTERNAL)
  assert.equal(subagentModeOf('unknown'), SUBAGENT_MODE_UNKNOWN)
  assert.equal(subagentModeOf('future-mode'), SUBAGENT_MODE_UNKNOWN)
  assert.equal(subagentModeOf(undefined), SUBAGENT_MODE_UNKNOWN)
  assert.equal(subagentLabelOf({ id: 'abc', label: '  Named  ' }), 'Named')
  assert.equal(subagentLabelOf({ id: 'abc', label: '   ' }), 'abc')
  assert.equal(subagentLabelOf({ id: 'abc' }), 'abc')
  assert.equal(subagentLabelOf({ label: '' }), '')
})

test('every subagent label the seat paints exists in both dictionaries', () => {
  const keys = [
    'subagent.trigger',
    'subagent.menu.aria',
    'subagent.open',
    'subagent.external.hint',
    ...Object.values(SUBAGENT_MODE_KEYS),
    ...Object.values(SUBAGENT_ACTIVITY_KEYS),
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh is missing ${key}`)
    assert.equal(typeof en[key], 'string', `en is missing ${key}`)
    assert.notEqual(zh[key], key)
    assert.notEqual(en[key], key)
  }
})

test('picking a navigable child opens it in a pane while external rows stay inert', () => {
  const opened = []
  const controller = {
    openInNewPane(sessionId) {
      opened.push(sessionId)
      return { catch() {} }
    },
  }

  assert.equal(openSubagentInPane(controller, { id: 'child', navigable: true }), true)
  assert.deepEqual(opened, ['child'])

  assert.equal(openSubagentInPane(controller, { id: 'cloud', navigable: false }), false)
  assert.deepEqual(opened, ['child'])

  assert.equal(openSubagentInPane(undefined, { id: 'child', navigable: true }), false)
  assert.doesNotThrow(() =>
    openSubagentInPane(
      {
        openInNewPane() {
          throw new Error('controller refused')
        },
      },
      { id: 'child', navigable: true },
    ),
  )
})

test('the on-open refresh runs once and swallows every failure', () => {
  const calls = []
  requestCatalogRefresh((sessionId) => {
    calls.push(sessionId)
    return Promise.resolve()
  }, 's1')
  assert.deepEqual(calls, ['s1'])

  let caught = null
  const thenable = {
    catch(handler) {
      caught = handler
      return this
    },
  }
  requestCatalogRefresh(() => thenable, 's2')
  assert.equal(typeof caught, 'function')
  assert.equal(caught(new Error('refresh failed')), undefined)

  assert.doesNotThrow(() =>
    requestCatalogRefresh(() => {
      throw new Error('synchronous rejection')
    }, 's3'),
  )
  assert.doesNotThrow(() => requestCatalogRefresh(undefined, 's4'))
  assert.doesNotThrow(() => requestCatalogRefresh(() => {}, ''))
})

test('the seat follows the focused strip entry and hides without a catalog', () => {
  withFakeReact(fakeReact, () => {
    const Seat = createSubagentSeat({ refreshCatalog: () => {} })
    const baseProps = {
      controller: { openInNewPane: () => {} },
      sessions: sessionSnapshot([]),
      statuses: new Map(),
      kit: {},
      t: (key) => key,
    }

    assert.equal(Seat({ ...baseProps, focused: null }), null)
    assert.equal(Seat({ ...baseProps, focused: { sessionId: 's1' } }), null)
  })
})

test('the seat trigger exposes the total and running counts', () => {
  withFakeReact(fakeReact, () => {
    const Seat = createSubagentSeat({ refreshCatalog: () => {} })
    const labels = {
      'subagent.trigger': 'Subagents',
      'subagent.activity.running': 'running',
    }
    const sessions = sessionSnapshot(
      [
        { id: 'a', mode: 'continuable', label: 'Reviewer' },
        { id: 'b', mode: 'one-shot', label: 'Builder' },
      ],
      { summaries: { a: { running: true } } },
    )

    const seat = Seat({
      controller: { openInNewPane: () => {} },
      focused: { sessionId: 's1' },
      sessions,
      statuses: new Map(),
      kit: {},
      t: (key) => labels[key] ?? key,
    })

    const trigger = elementsOf(seat).find(
      (element) => element.props?.['data-hkcraft-subagent-trigger'] !== undefined,
    )
    assert.notEqual(trigger, undefined)
    assert.equal(trigger.type, 'button')
    assert.equal(trigger.props['aria-haspopup'], 'menu')
    assert.equal(trigger.props['aria-expanded'], 'false')
    assert.equal(trigger.props['aria-label'], 'Subagents 2 · 1 running')
    assert.equal(trigger.props.title, 'Subagents 2 · 1 running')
    assert.equal(textOf(trigger).replace(/\s+/g, ' ').trim(), 'Subagents 2 1 running')
  })
})
