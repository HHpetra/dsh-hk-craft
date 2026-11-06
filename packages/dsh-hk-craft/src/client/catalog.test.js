'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  openCatalog,
  readCatalogs,
  phaseReady,
  readStatusEntry,
  SESSIONS_SERVICE,
  WORKSPACES_SERVICE,
  UI_SESSION_SERVICE,
} = require('./catalog.js')
const {
  sessionRow,
  sessionsSnapshot,
  workspaceItem,
  workspacesSnapshot,
  statusEntry,
  statusMap,
} = require('./snapshot-fixtures.js')

/** @param {string} name @returns {{get: (name: string) => any}} */
function fakeCtx(services) {
  return {
    get(name) {
      return services[name]
    },
  }
}

/** One workspace holding `s1` and `s2`, with `s2` archived. */
function twoSessions() {
  return {
    sessions: sessionsSnapshot([
      sessionRow('s1', { title: 'First', updatedAt: 5 }),
      sessionRow('s2', { title: 'Second', blank: true }),
    ]),
    workspaces: workspacesSnapshot([workspaceItem('w1', { sessionIds: ['s1', 's2'] })], {
      archived: ['s2'],
    }),
  }
}

// ---------------------------------------------------------------------------
// readiness
// ---------------------------------------------------------------------------

test('a missing phase counts as ready; pending, loading and unknown do not', () => {
  assert.equal(phaseReady({ byId: {} }), true)
  assert.equal(phaseReady({ phase: 'ready' }), true)
  assert.equal(phaseReady({ phase: 'pending' }), false)
  assert.equal(phaseReady({ phase: 'loading' }), false)
  assert.equal(phaseReady({ phase: 'readying' }), false)
  assert.equal(phaseReady(undefined), false)
  assert.equal(phaseReady(null), false)
  assert.equal(phaseReady('ready'), false)
})

test('complete needs both catalogs, and each is exposed on its own', () => {
  const both = openCatalog({
    sessions: sessionsSnapshot([]),
    workspaces: workspacesSnapshot([]),
  })
  assert.equal(both.sessionsReady(), true)
  assert.equal(both.workspacesReady(), true)
  assert.equal(both.complete(), true)

  const half = openCatalog({
    sessions: sessionsSnapshot([], { phase: 'loading' }),
    workspaces: workspacesSnapshot([]),
  })
  assert.equal(half.sessionsReady(), false)
  assert.equal(half.workspacesReady(), true)
  assert.equal(half.complete(), false)

  const absent = openCatalog({})
  assert.equal(absent.sessionsReady(), false)
  assert.equal(absent.workspacesReady(), false)
  assert.equal(absent.complete(), false)
})

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

test('workspaces project id, title and a parsed createdAt in catalog order', () => {
  const catalog = openCatalog({
    workspaces: workspacesSnapshot([
      workspaceItem('w1', { title: 'Project A', createdAt: '2026-01-02T03:04:05.000Z' }),
      workspaceItem('w2', { title: '' }),
      workspaceItem('', { title: 'no id' }),
      workspaceItem('w1', { title: 'duplicate' }),
    ]),
  })
  const rows = catalog.workspaces()
  assert.deepEqual(
    rows.map((row) => [row.id, row.title]),
    [
      ['w1', 'Project A'],
      ['w2', ''],
    ],
  )
  assert.equal(rows[0].createdAt, Date.parse('2026-01-02T03:04:05.000Z'))
  assert.equal(rows[1].createdAt, undefined)
  assert.equal(Object.isFrozen(rows), true)
  assert.deepEqual(catalog.workspace('w1'), rows[0])
  assert.equal(catalog.workspace('nope'), undefined)
})

test('without a workspaces catalog every workspace query answers empty', () => {
  const catalog = openCatalog({ sessions: sessionsSnapshot([sessionRow('s1')]) })
  assert.deepEqual(catalog.workspaces(), [])
  assert.deepEqual(catalog.sessionsOf('w1'), [])
  assert.equal(catalog.workspaceOf('s1'), undefined)
})

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

test('sessionsOf joins membership in workspace order and flags the row', () => {
  const catalog = openCatalog(twoSessions())
  const rows = catalog.sessionsOf('w1')

  assert.deepEqual(
    rows.map((row) => row.id),
    ['s1', 's2'],
  )
  assert.deepEqual(rows[0], {
    id: 's1',
    title: 'First',
    started: true,
    archived: false,
    updatedAt: 5,
    subagent: false,
  })
  assert.equal(rows[1].started, false, 'blank means no message was ever sent')
  assert.equal(rows[1].archived, true, 'archived rows are flagged, never dropped')
  assert.equal(rows[1].updatedAt, 0, 'a missing updatedAt reads as zero')
})

test('sessionsOf skips sessions the catalog cannot resolve, and unknown workspaces answer empty', () => {
  const sessions = sessionsSnapshot([sessionRow('s1')])
  const workspaces = workspacesSnapshot([
    workspaceItem('w1', { sessionIds: ['s1', 'gone', 42, null, 's1'] }),
  ])
  const catalog = openCatalog({ sessions, workspaces })

  assert.deepEqual(
    catalog.sessionsOf('w1').map((row) => row.id),
    ['s1'],
  )
  assert.deepEqual(catalog.sessionsOf('w2'), [])
  assert.deepEqual(catalog.sessionsOf(null), [])
})

test('a session row keeps the durable title only and the catalog id as its identity', () => {
  const signed = sessionsSnapshot([sessionRow('s1', { title: 42 })])
  signed.byId.keyed = { displayTitle: 'from the cwd', blank: false }
  const catalog = openCatalog({ sessions: signed })

  assert.deepEqual(catalog.session('s1'), {
    id: 's1',
    title: '',
    started: true,
    archived: false,
    updatedAt: 0,
    subagent: false,
  })
  assert.equal(catalog.session('keyed').id, 'keyed', 'a row without an id reads as its key')
  assert.equal(catalog.session('nope'), undefined)
  assert.equal(catalog.session(''), undefined)
})

test('sessionListMetadata corrects a stale blank hint', () => {
  // After a host reconnect the summary can still say blank while the persisted
  // metadata already knows a turn was sent. The catalog has to follow that
  // correction, or startup treats the history as a conversation that never started.
  const catalog = openCatalog({
    sessions: sessionsSnapshot([
      sessionRow('old', {
        blank: true,
        projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 5 } },
      }),
      sessionRow('fresh', {
        blank: true,
        projectionValues: { sessionListMetadata: { blank: true, lastPromptAt: null } },
      }),
    ]),
  })
  assert.equal(catalog.session('old').started, true)
  assert.equal(catalog.session('fresh').started, false)
})

test('sessionsOf returns one stable array per workspace', () => {
  const catalog = openCatalog(twoSessions())
  assert.equal(catalog.sessionsOf('w1'), catalog.sessionsOf('w1'))
})

test('memberIds is the membership before the join', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([sessionRow('s1')]),
    workspaces: workspacesSnapshot([
      workspaceItem('w1', { sessionIds: ['s1', 'not-projected-yet', 42, 's1'] }),
    ]),
  })
  // A restored layout needs "does this workspace still list it", which must stay
  // answerable for a session the session catalog has not projected yet.
  assert.deepEqual(catalog.memberIds('w1'), ['s1', 'not-projected-yet'])
  assert.deepEqual(
    catalog.sessionsOf('w1').map((row) => row.id),
    ['s1'],
    'the join still skips what it cannot resolve',
  )
  assert.deepEqual(catalog.memberIds('nope'), [])
})

test('a subagent session carries the bit instead of the raw origin', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([sessionRow('parent'), sessionRow('child', { origin: 'subagent' })]),
  })
  assert.equal(catalog.session('child').subagent, true)
  assert.equal(catalog.session('parent').subagent, false)
  assert.equal('origin' in catalog.session('child'), false, 'the raw field stays inside the catalog')
})

test('sessionIds lists what the catalog holds, in catalog order', () => {
  const catalog = openCatalog({ sessions: sessionsSnapshot([sessionRow('s1'), sessionRow('s2')]) })
  assert.deepEqual(catalog.sessionIds(), ['s1', 's2'])
  assert.deepEqual(openCatalog({}).sessionIds(), [])
})

// ---------------------------------------------------------------------------
// current
// ---------------------------------------------------------------------------

test('the current session is the row retaining mainView', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([
      sessionRow('s1', { retainedBy: { hkcraftPane: 2 } }),
      sessionRow('s2', { retainedBy: { mainView: 1 } }),
      sessionRow('s3', { retainedBy: { mainView: 1 } }),
    ]),
  })
  assert.equal(catalog.current(), 's2', 'the first retaining row wins')
})

test('current is undefined without a retaining row or without a catalog', () => {
  const none = openCatalog({ sessions: sessionsSnapshot([sessionRow('s1')]) })
  assert.equal(none.current(), undefined)
  assert.equal(openCatalog({}).current(), undefined)
})

// ---------------------------------------------------------------------------
// signal
// ---------------------------------------------------------------------------

test('signal combines the live status with the summary row', () => {
  const catalog = openCatalog({
    ...twoSessions(),
    statuses: statusMap({
      s1: statusEntry({ running: true }),
      s2: statusEntry({ pendingInteraction: { kind: 'approval', key: 'k1' }, completionUnread: true }),
    }),
  })

  assert.deepEqual(catalog.signal('s1'), {
    running: true,
    waiting: false,
    started: true,
    unread: false,
  })
  assert.deepEqual(catalog.signal('s2'), {
    running: false,
    waiting: true,
    started: false,
    unread: true,
  })
})

test('signal falls back to the summary row when the status store is absent', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([sessionRow('s1', { running: true })]),
    workspaces: workspacesSnapshot([]),
  })
  assert.deepEqual(catalog.signal('s1'), {
    running: true,
    waiting: false,
    started: true,
    unread: false,
  })
  assert.equal(catalog.signal('unknown').started, false)
})

test('signal reads a plain record as well as a Map', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([sessionRow('s1')]),
    statuses: { s1: statusEntry({ completionUnread: true }) },
  })
  assert.equal(catalog.signal('s1').unread, true)
  assert.equal(readStatusEntry({ s1: { running: true } }, 's1').running, true)
  assert.equal(readStatusEntry(statusMap({ s1: { running: true } }), 's1').running, true)
  assert.equal(readStatusEntry(undefined, 's1'), undefined)
})

// ---------------------------------------------------------------------------
// projections
// ---------------------------------------------------------------------------

test('projectionsOf returns both projection payloads from their two tables', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([sessionRow('s1', { projectionValues: { agentPreset: 'craft' } })], {
      projectionsBySession: { s1: { values: { subagentCatalog: [{ id: 'child' }] } } },
    }),
  })
  const projections = catalog.projectionsOf('s1')
  assert.deepEqual(projections.session, { agentPreset: 'craft' })
  assert.deepEqual(projections.subagents, [{ id: 'child' }])
})

test('projectionsOf is undefined only when neither table carries anything', () => {
  const empty = openCatalog({ sessions: sessionsSnapshot([sessionRow('s1')]) })
  assert.deepEqual(empty.projectionsOf('s1'), { session: {}, subagents: undefined })

  const bare = sessionsSnapshot([sessionRow('s2')])
  delete bare.byId.s2.projectionValues
  const catalog = openCatalog({ sessions: bare })
  assert.equal(catalog.projectionsOf('s2'), undefined)
  assert.equal(catalog.projectionsOf(''), undefined)
})

// ---------------------------------------------------------------------------
// ownership
// ---------------------------------------------------------------------------

test('workspaceOf names the owning workspace and ignores unknown sessions', () => {
  const catalog = openCatalog({
    sessions: sessionsSnapshot([sessionRow('s1')]),
    workspaces: workspacesSnapshot([
      workspaceItem('w1', { title: 'A', sessionIds: ['s1'] }),
      workspaceItem('w2', { title: 'B', sessionIds: ['s1'] }),
    ]),
  })
  assert.equal(catalog.workspaceOf('s1').id, 'w1', 'the first workspace in catalog order wins')
  assert.equal(catalog.workspaceOf('s9'), undefined)
  assert.equal(catalog.workspaceOf(''), undefined)
})

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

test('the same snapshot triple yields the same catalog object', () => {
  const input = twoSessions()
  const first = openCatalog(input)
  assert.equal(openCatalog(input), first, 'unchanged inputs keep the identity')
  assert.equal(openCatalog({ ...input }), first, 'a new bag holding the same snapshots keeps it too')
})

test('a changed snapshot yields a different catalog and replaces the single memo slot', () => {
  const input = twoSessions()
  const first = openCatalog(input)
  const other = sessionsSnapshot([sessionRow('s9')])
  const second = openCatalog({ sessions: other, workspaces: input.workspaces })

  assert.notEqual(second, first)
  // One slot only: going back re-derives instead of resurrecting `first`.
  const again = openCatalog(input)
  assert.notEqual(again, first)
  assert.notEqual(again, second)
  assert.equal(openCatalog(input), again, 'the newest triple stays memoised')
})

// ---------------------------------------------------------------------------
// readCatalogs
// ---------------------------------------------------------------------------

test('readCatalogs reads the three snapshots through the live ctx', () => {
  const sessions = sessionsSnapshot([])
  const workspaces = workspacesSnapshot([])
  const statuses = statusMap({})
  const catalogs = readCatalogs(
    fakeCtx({
      [SESSIONS_SERVICE]: { list: { getSnapshot: () => sessions } },
      [WORKSPACES_SERVICE]: { list: { getSnapshot: () => workspaces } },
      [UI_SESSION_SERVICE]: { sessionStatus: { getSnapshot: () => statuses } },
    }),
  )
  assert.equal(catalogs.sessions, sessions)
  assert.equal(catalogs.workspaces, workspaces)
  assert.equal(catalogs.statuses, statuses)
})

test('readCatalogs degrades to undefined for absent, throwing or partial services', () => {
  assert.deepEqual(readCatalogs(undefined), {
    sessions: undefined,
    workspaces: undefined,
    statuses: undefined,
  })
  assert.deepEqual(readCatalogs({}), {
    sessions: undefined,
    workspaces: undefined,
    statuses: undefined,
  })
  const throwing = {
    get() {
      throw new Error('service unavailable')
    },
  }
  const degraded = readCatalogs(throwing)
  assert.equal(degraded.sessions, undefined)
  assert.equal(degraded.statuses, undefined)

  // A service present without a list snapshot is not an error either.
  const partial = readCatalogs({ [SESSIONS_SERVICE]: {} })
  assert.equal(partial.sessions, undefined)
  assert.equal(partial.workspaces, undefined)
})

test('a catalog built from readCatalogs answers without any service', () => {
  const catalog = openCatalog(readCatalogs({}))
  assert.equal(catalog.complete(), false)
  assert.deepEqual(catalog.workspaces(), [])
  assert.equal(catalog.current(), undefined)
  assert.deepEqual(catalog.signal('s1'), {
    running: false,
    waiting: false,
    started: false,
    unread: false,
  })
})