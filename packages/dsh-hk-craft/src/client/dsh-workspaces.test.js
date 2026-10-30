'use strict'

/**
 * The adapter is where every dsh assumption lives, so its test doubles are the
 * shell's public client services — not internals. Each fake mirrors a contract
 * recorded in `doc/upstream-contracts.md`.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { sectionModel, createSectionActions, workspaceRunningCount } = require('./dsh-workspaces.js')

/**
 * A client context with the two services the section touches.
 *
 * @param {{ create?: (input: any) => Promise<any>, pickDirectory?: () => Promise<string> }} [options]
 */
function fakeCtx(options = {}) {
  const calls = {
    startSession: [],
    create: [],
    pickDirectory: 0,
    delete: [],
    insertBefore: [],
  }
  const items = [...(options.workspaces ?? [])]
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
    async delete(workspaceId) {
      calls.delete.push(workspaceId)
      if (options.deleteError !== undefined) throw options.deleteError
      // Mirror the host: a successful delete drops the row immediately, so a
      // caller that still needs the old position must have captured it first.
      const index = items.findIndex((item) => item.workspaceId === workspaceId)
      if (index !== -1) items.splice(index, 1)
    },
    async insertBefore(workspaceId, beforeWorkspaceId) {
      calls.insertBefore.push([workspaceId, beforeWorkspaceId])
      if (options.reorderError !== undefined) throw options.reorderError
    },
    list: {
      getSnapshot: () => ({ phase: 'ready', items, archivedSessionIds: [] }),
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
// Reordering (ticket 04): the adapter forwards the anchor the drop math chose.
// ---------------------------------------------------------------------------

test('reordering moves the source before the chosen host anchor', async () => {
  const { ctx, calls } = fakeCtx()
  await createSectionActions(ctx).reorderWorkspace('b', 'a')
  assert.deepEqual(calls.insertBefore, [['b', 'a']])
  assert.deepEqual(calls.startSession, [], 'reordering must not open or switch a workspace')
})

test('reordering without an anchor appends to the end', async () => {
  const { ctx, calls } = fakeCtx()
  await createSectionActions(ctx).reorderWorkspace('b', undefined)
  assert.deepEqual(calls.insertBefore, [['b', undefined]])
})

test('reordering in pane mode touches neither the pane tree nor the native view', async () => {
  const { ctx, calls } = fakeCtx()
  const { panes, calls: paneCalls } = fakePanes()
  await createSectionActions(ctx, { panes }).reorderWorkspace('b', 'c')
  assert.deepEqual(calls.insertBefore, [['b', 'c']])
  assert.deepEqual(paneCalls.switchWorkspace, [], 'the current workspace must not change')
  assert.deepEqual(calls.startSession, [], 'focus must not change')
})

test('a failed reorder rejects with the host error so the section can report it', async () => {
  const failure = new Error('workspace reorder failed: workspace/not-found: missing')
  const { ctx } = fakeCtx({ reorderError: failure })
  await assert.rejects(createSectionActions(ctx).reorderWorkspace('b', 'a'), failure)
})

// ---------------------------------------------------------------------------
// Pane mode (ticket 08): switching workspace must not go through the native
// reveal, because that would dismiss the pane workspace and remount every pane.
// ---------------------------------------------------------------------------

/** The pane face the section talks to in pane mode. */
function fakePanes({ active = true, switched = true, forgotten = true } = {}) {
  const calls = { switchWorkspace: [], forgetWorkspace: [] }
  return {
    calls,
    panes: {
      active: () => active,
      switchWorkspace(workspaceId) {
        calls.switchWorkspace.push(workspaceId)
        return switched
      },
      forgetWorkspace(workspaceId, options) {
        calls.forgetWorkspace.push([workspaceId, options])
        return forgotten
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

// ---------------------------------------------------------------------------
// Deleting a workspace (ticket 03): the public service first, then the local
// pane bookkeeping. The host order is captured before the delete because the
// catalog drops the row immediately.
// ---------------------------------------------------------------------------

test('a delete calls workspaces.delete, then forgets the workspace with the host order captured beforehand', async () => {
  const hostOrder = [{ workspaceId: 'w1' }, { workspaceId: 'w2' }, { workspaceId: 'w3' }]
  const { ctx, calls } = fakeCtx({ workspaces: hostOrder })
  const { panes, calls: paneCalls } = fakePanes()
  const actions = createSectionActions(ctx, { panes })

  await actions.deleteWorkspace('w2')

  assert.deepEqual(calls.delete, ['w2'])
  assert.deepEqual(paneCalls.forgetWorkspace, [['w2', { order: ['w1', 'w2', 'w3'] }]])
})

test('a failed public delete rejects and never touches the pane layout', async () => {
  const failure = new Error('workspace delete failed: workspace/not-found')
  const { ctx, calls } = fakeCtx({ deleteError: failure, workspaces: [{ workspaceId: 'w1' }] })
  const { panes, calls: paneCalls } = fakePanes()

  await assert.rejects(createSectionActions(ctx, { panes }).deleteWorkspace('w1'), failure)
  assert.deepEqual(calls.delete, ['w1'])
  assert.deepEqual(paneCalls.forgetWorkspace, [])
})

test('a delete outside pane mode removes the registration with no pane controller', async () => {
  const { ctx, calls } = fakeCtx({ workspaces: [{ workspaceId: 'w1' }] })

  await createSectionActions(ctx).deleteWorkspace('w1')

  assert.deepEqual(calls.delete, ['w1'])
})

test('a shell without workspaces.delete reports a clear error instead of half-deleting', async () => {
  const ctx = {
    get(name) {
      return name === 'workspaces' ? { list: { getSnapshot: () => ({ items: [] }) } } : undefined
    },
  }
  await assert.rejects(
    createSectionActions(ctx).deleteWorkspace('w1'),
    /workspaces\.delete is not available/,
  )
})

test('deleting with no workspace id is refused before any service call', async () => {
  const { ctx, calls } = fakeCtx()

  await assert.rejects(createSectionActions(ctx).deleteWorkspace(''), /workspace id is required/)
  assert.deepEqual(calls.delete, [])
})

test('the running-session count is what the delete warning promises', () => {
  const workspaces = {
    phase: 'ready',
    items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 'archived', 'gone'] }],
    archivedSessionIds: ['archived'],
  }
  const sessions = {
    phase: 'ready',
    byId: {
      s1: { id: 's1', running: true },
      s2: { id: 's2', running: false },
      s3: { id: 's3', running: false },
    },
  }
  // s1 runs per its summary, s2 runs per the unified status, s3 only waits for
  // the user (waiting is not running), and archived / vanished members are out.
  const statuses = new Map([
    ['s2', { running: true }],
    ['s3', { running: false, pendingInteraction: { kind: 'approval' } }],
  ])

  assert.equal(workspaceRunningCount(workspaces, sessions, statuses, 'w1'), 2)
  assert.equal(workspaceRunningCount(workspaces, sessions, statuses, 'unknown'), 0)
  assert.equal(workspaceRunningCount({ phase: 'loading' }, sessions, statuses, 'w1'), 0)
  assert.equal(workspaceRunningCount(workspaces, { phase: 'loading' }, statuses, 'w1'), 0)
})
