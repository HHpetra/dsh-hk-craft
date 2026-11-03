'use strict'

/**
 * The workspace status light is the one piece of sidebar behavior that has to be
 * *right*: five states, a hard precedence (red > yellow > green > idle > gray),
 * an "enabled" gate and no knowledge of React or of dsh's record shapes.
 *
 * `workspaceLight` takes plain signals; `projectWorkspaceSection` takes the
 * catalog (`catalog.js`). The case fixtures below stay in dsh's own snapshot
 * shapes on purpose — they go through `openCatalog`, so each case also pins the
 * snapshot → catalog → light path end to end.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LIGHT_GRAY,
  LIGHT_IDLE,
  LIGHT_GREEN,
  LIGHT_YELLOW,
  LIGHT_RED,
  workspaceLight,
  projectWorkspaceSection: sectionFromCatalog,
  visibleWorkspaceIdOf,
  displayWorkspaceName,
} = require('./workspace-status.js')
const { openCatalog } = require('./catalog.js')

/**
 * The section rows for one set of raw snapshots.
 *
 * @param {any} workspaces `workspaces.list` snapshot
 * @param {any} sessions `sessions.list` snapshot
 * @param {any} statuses `sessionStatus` map or record
 * @param {any} [enabled] "opened in split" set
 * @param {string|null|undefined} [visibleWorkspaceId] 可见工作区; omit to use dsh's current session
 * @returns {Array<object>}
 */
function sectionRows(workspaces, sessions, statuses, enabled, visibleWorkspaceId) {
  return sectionFromCatalog(
    openCatalog({ sessions, workspaces, statuses }),
    enabled,
    visibleWorkspaceId,
  )
}

/** An idle session that has started at least one turn, with nothing unread. */
const startedIdle = { running: false, waiting: false, started: true, unread: false }

/** A started session whose latest turn finished while it was not current. */
const startedUnread = { running: false, waiting: false, started: true, unread: true }

/** An idle session that never sent a message. */
const blankIdle = { running: false, waiting: false, started: false, unread: false }

/* ── workspaceLight: the five states ──────────────────────────────────────── */

test('a workspace with no started conversation is gray, not idle', () => {
  assert.equal(workspaceLight([]), LIGHT_GRAY)
  assert.equal(workspaceLight([blankIdle]), LIGHT_GRAY)
})

test('a workspace whose sessions are started and idle is idle, not green', () => {
  assert.equal(workspaceLight([startedIdle]), LIGHT_IDLE)
  assert.equal(workspaceLight([startedIdle, startedIdle]), LIGHT_IDLE)
})

test('an unread completion turns the workspace green', () => {
  assert.equal(workspaceLight([startedUnread]), LIGHT_GREEN)
  assert.equal(workspaceLight([startedIdle, startedUnread]), LIGHT_GREEN)
})

test('a workspace with one running session is yellow', () => {
  assert.equal(
    workspaceLight([
      startedIdle,
      { running: true, waiting: false, started: true, unread: false },
    ]),
    LIGHT_YELLOW,
  )
})

test('a workspace with a session waiting for the user is red', () => {
  assert.equal(
    workspaceLight([{ running: true, waiting: true, started: true, unread: false }]),
    LIGHT_RED,
  )
})

/* ── workspaceLight: precedence red > yellow > green > idle > gray ────────── */

test('red outranks yellow: waiting beats running, in any order', () => {
  const running = { running: true, waiting: false, started: true, unread: false }
  const waiting = { running: true, waiting: true, started: true, unread: false }
  assert.equal(workspaceLight([running, waiting]), LIGHT_RED)
  assert.equal(workspaceLight([waiting, running]), LIGHT_RED)
})

test('red outranks green wherever it sits in the list', () => {
  const waiting = { running: false, waiting: true, started: true, unread: false }
  assert.equal(workspaceLight([startedUnread, startedUnread, waiting, startedUnread]), LIGHT_RED)
})

test('yellow outranks green wherever it sits in the list', () => {
  const running = { running: true, waiting: false, started: true, unread: false }
  assert.equal(workspaceLight([startedUnread, running, startedUnread]), LIGHT_YELLOW)
})

test('green outranks idle: one unread completion lights the workspace', () => {
  assert.equal(workspaceLight([startedIdle, startedUnread, startedIdle]), LIGHT_GREEN)
})

test('idle outranks gray: one started conversation lights the workspace', () => {
  assert.equal(workspaceLight([blankIdle, startedIdle, blankIdle]), LIGHT_IDLE)
})

test('yellow and red can light a workspace that has no started conversation', () => {
  assert.equal(
    workspaceLight([{ running: true, waiting: false, started: false, unread: false }]),
    LIGHT_YELLOW,
  )
  assert.equal(
    workspaceLight([{ running: false, waiting: true, started: false, unread: false }]),
    LIGHT_RED,
  )
})

/* ── workspaceLight: defensive input ──────────────────────────────────────── */

test('a missing or malformed signal list is gray, never a crash', () => {
  assert.equal(workspaceLight(undefined), LIGHT_GRAY)
  assert.equal(workspaceLight(null), LIGHT_GRAY)
  assert.equal(workspaceLight('nope'), LIGHT_GRAY)
})

test('null entries and absent flags count as "nothing happened"', () => {
  assert.equal(workspaceLight([null, undefined, {}]), LIGHT_GRAY)
})

/* ── projectWorkspaceSection: dsh-shaped snapshots into rows ──────────────── */

const workspaces = {
  phase: 'ready',
  items: [
    { workspaceId: 'w1', title: 'Project A', path: 'C:\\a', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', title: 'default-workspace', path: 'C:\\b', sessionIds: [] },
    { workspaceId: 'w3', title: 'Project C', path: 'C:\\c', sessionIds: ['s3'] },
  ],
  archivedSessionIds: ['s9'],
}

const sessionList = {
  phase: 'ready',
  ids: ['s1', 's2', 's3', 's9'],
  byId: {
    s1: { id: 's1', running: true, blank: false, retainedBy: {} },
    s2: { id: 's2', running: false, blank: false, retainedBy: { mainView: 1 } },
    s3: { id: 's3', running: false, blank: false, retainedBy: {} },
    s9: { id: 's9', running: true, blank: false, retainedBy: {} },
  },
}

const statuses = new Map([
  ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s2', { running: false, pendingInteraction: { kind: 'question' }, completionUnread: false }],
])

/** Every workspace enabled: the shape the row tests use. */
const ALL_ENABLED = new Set(['w1', 'w2', 'w3'])

test('each workspace becomes one row with its id and stored title', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED)
  assert.deepEqual(
    rows.map((row) => [row.workspaceId, row.title]),
    [
      ['w1', 'Project A'],
      ['w2', 'default-workspace'],
      ['w3', 'Project C'],
    ],
  )
})

test('rows keep the host order and do not invent workspaces', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED)
  assert.equal(rows.length, workspaces.items.length)
})

test('the light aggregates the workspace members only', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED)
  // w1: s1 running + s2 waiting → red; w2: empty → gray; w3: s3 started, idle → idle.
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_IDLE],
  )
})

test('an enabled workspace with only blank sessions stays gray', () => {
  const rows = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['fresh'] }] },
    { phase: 'ready', ids: ['fresh'], byId: { fresh: { id: 'fresh', running: false, blank: true } }, archivedSessionIds: [] },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(rows[0].light, LIGHT_GRAY)
})

test('an enabled workspace with one started idle conversation is idle', () => {
  const rows = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['done'] }] },
    { phase: 'ready', ids: ['done'], byId: { done: { id: 'done', running: false, blank: false } }, archivedSessionIds: [] },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(rows[0].light, LIGHT_IDLE)
})

test('an enabled workspace with one unread completion is green', () => {
  const rows = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['done'] }] },
    { phase: 'ready', ids: ['done'], byId: { done: { id: 'done', running: false, blank: false } }, archivedSessionIds: [] },
    new Map([['done', { running: false, pendingInteraction: null, completionUnread: true }]]),
    new Set(['w1']),
  )
  assert.equal(rows[0].light, LIGHT_GREEN)
})

test('an enabled workspace with a running or waiting session is yellow or red', () => {
  const running = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s'] }] },
    { phase: 'ready', ids: ['s'], byId: { s: { id: 's', running: true, blank: false } } },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(running[0].light, LIGHT_YELLOW)

  const waiting = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s'] }] },
    { phase: 'ready', ids: ['s'], byId: { s: { id: 's', running: true, blank: false } } },
    new Map([['s', { running: true, pendingInteraction: { kind: 'approval' } }]]),
    new Set(['w1']),
  )
  assert.equal(waiting[0].light, LIGHT_RED)
})

test('a workspace that was never opened in split is gray even while it runs or waits', () => {
  const rows = sectionRows(
    workspaces,
    sessionList,
    statuses,
    new Set(['w3']),
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY, LIGHT_GRAY, LIGHT_IDLE],
  )
})

test('an empty enabled set makes every row gray', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, new Set())
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY, LIGHT_GRAY, LIGHT_GRAY],
  )
})

test('without an enabled set every workspace is treated as enabled', () => {
  const rows = sectionRows(workspaces, sessionList, statuses)
  // Same session-derived lights as the all-enabled case: the degraded path only
  // loses the "never opened" gray, never the idle/green/yellow/red distinction.
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_IDLE],
  )
  assert.deepEqual(
    sectionRows(workspaces, sessionList, statuses, null).map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_IDLE],
  )
})

test('an enabled set may be any collection of ids, not only a Set', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, ['w1'])
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_GRAY],
  )
})

test('the workspace holding the main-view session is the current one', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED)
  assert.deepEqual(
    rows.map((row) => [row.workspaceId, row.current]),
    [
      ['w1', true],
      ['w2', false],
      ['w3', false],
    ],
  )
})

/** Whole-row shape: which workspace is the 当前行, and that the lights did not move. */
function rowMarks(rows) {
  return rows.map((row) => [row.workspaceId, row.current, row.light])
}

test('the current row follows the visible workspace when it switches', () => {
  const onFirst = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, 'w1')
  const onThird = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, 'w3')
  // s2 retains mainView inside w1, so a row that still followed the current
  // session would stay on w1. Lights stay on the session signals.
  assert.deepEqual(rowMarks(onFirst), [
    ['w1', true, LIGHT_RED],
    ['w2', false, LIGHT_GRAY],
    ['w3', false, LIGHT_IDLE],
  ])
  assert.deepEqual(rowMarks(onThird), [
    ['w1', false, LIGHT_RED],
    ['w2', false, LIGHT_GRAY],
    ['w3', true, LIGHT_IDLE],
  ])
})

test('the visible workspace wins when it disagrees with the current session', () => {
  // s2 is the main-view session and a member of w1. The screen is showing w2.
  const rows = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, 'w2')
  assert.deepEqual(rowMarks(rows), [
    ['w1', false, LIGHT_RED],
    ['w2', true, LIGHT_GRAY],
    ['w3', false, LIGHT_IDLE],
  ])
})

test('a visible workspace id with no loaded layout marks the workspace the screen shows', () => {
  // Same rule as the pane host: no layout for `gone`, so the first loaded
  // layout (w3, then w1) is the tree on screen. w1 still holds the current session.
  const visible = visibleWorkspaceIdOf({
    active: true,
    workspaceId: 'gone',
    layouts: {
      w3: { root: null, panes: {}, activePaneId: null },
      w1: { root: null, panes: { p1: { paneId: 'p1' } }, activePaneId: 'p1' },
    },
  })
  assert.equal(visible, 'w3')
  assert.deepEqual(rowMarks(sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, visible)), [
    ['w1', false, LIGHT_RED],
    ['w2', false, LIGHT_GRAY],
    ['w3', true, LIGHT_IDLE],
  ])
})

test('the visible workspace does not depend on how many panes its tree holds', () => {
  const onePane = visibleWorkspaceIdOf({
    active: true,
    workspaceId: 'w3',
    layouts: {
      w1: { panes: { p1: { paneId: 'p1' } } },
      w3: { panes: { p9: { paneId: 'p9' } } },
    },
  })
  const manyPanes = visibleWorkspaceIdOf({
    active: true,
    workspaceId: 'w3',
    layouts: {
      w1: { panes: { p1: { paneId: 'p1' } } },
      w3: { panes: { a: {}, b: {}, c: {}, d: {} } },
    },
  })
  assert.equal(onePane, 'w3')
  assert.equal(manyPanes, 'w3')
  assert.deepEqual(rowMarks(sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, manyPanes)), [
    ['w1', false, LIGHT_RED],
    ['w2', false, LIGHT_GRAY],
    ['w3', true, LIGHT_IDLE],
  ])
})

test('without a controller snapshot the current row follows dsh\'s current session', () => {
  for (const snapshot of [undefined, null]) {
    assert.equal(visibleWorkspaceIdOf(snapshot), undefined)
    assert.deepEqual(
      sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, visibleWorkspaceIdOf(snapshot)).map(
        (row) => row.current,
      ),
      [true, false, false],
    )
  }
  assert.deepEqual(
    sectionRows(workspaces, sessionList, statuses, ALL_ENABLED).map((row) => row.current),
    [true, false, false],
  )
})

test('while split is inactive the current row follows dsh\'s current session', () => {
  const visible = visibleWorkspaceIdOf({
    active: false,
    workspaceId: 'w3',
    layouts: {
      w3: { panes: { p1: {}, p2: {} } },
    },
  })
  assert.equal(visible, undefined)
  assert.deepEqual(
    sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, visible).map((row) => row.current),
    [true, false, false],
  )
})

test('a visible workspace id that is not in the inventory marks no row', () => {
  const rows = sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, 'missing')
  assert.deepEqual(rowMarks(rows), [
    ['w1', false, LIGHT_RED],
    ['w2', false, LIGHT_GRAY],
    ['w3', false, LIGHT_IDLE],
  ])
})

test('an active split showing no workspace tree marks no row', () => {
  const visible = visibleWorkspaceIdOf({ active: true, workspaceId: null, layouts: {} })
  assert.equal(visible, null)
  assert.deepEqual(
    sectionRows(workspaces, sessionList, statuses, ALL_ENABLED, visible).map((row) => row.current),
    [false, false, false],
  )
})

test('an empty enabled workspace is gray even while another is red', () => {
  const rows = sectionRows(
    workspaces,
    { phase: 'ready', ids: ['s1'], byId: { s1: { id: 's1', running: false, blank: false, retainedBy: {} } } },
    new Map([['s1', { running: true, pendingInteraction: { kind: 'approval' } }]]),
    ALL_ENABLED,
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_GRAY],
  )
})

test('sessions outside every workspace never light a row', () => {
  const rows = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: [] }] },
    { phase: 'ready', ids: ['stray'], byId: { stray: { id: 'stray', running: true, blank: false, retainedBy: {} } } },
    new Map([['stray', { running: true, pendingInteraction: { kind: 'question' } }]]),
    new Set(['w1']),
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY],
  )
})

test('archived members are ignored: they cannot keep a workspace red', () => {
  const rows = sectionRows(
    {
      phase: 'ready',
      items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s9'] }],
      archivedSessionIds: ['s9'],
    },
    { phase: 'ready', ids: ['s9'], byId: { s9: { id: 's9', running: true, blank: false, retainedBy: {} } } },
    new Map([['s9', { running: true, pendingInteraction: { kind: 'approval' } }]]),
    new Set(['w1']),
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY],
  )
})

test('an archived finished conversation does not turn a workspace green', () => {
  const rows = sectionRows(
    {
      phase: 'ready',
      items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['old'] }],
      archivedSessionIds: ['old'],
    },
    { phase: 'ready', ids: ['old'], byId: { old: { id: 'old', running: false, blank: false } } },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(rows[0].light, LIGHT_GRAY)
})

test('a listed session the session list no longer knows is skipped', () => {
  const rows = sectionRows(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['gone', 's1'] }] },
    { phase: 'ready', ids: ['s1'], byId: { s1: { id: 's1', running: true, blank: false, retainedBy: {} } } },
    new Map(),
    new Set(['w1']),
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_YELLOW],
  )
})

test('statuses may arrive as a plain record or be absent entirely', () => {
  const record = { s1: { running: true, pendingInteraction: undefined } }
  // s2's real question is not in this record, so only s1's run is left.
  assert.equal(
    sectionRows(workspaces, sessionList, record, ALL_ENABLED)[0].light,
    LIGHT_YELLOW,
  )
  // Without any statuses the list rows' own `running` bit is the fallback.
  assert.equal(
    sectionRows(workspaces, sessionList, undefined, ALL_ENABLED)[0].light,
    LIGHT_YELLOW,
  )
})

test('an unready workspace snapshot projects to no rows', () => {
  assert.deepEqual(sectionRows({ phase: 'pending' }, sessionList, statuses), [])
  assert.deepEqual(sectionRows(undefined, sessionList, statuses), [])
})

test('an unready session list cannot prove a conversation finished, so it is all gray', () => {
  const rows = sectionRows(
    workspaces,
    { phase: 'pending', ids: [], byId: {} },
    statuses,
    ALL_ENABLED,
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY, LIGHT_GRAY, LIGHT_GRAY],
  )
})

test('a loading or pending session list stays gray even while it retains rows', () => {
  // A reload keeps the previous `byId` around; those rows prove nothing until the
  // catalog says it is ready, so they must not light yellow/green/red.
  for (const phase of ['loading', 'pending']) {
    const rows = sectionRows(
      workspaces,
      { phase, ids: sessionList.ids, byId: sessionList.byId },
      statuses,
      ALL_ENABLED,
    )
    assert.deepEqual(
      rows.map((row) => row.light),
      [LIGHT_GRAY, LIGHT_GRAY, LIGHT_GRAY],
      `phase ${phase} must not light a workspace from retained rows`,
    )
  }
})

test('an absent session phase is treated as ready', () => {
  const { phase: _phase, ...unphased } = sessionList
  const rows = sectionRows(workspaces, unphased, statuses, ALL_ENABLED)
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_IDLE],
  )
})

/* ── displayWorkspaceName: dsh's default-title convention ─────────────────── */

test("the automatic 'default-workspace' title reads as the localized default", () => {
  assert.equal(displayWorkspaceName('default-workspace', 'Default Workspace'), 'Default Workspace')
})

test('a user title is shown verbatim', () => {
  assert.equal(displayWorkspaceName('Project A', 'Default Workspace'), 'Project A')
})

test('a missing title falls back to the localized default', () => {
  assert.equal(displayWorkspaceName('', 'Default Workspace'), 'Default Workspace')
  assert.equal(displayWorkspaceName(undefined, 'Default Workspace'), 'Default Workspace')
})
