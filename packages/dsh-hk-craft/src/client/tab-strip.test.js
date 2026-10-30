'use strict'

/**
 * Tab strip model (ticket 06).
 *
 * The strip is a projection of the layout tree: one row per leaf in render
 * order, decorated with the live session title and status. Nothing here is
 * rendered; the React shell in `pane-view.js` only paints these rows.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  TAB_SHORTCUT_LIMIT,
  projectTabs,
  paneIdForTabIndex,
  tabShortcutIndex,
} = require('./tab-strip.js')

/**
 * row(p1, col(p2, p3)) — the same shape the layout tree renders:
 * p1 left, then p2 top-right, p3 bottom-right.
 */
function fixtureLayout() {
  return {
    version: 1,
    workspaceId: 'w1',
    root: {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', paneId: 'p1' },
      b: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'leaf', paneId: 'p2' },
        b: { kind: 'leaf', paneId: 'p3' },
      },
    },
    panes: {
      p1: { paneId: 'p1', sessionId: 's1', view: 'chat' },
      p2: { paneId: 'p2', sessionId: 's2', view: 'chat' },
      p3: { paneId: 'p3', sessionId: 's3', view: 'chat' },
    },
    activePaneId: 'p2',
  }
}

/** One running, one waiting, one idle — deliberately not in status order. */
function fixtureSessions() {
  return {
    byId: {
      s1: { id: 's1', title: 'Alpha' },
      s2: { id: 's2' }, // no title yet: the strip must fall back
      s3: { id: 's3', title: 'Gamma' },
    },
  }
}

function fixtureStatuses() {
  return new Map([
    ['s1', { running: true, pendingInteraction: null, completionUnread: false }],
    ['s2', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
    ['s3', { running: false, pendingInteraction: null, completionUnread: false }],
  ])
}

test('tabs follow the layout tree leaves and keep their status order', () => {
  const tabs = projectTabs(fixtureLayout(), fixtureSessions(), fixtureStatuses(), 'Untitled')

  assert.deepEqual(
    tabs.map((tab) => tab.paneId),
    ['p1', 'p2', 'p3'],
  )
  assert.deepEqual(
    tabs.map((tab) => tab.sessionId),
    ['s1', 's2', 's3'],
  )
  // A running tab in the middle stays in the middle: no status reordering.
  assert.deepEqual(
    tabs.map((tab) => tab.status),
    ['running', 'waiting', 'idle'],
  )
  assert.deepEqual(
    tabs.map((tab) => tab.focused),
    [false, true, false],
  )
  assert.deepEqual(
    tabs.map((tab) => tab.index),
    [1, 2, 3],
  )
})

test('a tab title falls back to the localized placeholder when the session has none', () => {
  const tabs = projectTabs(fixtureLayout(), fixtureSessions(), fixtureStatuses(), 'Untitled')
  assert.deepEqual(
    tabs.map((tab) => tab.title),
    ['Alpha', 'Untitled', 'Gamma'],
  )
})

test('a blank or whitespace title also falls back', () => {
  const sessions = { byId: { s1: { id: 's1', title: '   ' } } }
  const tabs = projectTabs(fixtureLayout(), sessions, undefined, 'Untitled')
  assert.equal(tabs[0].title, 'Untitled')
})

test('the live session status drives the dot, with waiting ahead of running', () => {
  const statuses = new Map([
    ['s1', { running: true, pendingInteraction: { kind: 'question' } }],
    ['s2', { running: true, pendingInteraction: null }],
  ])
  const tabs = projectTabs(fixtureLayout(), fixtureSessions(), statuses, 'Untitled')

  assert.equal(tabs[0].status, 'waiting')
  assert.equal(tabs[1].status, 'running')
  assert.equal(tabs[2].status, 'idle')
})

test('the session summary is the fallback when no status map is available', () => {
  const sessions = {
    byId: {
      s1: { id: 's1', title: 'Alpha', running: true },
      s2: { id: 's2', title: 'Beta', running: false },
    },
  }
  const tabs = projectTabs(fixtureLayout(), sessions, undefined, 'Untitled')

  assert.deepEqual(
    tabs.map((tab) => tab.status),
    ['running', 'idle', 'idle'],
  )
})

test('a session that reports an error gets the error status', () => {
  const sessions = { byId: { s1: { id: 's1', title: 'Alpha', errored: true } } }
  const tabs = projectTabs(fixtureLayout(), sessions, undefined, 'Untitled')

  assert.equal(tabs[0].status, 'error')
})

test('only the first four tabs advertise a keyboard shortcut', () => {
  const leaves = Array.from({ length: 5 }, (_, i) => `p${i + 1}`)
  let root = { kind: 'leaf', paneId: leaves[0] }
  const panes = {}
  for (let i = 0; i < leaves.length; i += 1) {
    panes[leaves[i]] = { paneId: leaves[i], sessionId: `s${i + 1}`, view: 'chat' }
    if (i > 0) root = { kind: 'split', dir: 'row', ratio: 0.5, a: root, b: { kind: 'leaf', paneId: leaves[i] } }
  }
  const tabs = projectTabs(
    { root, panes, activePaneId: 'p1' },
    { byId: {} },
    undefined,
    'Untitled',
  )

  assert.equal(TAB_SHORTCUT_LIMIT, 4)
  assert.deepEqual(
    tabs.map((tab) => tab.shortcut),
    ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', undefined],
  )
})

test('an empty layout has no tabs', () => {
  assert.deepEqual(projectTabs({ root: null, panes: {}, activePaneId: null }, {}, undefined, 'Untitled'), [])
})

test('a status change never reorders tabs or moves their shortcut numbers', () => {
  const idle = projectTabs(fixtureLayout(), fixtureSessions(), undefined, 'Untitled')
  const busy = projectTabs(fixtureLayout(), fixtureSessions(), fixtureStatuses(), 'Untitled')

  assert.deepEqual(
    busy.map((tab) => [tab.paneId, tab.sessionId, tab.index, tab.shortcut]),
    idle.map((tab) => [tab.paneId, tab.sessionId, tab.index, tab.shortcut]),
  )
  // Only the dot kind changed; titles and focus are untouched.
  assert.deepEqual(
    busy.map((tab) => tab.status),
    ['running', 'waiting', 'idle'],
  )
  assert.deepEqual(
    idle.map((tab) => tab.status),
    ['idle', 'idle', 'idle'],
  )
  assert.deepEqual(
    busy.map((tab) => [tab.title, tab.focused]),
    idle.map((tab) => [tab.title, tab.focused]),
  )
})

test('Ctrl+1..4 map to the Nth tab; other chords are ignored', () => {
  assert.equal(tabShortcutIndex({ key: '1', ctrlKey: true }), 1)
  assert.equal(tabShortcutIndex({ key: '4', ctrlKey: true }), 4)
  assert.equal(tabShortcutIndex({ key: '2', metaKey: true }), 2)

  assert.equal(tabShortcutIndex({ key: '5', ctrlKey: true }), null)
  assert.equal(tabShortcutIndex({ key: '0', ctrlKey: true }), null)
  assert.equal(tabShortcutIndex({ key: '1' }), null)
  assert.equal(tabShortcutIndex({ key: '1', ctrlKey: true, shiftKey: true }), null)
  assert.equal(tabShortcutIndex({ key: '1', ctrlKey: true, altKey: true }), null)
  assert.equal(tabShortcutIndex({ key: 'a', ctrlKey: true }), null)
  assert.equal(tabShortcutIndex({ key: '1', ctrlKey: true, defaultPrevented: true }), null)
  assert.equal(tabShortcutIndex(null), null)
})

test('the shortcut index resolves through leaves() and clamps out of range', () => {
  const layout = fixtureLayout()

  assert.equal(paneIdForTabIndex(layout, 1), 'p1')
  assert.equal(paneIdForTabIndex(layout, 2), 'p2')
  assert.equal(paneIdForTabIndex(layout, 3), 'p3')
  assert.equal(paneIdForTabIndex(layout, 4), null)
  assert.equal(paneIdForTabIndex(layout, 0), null)
  assert.equal(paneIdForTabIndex(layout, 1.5), null)
  assert.equal(paneIdForTabIndex({ root: null, panes: {}, activePaneId: null }, 1), null)
})
