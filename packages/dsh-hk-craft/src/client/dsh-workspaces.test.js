'use strict'

/**
 * The adapter is where every dsh assumption lives, so its test doubles are the
 * shell's public client services — not internals. Each fake mirrors a contract
 * recorded in `doc/upstream-contracts.md`.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { sectionModel, createSectionActions } = require('./dsh-workspaces.js')

/**
 * A client context with the two services the section touches.
 *
 * @param {{ create?: (input: any) => Promise<any>, pickDirectory?: () => Promise<string> }} [options]
 */
function fakeCtx(options = {}) {
  const calls = { startSession: [], create: [], pickDirectory: 0 }
  const uiWorkspace = {
    startSession(workspaceId, opts) {
      calls.startSession.push([workspaceId, opts])
    },
    async pickDirectory() {
      calls.pickDirectory += 1
      return 'pickPath' in options ? options.pickPath : 'C:\\picked'
    },
  }
  const workspaces = {
    async create(input) {
      calls.create.push(input)
      if (options.createError !== undefined) throw options.createError
      return { workspaceId: options.createdId ?? 'w-new', path: input.path, title: 'New' }
    },
  }
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'uiWorkspace') return uiWorkspace
        if (name === 'workspaces') return workspaces
        return undefined
      },
    },
  }
}

test('sectionModel projects the shell snapshots into section rows', () => {
  const rows = sectionModel(
    {
      phase: 'ready',
      items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s1'] }],
      archivedSessionIds: [],
    },
    { phase: 'ready', ids: ['s1'], byId: { s1: { id: 's1', running: true, retainedBy: {} } } },
    new Map([['s1', { running: true }]]),
  )
  assert.deepEqual(rows, [{ workspaceId: 'w1', title: 'A', light: 'yellow', current: false }])
})

/**
 * Stand-in for the pane controller's "was this workspace ever opened in split"
 * answer. Only `isWorkspaceEnabled` is needed by the projection.
 */
function fakePaneFace(enabledIds) {
  const asked = []
  const enabled = new Set(enabledIds)
  return {
    asked,
    panes: {
      isWorkspaceEnabled(workspaceId) {
        asked.push(workspaceId)
        return enabled.has(workspaceId)
      },
    },
  }
}

/** Two workspaces, one with a finished conversation and one with a blank one. */
function enablementSnapshots() {
  return {
    workspaces: {
      phase: 'ready',
      items: [
        { workspaceId: 'w1', title: 'Opened', sessionIds: ['done'] },
        { workspaceId: 'w2', title: 'Never opened', sessionIds: ['fresh'] },
      ],
      archivedSessionIds: [],
    },
    sessions: {
      phase: 'ready',
      ids: ['done', 'fresh'],
      byId: {
        done: { id: 'done', running: false, blank: false, retainedBy: {} },
        fresh: { id: 'fresh', running: false, blank: true, retainedBy: {} },
      },
    },
  }
}

test('sectionModel asks the pane controller which workspaces were opened in split', () => {
  const { workspaces, sessions } = enablementSnapshots()
  const { panes, asked } = fakePaneFace(['w1'])
  const rows = sectionModel(workspaces, sessions, new Map(), panes)

  assert.deepEqual(asked, ['w1', 'w2'])
  assert.deepEqual(
    rows.map((row) => [row.workspaceId, row.light]),
    [
      ['w1', 'green'],
      ['w2', 'gray'],
    ],
  )
})

test('a never-opened workspace stays gray even with a session running or waiting', () => {
  const { workspaces } = enablementSnapshots()
  const sessions = {
    phase: 'ready',
    ids: ['busy'],
    byId: { busy: { id: 'busy', running: true, blank: false, retainedBy: {} } },
  }
  workspaces.items[1].sessionIds = ['busy']
  const { panes } = fakePaneFace([])
  const rows = sectionModel(
    workspaces,
    sessions,
    new Map([['busy', { running: true, pendingInteraction: { kind: 'approval' } }]]),
    panes,
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    ['gray', 'gray'],
  )
})

test('without a pane controller every workspace counts as enabled', () => {
  const { workspaces, sessions } = enablementSnapshots()
  const rows = sectionModel(workspaces, sessions, new Map())
  assert.deepEqual(
    rows.map((row) => row.light),
    ['green', 'gray'],
  )
})

test('a controller that cannot answer degrades to all enabled, not to all gray', () => {
  const { workspaces, sessions } = enablementSnapshots()
  const panes = {
    isWorkspaceEnabled() {
      throw new Error('storage disabled')
    },
  }
  const rows = sectionModel(workspaces, sessions, new Map(), panes)
  assert.deepEqual(
    rows.map((row) => row.light),
    ['green', 'gray'],
  )
})

test('clicking a workspace starts (or reuses) its blank session with the draft kept', () => {
  const { ctx, calls } = fakeCtx()
  const actions = createSectionActions(ctx)
  actions.openWorkspace('w1')
  assert.deepEqual(calls.startSession, [['w1', { clearPreviousDraft: false }]])
})

test('adding a workspace picks a directory, creates it, then selects it', async () => {
  const { ctx, calls } = fakeCtx({ pickPath: 'C:\\projects\\new' })
  const actions = createSectionActions(ctx)
  await actions.addWorkspace()
  assert.deepEqual(calls.create, [{ path: 'C:\\projects\\new' }])
  assert.deepEqual(calls.startSession, [['w-new', { clearPreviousDraft: false }]])
})

test('a cancelled pick creates nothing and stays silent', async () => {
  const { ctx, calls } = fakeCtx()
  const actions = createSectionActions(ctx)
  await actions.addWorkspace()
  // No Electron bridge in this fake: the service path is used, and it resolved a path.
  assert.equal(calls.create.length, 1)

  const empty = fakeCtx({ pickPath: null })
  await createSectionActions(empty.ctx).addWorkspace()
  assert.equal(empty.calls.create.length, 0)
  assert.equal(empty.calls.startSession.length, 0)
})

test('a failed create rejects so the component can report it', async () => {
  const failure = new Error('workspace create failed: workspace/conflict: exists')
  const { ctx, calls } = fakeCtx({ createError: failure })
  const actions = createSectionActions(ctx)
  await assert.rejects(actions.addWorkspace(), failure)
  assert.equal(calls.startSession.length, 0)
})

test('the Electron directory bridge wins over the remote picker when present', async () => {
  const previous = globalThis.__DSH_DIRECTORY_PICKER__
  const picked = []
  globalThis.__DSH_DIRECTORY_PICKER__ = {
    async pick() {
      picked.push(true)
      return 'C:\\from-bridge'
    },
  }
  try {
    const { ctx, calls } = fakeCtx({ pickPath: 'C:\\from-service' })
    await createSectionActions(ctx).addWorkspace()
    assert.equal(picked.length, 1)
    assert.equal(calls.pickDirectory, 0)
    assert.deepEqual(calls.create, [{ path: 'C:\\from-bridge' }])
  } finally {
    if (previous === undefined) delete globalThis.__DSH_DIRECTORY_PICKER__
    else globalThis.__DSH_DIRECTORY_PICKER__ = previous
  }
})

test('without the bridge the public workspace picker is used', async () => {
  const previous = globalThis.__DSH_DIRECTORY_PICKER__
  delete globalThis.__DSH_DIRECTORY_PICKER__
  try {
    const { ctx, calls } = fakeCtx({ pickPath: 'C:\\from-service' })
    await createSectionActions(ctx).addWorkspace()
    assert.equal(calls.pickDirectory, 1)
    assert.deepEqual(calls.create, [{ path: 'C:\\from-service' }])
  } finally {
    if (previous !== undefined) globalThis.__DSH_DIRECTORY_PICKER__ = previous
  }
})

// ---------------------------------------------------------------------------
// Pane mode (ticket 08): switching workspace must not go through the native
// reveal, because that would dismiss the pane workspace and remount every pane.
// ---------------------------------------------------------------------------

/** The pane face the section talks to in pane mode. */
function fakePanes({ active = true, switched = true } = {}) {
  const calls = { switchWorkspace: [] }
  return {
    calls,
    panes: {
      active: () => active,
      switchWorkspace(workspaceId) {
        calls.switchWorkspace.push(workspaceId)
        return switched
      },
    },
  }
}

test('in pane mode a workspace click switches the pane layout instead of revealing a native session', () => {
  const { ctx, calls } = fakeCtx()
  const { panes, calls: paneCalls } = fakePanes()
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(paneCalls.switchWorkspace, ['w2'])
  assert.deepEqual(calls.startSession, [])
})

test('outside pane mode the native workspace reveal is unchanged', () => {
  const { ctx, calls } = fakeCtx()
  const { panes } = fakePanes({ active: false })
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.startSession, [['w2', { clearPreviousDraft: false }]])
})

test('a workspace the pane layout cannot show falls back to the native reveal', () => {
  const { ctx, calls } = fakeCtx()
  const { panes } = fakePanes({ switched: false })
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.startSession, [['w2', { clearPreviousDraft: false }]])
})

test('a workspace added in pane mode is selected without a native reveal', async () => {
  const { ctx, calls } = fakeCtx({ pickPath: 'C:\\projects\\new' })
  const { panes, calls: paneCalls } = fakePanes()
  const actions = createSectionActions(ctx, { panes })

  await actions.addWorkspace()

  assert.deepEqual(calls.create, [{ path: 'C:\\projects\\new' }])
  assert.deepEqual(paneCalls.switchWorkspace, ['w-new'])
  assert.deepEqual(calls.startSession, [])
})
