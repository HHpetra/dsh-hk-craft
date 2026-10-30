'use strict'

/**
 * Pane strip model (ticket 06).
 *
 * The strip is a projection of the layout tree: one entry per open conversation
 * in render order, decorated with the live session title and status. Nothing
 * here is rendered; the React shell in `pane-view.js` only paints these rows.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  STRIP_SHORTCUT_LIMIT,
  projectStrip,
  paneIdForStripIndex,
  openConversationItems,
} = require('./pane-strip.js')
const { focusShortcutIndex } = require('./pane-shortcuts.js')

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

test('strip entries follow the layout tree leaves and keep their status order', () => {
  const entries = projectStrip(fixtureLayout(), fixtureSessions(), fixtureStatuses(), 'Untitled')

  assert.deepEqual(
    entries.map((entry) => entry.paneId),
    ['p1', 'p2', 'p3'],
  )
  assert.deepEqual(
    entries.map((entry) => entry.sessionId),
    ['s1', 's2', 's3'],
  )
  // A running entry in the middle stays in the middle: no status reordering.
  assert.deepEqual(
    entries.map((entry) => entry.status),
    ['running', 'waiting', 'idle'],
  )
  assert.deepEqual(
    entries.map((entry) => entry.focused),
    [false, true, false],
  )
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [1, 2, 3],
  )
})

test('an entry title falls back to the localized placeholder when the session has none', () => {
  const entries = projectStrip(fixtureLayout(), fixtureSessions(), fixtureStatuses(), 'Untitled')
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ['Alpha', 'Untitled', 'Gamma'],
  )
})

test('a blank or whitespace title also falls back', () => {
  const sessions = { byId: { s1: { id: 's1', title: '   ' } } }
  const entries = projectStrip(fixtureLayout(), sessions, undefined, 'Untitled')
  assert.equal(entries[0].title, 'Untitled')
})

test('the live session status drives the dot, with waiting ahead of running', () => {
  const statuses = new Map([
    ['s1', { running: true, pendingInteraction: { kind: 'question' } }],
    ['s2', { running: true, pendingInteraction: null }],
  ])
  const entries = projectStrip(fixtureLayout(), fixtureSessions(), statuses, 'Untitled')

  assert.equal(entries[0].status, 'waiting')
  assert.equal(entries[1].status, 'running')
  assert.equal(entries[2].status, 'idle')
})

test('the session summary is the fallback when no status map is available', () => {
  const sessions = {
    byId: {
      s1: { id: 's1', title: 'Alpha', running: true },
      s2: { id: 's2', title: 'Beta', running: false },
    },
  }
  const entries = projectStrip(fixtureLayout(), sessions, undefined, 'Untitled')

  assert.deepEqual(
    entries.map((entry) => entry.status),
    ['running', 'idle', 'idle'],
  )
})

test('there is no error status: an `errored` field is ignored', () => {
  const sessions = { byId: { s1: { id: 's1', title: 'Alpha', errored: true } } }
  const entries = projectStrip(fixtureLayout(), sessions, undefined, 'Untitled')

  assert.equal(entries[0].status, 'idle')
})

test('only the first four entries advertise a keyboard shortcut', () => {
  const leaves = Array.from({ length: 5 }, (_, i) => `p${i + 1}`)
  let root = { kind: 'leaf', paneId: leaves[0] }
  const panes = {}
  for (let i = 0; i < leaves.length; i += 1) {
    panes[leaves[i]] = { paneId: leaves[i], sessionId: `s${i + 1}`, view: 'chat' }
    if (i > 0) root = { kind: 'split', dir: 'row', ratio: 0.5, a: root, b: { kind: 'leaf', paneId: leaves[i] } }
  }
  const entries = projectStrip(
    { root, panes, activePaneId: 'p1' },
    { byId: {} },
    undefined,
    'Untitled',
  )

  assert.equal(STRIP_SHORTCUT_LIMIT, 4)
  assert.deepEqual(
    entries.map((entry) => entry.shortcut),
    ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', undefined],
  )
})

test('an empty layout has no strip entries', () => {
  assert.deepEqual(projectStrip({ root: null, panes: {}, activePaneId: null }, {}, undefined, 'Untitled'), [])
})

test('a status change never reorders entries or moves their shortcut numbers', () => {
  const idle = projectStrip(fixtureLayout(), fixtureSessions(), undefined, 'Untitled')
  const busy = projectStrip(fixtureLayout(), fixtureSessions(), fixtureStatuses(), 'Untitled')

  assert.deepEqual(
    busy.map((entry) => [entry.paneId, entry.sessionId, entry.index, entry.shortcut]),
    idle.map((entry) => [entry.paneId, entry.sessionId, entry.index, entry.shortcut]),
  )
  // Only the dot kind changed; titles and focus are untouched.
  assert.deepEqual(
    busy.map((entry) => entry.status),
    ['running', 'waiting', 'idle'],
  )
  assert.deepEqual(
    idle.map((entry) => entry.status),
    ['idle', 'idle', 'idle'],
  )
  assert.deepEqual(
    busy.map((entry) => [entry.title, entry.focused]),
    idle.map((entry) => [entry.title, entry.focused]),
  )
})

test('Ctrl+1..4 map to the Nth strip position; other chords are ignored', () => {
  assert.equal(focusShortcutIndex({ key: '1', ctrlKey: true }), 1)
  assert.equal(focusShortcutIndex({ key: '4', ctrlKey: true }), 4)
  assert.equal(focusShortcutIndex({ key: '2', metaKey: true }), 2)

  assert.equal(focusShortcutIndex({ key: '5', ctrlKey: true }), null)
  assert.equal(focusShortcutIndex({ key: '0', ctrlKey: true }), null)
  assert.equal(focusShortcutIndex({ key: '1' }), null)
  assert.equal(focusShortcutIndex({ key: '1', ctrlKey: true, shiftKey: true }), null)
  assert.equal(focusShortcutIndex({ key: '1', ctrlKey: true, altKey: true }), null)
  assert.equal(focusShortcutIndex({ key: 'a', ctrlKey: true }), null)
  assert.equal(focusShortcutIndex({ key: '1', ctrlKey: true, defaultPrevented: true }), null)
  assert.equal(focusShortcutIndex(null), null)
})

test('the chord index resolves through the same projection as the strip', () => {
  const layout = fixtureLayout()

  assert.equal(paneIdForStripIndex(layout, 1), 'p1')
  assert.equal(paneIdForStripIndex(layout, 2), 'p2')
  assert.equal(paneIdForStripIndex(layout, 3), 'p3')
  assert.equal(paneIdForStripIndex(layout, 4), null)
  assert.equal(paneIdForStripIndex(layout, 0), null)
  assert.equal(paneIdForStripIndex(layout, 1.5), null)
  assert.equal(paneIdForStripIndex({ root: null, panes: {}, activePaneId: null }, 1), null)
})

test('a dropped pane record shifts both the strip and Ctrl+N identically', () => {
  const layout = fixtureLayout()
  // The tree still names p2, but its pane record is gone (a dropped record can
  // never be rendered). The strip renumbers p3 to position 2; so must the chord.
  delete layout.panes.p2

  const entries = openConversationItems(layout)
  assert.deepEqual(entries.map((entry) => [entry.paneId, entry.index]), [
    ['p1', 1],
    ['p3', 2],
  ])
  assert.equal(paneIdForStripIndex(layout, 2), 'p3')
  assert.equal(paneIdForStripIndex(layout, 3), null)
})
