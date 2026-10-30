'use strict'

/**
 * The workspace status light is the one piece of sidebar behavior that has to be
 * *right*: four states, a hard precedence (red > yellow > green > gray), an
 * "enabled" gate and no knowledge of React or of dsh's record shapes at the call
 * site.
 *
 * These tests fix the function's contract: it consumes plain signals and a plain
 * enabled set, so a wrong assumption about dsh lives in `dsh-workspaces.js` (and
 * its test), never here.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LIGHT_GRAY,
  LIGHT_GREEN,
  LIGHT_YELLOW,
  LIGHT_RED,
  workspaceLight,
  sessionSignal,
  mainSessionId,
  projectWorkspaceSection,
  displayWorkspaceName,
} = require('./workspace-status.js')

/** An idle session that has finished at least one turn. */
const startedIdle = { running: false, waiting: false, started: true }

/** An idle session that never sent a message. */
const blankIdle = { running: false, waiting: false, started: false }

/* ── workspaceLight: the four states ──────────────────────────────────────── */

test('a workspace with no started conversation is gray, not green', () => {
  assert.equal(workspaceLight([]), LIGHT_GRAY)
  assert.equal(workspaceLight([blankIdle]), LIGHT_GRAY)
})

test('a workspace whose sessions all finished is green', () => {
  assert.equal(workspaceLight([startedIdle]), LIGHT_GREEN)
  assert.equal(workspaceLight([startedIdle, startedIdle]), LIGHT_GREEN)
})

test('a workspace with one running session is yellow', () => {
  assert.equal(
    workspaceLight([
      startedIdle,
      { running: true, waiting: false, started: true },
    ]),
    LIGHT_YELLOW,
  )
})

test('a workspace with a session waiting for the user is red', () => {
  assert.equal(workspaceLight([{ running: true, waiting: true, started: true }]), LIGHT_RED)
})

/* ── workspaceLight: precedence red > yellow > green > gray ──────────────── */

test('red outranks yellow: waiting beats running, in any order', () => {
  const running = { running: true, waiting: false, started: true }
  const waiting = { running: true, waiting: true, started: true }
  assert.equal(workspaceLight([running, waiting]), LIGHT_RED)
  assert.equal(workspaceLight([waiting, running]), LIGHT_RED)
})

test('red outranks green wherever it sits in the list', () => {
  const waiting = { running: false, waiting: true, started: true }
  assert.equal(workspaceLight([startedIdle, startedIdle, waiting, startedIdle]), LIGHT_RED)
})

test('yellow outranks green wherever it sits in the list', () => {
  const running = { running: true, waiting: false, started: true }
  assert.equal(workspaceLight([startedIdle, running, startedIdle]), LIGHT_YELLOW)
})

test('green outranks gray: one finished conversation lights the workspace', () => {
  assert.equal(workspaceLight([blankIdle, startedIdle, blankIdle]), LIGHT_GREEN)
})

test('yellow and red can light a workspace that has no finished conversation', () => {
  assert.equal(workspaceLight([{ running: true, waiting: false, started: false }]), LIGHT_YELLOW)
  assert.equal(workspaceLight([{ running: false, waiting: true, started: false }]), LIGHT_RED)
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

/* ── sessionSignal: dsh records in, plain signals out ─────────────────────── */

test('a session status marks a session running, and the list row is the fallback', () => {
  assert.deepEqual(sessionSignal({ running: true }, undefined), {
    running: true,
    waiting: false,
    started: false,
  })
  assert.deepEqual(sessionSignal({ running: false }, { running: true }), {
    running: true,
    waiting: false,
    started: false,
  })
})

test('any pending interaction means "waiting for you", whatever its kind', () => {
  for (const kind of ['approval', 'question', 'plan-review', 'something-new']) {
    assert.equal(sessionSignal({}, { pendingInteraction: { kind } }).waiting, true, kind)
  }
})

test('a null or absent pending interaction is not waiting', () => {
  assert.equal(sessionSignal({}, { pendingInteraction: null }).waiting, false)
  assert.equal(sessionSignal({}, { pendingInteraction: undefined }).waiting, false)
})

test('the summary row\'s blank bit is the only "started" source', () => {
  assert.equal(sessionSignal({ blank: false }, undefined).started, true)
  assert.equal(sessionSignal({ blank: true }, undefined).started, false)
  assert.equal(sessionSignal({}, undefined).started, false)
  // A status never invents a started conversation: only the summary knows.
  assert.equal(sessionSignal({ blank: true }, { running: false }).started, false)
})

test('the signal carries no error bit: dsh exposes none', () => {
  const signal = sessionSignal({ running: false }, { running: false })
  assert.deepEqual(Object.keys(signal).sort(), ['running', 'started', 'waiting'])
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

/** Every workspace enabled: the pre-ticket shape used by the row tests. */
const ALL_ENABLED = new Set(['w1', 'w2', 'w3'])

test('each workspace becomes one row with its id and stored title', () => {
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses, ALL_ENABLED)
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
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses, ALL_ENABLED)
  assert.equal(rows.length, workspaces.items.length)
})

test('the light aggregates the workspace members only', () => {
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses, ALL_ENABLED)
  // w1: s1 running + s2 waiting → red; w2: empty → gray; w3: s3 finished → green.
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_GREEN],
  )
})

test('an enabled workspace with only blank sessions stays gray', () => {
  const rows = projectWorkspaceSection(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['fresh'] }] },
    { phase: 'ready', ids: ['fresh'], byId: { fresh: { id: 'fresh', running: false, blank: true } }, archivedSessionIds: [] },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(rows[0].light, LIGHT_GRAY)
})

test('an enabled workspace with one finished conversation is green', () => {
  const rows = projectWorkspaceSection(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['done'] }] },
    { phase: 'ready', ids: ['done'], byId: { done: { id: 'done', running: false, blank: false } }, archivedSessionIds: [] },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(rows[0].light, LIGHT_GREEN)
})

test('an enabled workspace with a running or waiting session is yellow or red', () => {
  const running = projectWorkspaceSection(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s'] }] },
    { phase: 'ready', ids: ['s'], byId: { s: { id: 's', running: true, blank: false } } },
    new Map(),
    new Set(['w1']),
  )
  assert.equal(running[0].light, LIGHT_YELLOW)

  const waiting = projectWorkspaceSection(
    { phase: 'ready', items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s'] }] },
    { phase: 'ready', ids: ['s'], byId: { s: { id: 's', running: true, blank: false } } },
    new Map([['s', { running: true, pendingInteraction: { kind: 'approval' } }]]),
    new Set(['w1']),
  )
  assert.equal(waiting[0].light, LIGHT_RED)
})

test('a workspace that was never opened in split is gray even while it runs or waits', () => {
  const rows = projectWorkspaceSection(
    workspaces,
    sessionList,
    statuses,
    new Set(['w3']),
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY, LIGHT_GRAY, LIGHT_GREEN],
  )
})

test('an empty enabled set makes every row gray', () => {
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses, new Set())
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_GRAY, LIGHT_GRAY, LIGHT_GRAY],
  )
})

test('without an enabled set every workspace is treated as enabled', () => {
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses)
  // Same session-derived lights as the all-enabled case: the degraded path only
  // loses the "never opened" gray, never the green/yellow/red distinction.
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_GREEN],
  )
  assert.deepEqual(
    projectWorkspaceSection(workspaces, sessionList, statuses, null).map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_GREEN],
  )
})

test('an enabled set may be any collection of ids, not only a Set', () => {
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses, ['w1'])
  assert.deepEqual(
    rows.map((row) => row.light),
    [LIGHT_RED, LIGHT_GRAY, LIGHT_GRAY],
  )
})

test('the workspace holding the main-view session is the current one', () => {
  const rows = projectWorkspaceSection(workspaces, sessionList, statuses, ALL_ENABLED)
  assert.deepEqual(
    rows.map((row) => row.current),
    [true, false, false],
  )
})

test('an empty enabled workspace is gray even while another is red', () => {
  const rows = projectWorkspaceSection(
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
  const rows = projectWorkspaceSection(
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
  const rows = projectWorkspaceSection(
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
  const rows = projectWorkspaceSection(
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
  const rows = projectWorkspaceSection(
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
    projectWorkspaceSection(workspaces, sessionList, record, ALL_ENABLED)[0].light,
    LIGHT_YELLOW,
  )
  // Without any statuses the list rows' own `running` bit is the fallback.
  assert.equal(
    projectWorkspaceSection(workspaces, sessionList, undefined, ALL_ENABLED)[0].light,
    LIGHT_YELLOW,
  )
})

test('an unready workspace snapshot projects to no rows', () => {
  assert.deepEqual(projectWorkspaceSection({ phase: 'pending' }, sessionList, statuses), [])
  assert.deepEqual(projectWorkspaceSection(undefined, sessionList, statuses), [])
})

test('an unready session list cannot prove a conversation finished, so it is all gray', () => {
  const rows = projectWorkspaceSection(
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

/* ── mainSessionId: the one mainView scan ─────────────────────────────────── */

test('the derived current session is the one retained under mainView', () => {
  const sessions = {
    byId: {
      idle: { id: 'idle', retainedBy: {} },
      current: { id: 'current', retainedBy: { mainView: 1 } },
      background: { id: 'background', retainedBy: { sidebarView: 1 } },
    },
  }
  assert.equal(mainSessionId(sessions), 'current')
  assert.equal(mainSessionId({ byId: {} }), undefined)
  assert.equal(mainSessionId(undefined), undefined)
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
