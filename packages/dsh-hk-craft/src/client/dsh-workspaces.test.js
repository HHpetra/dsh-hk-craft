'use strict'

/**
 * The adapter is where every dsh assumption lives, so its test doubles are the
 * shell's public client services — not internals. Each fake mirrors a contract
 * recorded in `docs/upstream-contracts.md`.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  sectionModel,
  createSectionActions,
  nativeConversationId,
  workspaceRunningCount,
} = require('./dsh-workspaces.js')
const { openCatalog } = require('./catalog.js')
const { createPaneController } = require('./dsh-pane-host.js')

/**
 * The read model for one set of raw snapshots.
 *
 * The fixtures below stay in dsh's own shapes; only this helper knows that the
 * adapter now takes a catalog.
 *
 * @param {any} workspaces `workspaces.list` snapshot
 * @param {any} sessions `sessions.list` snapshot
 * @param {any} [statuses] `sessionStatus` map or record
 * @returns {any}
 */
function catalogOf(workspaces, sessions, statuses) {
  return openCatalog({ sessions, workspaces, statuses })
}

/**
 * A client context with the two services the section touches.
 *
 * @param {{ create?: (input: any) => Promise<any>, pickDirectory?: () => Promise<string> }} [options]
 */
function fakeCtx(options = {}) {
  const calls = {
    startSession: [],
    openSession: [],
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
    openSession(sessionId) {
      calls.openSession.push(sessionId)
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
      getSnapshot: () => ({
        phase: options.workspacesPhase ?? 'ready',
        items,
        archivedSessionIds: options.archivedSessionIds ?? [],
      }),
    },
  }
  const sessions =
    options.sessionsList === undefined ? undefined : { list: { getSnapshot: () => options.sessionsList } }
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'uiWorkspace') return uiWorkspace
        if (name === 'workspaces') return workspaces
        if (name === 'sessions') return sessions
        return undefined
      },
    },
  }
}

test('sectionModel projects the shell snapshots into section rows', () => {
  const rows = sectionModel(
    catalogOf(
      {
        phase: 'ready',
        items: [{ workspaceId: 'w1', title: 'A', sessionIds: ['s1'] }],
        archivedSessionIds: [],
      },
      { phase: 'ready', ids: ['s1'], byId: { s1: { id: 's1', running: true, retainedBy: {} } } },
      new Map([['s1', { running: true }]]),
    ),
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
  const rows = sectionModel(catalogOf(workspaces, sessions, new Map()), panes)

  assert.deepEqual(asked, ['w1', 'w2'])
  assert.deepEqual(
    rows.map((row) => [row.workspaceId, row.light]),
    [
      ['w1', 'idle'],
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
    catalogOf(workspaces, sessions, new Map([['busy', { running: true, pendingInteraction: { kind: 'approval' } }]])),
    panes,
  )
  assert.deepEqual(
    rows.map((row) => row.light),
    ['gray', 'gray'],
  )
})

test('without a pane controller every workspace counts as enabled', () => {
  const { workspaces, sessions } = enablementSnapshots()
  const rows = sectionModel(catalogOf(workspaces, sessions, new Map()))
  assert.deepEqual(
    rows.map((row) => row.light),
    ['idle', 'gray'],
  )
})

test('a controller that cannot answer degrades to all enabled, not to all gray', () => {
  const { workspaces, sessions } = enablementSnapshots()
  const panes = {
    isWorkspaceEnabled() {
      throw new Error('storage disabled')
    },
  }
  const rows = sectionModel(catalogOf(workspaces, sessions, new Map()), panes)
  assert.deepEqual(
    rows.map((row) => row.light),
    ['idle', 'gray'],
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
// Reordering: the adapter forwards the anchor the drop math chose.
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
// reveal, because that would move the current session instead of the layout tree.
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
  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [])
})

test('outside pane mode a workspace with no conversation still starts its blank session', () => {
  const { ctx, calls } = fakeCtx()
  const { panes } = fakePanes({ active: false })
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [['w2', { clearPreviousDraft: false }]])
})

test('outside pane mode a workspace click reveals its latest conversation', () => {
  const { ctx, calls } = fakeCtx({
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['shown'] },
      { workspaceId: 'w2', sessionIds: ['older', 'newer', 'blank'] },
    ],
    sessionsList: {
      phase: 'ready',
      byId: {
        shown: { id: 'shown', blank: false, updatedAt: 1, retainedBy: { mainView: 1 } },
        older: { id: 'older', blank: false, updatedAt: 10, retainedBy: {} },
        newer: { id: 'newer', blank: false, updatedAt: 20, retainedBy: {} },
        blank: { id: 'blank', blank: true, updatedAt: 99, retainedBy: {} },
      },
    },
  })
  const { panes } = fakePanes({ active: false })
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, ['newer'])
  assert.deepEqual(calls.startSession, [])
})

test('outside pane mode a click keeps the conversation already showing in that workspace', () => {
  const { ctx, calls } = fakeCtx({
    workspaces: [{ workspaceId: 'w2', sessionIds: ['older', 'shown'] }],
    sessionsList: {
      phase: 'ready',
      byId: {
        older: { id: 'older', blank: false, updatedAt: 50, retainedBy: {} },
        shown: { id: 'shown', blank: false, updatedAt: 10, retainedBy: { mainView: 1 } },
      },
    },
  })
  const actions = createSectionActions(ctx, { panes: fakePanes({ active: false }).panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, ['shown'])
  assert.deepEqual(calls.startSession, [])
})

test('outside pane mode a blank on screen does not hide the workspace conversation', () => {
  const { ctx, calls } = fakeCtx({
    workspaces: [{ workspaceId: 'w2', sessionIds: ['draft', 'talk'] }],
    sessionsList: {
      phase: 'ready',
      byId: {
        draft: { id: 'draft', blank: true, updatedAt: 5, retainedBy: { mainView: 1 } },
        talk: { id: 'talk', blank: false, updatedAt: 1, retainedBy: {} },
      },
    },
  })
  const actions = createSectionActions(ctx, { panes: fakePanes({ active: false }).panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, ['talk'])
  assert.deepEqual(calls.startSession, [])
})

test('outside pane mode an archived conversation is not revealed', () => {
  const { ctx, calls } = fakeCtx({
    workspaces: [{ workspaceId: 'w2', sessionIds: ['gone', 'blank'] }],
    archivedSessionIds: ['gone'],
    sessionsList: {
      phase: 'ready',
      byId: {
        gone: { id: 'gone', blank: false, updatedAt: 40, retainedBy: {} },
        blank: { id: 'blank', blank: true, updatedAt: 1, retainedBy: {} },
      },
    },
  })
  const actions = createSectionActions(ctx, { panes: fakePanes({ active: false }).panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [['w2', { clearPreviousDraft: false }]])
})

test('outside pane mode a loading session catalog still starts the blank session', () => {
  const { ctx, calls } = fakeCtx({
    workspaces: [{ workspaceId: 'w2', sessionIds: ['s1'] }],
    sessionsList: { phase: 'loading', byId: { s1: { id: 's1', blank: false, updatedAt: 1 } } },
  })
  const actions = createSectionActions(ctx, { panes: fakePanes({ active: false }).panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [['w2', { clearPreviousDraft: false }]])
})

test('nativeConversationId ignores a conversation that belongs to another workspace', () => {
  const sessionId = nativeConversationId(
    catalogOf(
      {
        phase: 'ready',
        items: [{ workspaceId: 'w2', sessionIds: ['blank'] }],
        archivedSessionIds: [],
      },
      {
        phase: 'ready',
        byId: {
          elsewhere: { id: 'elsewhere', blank: false, updatedAt: 9, retainedBy: { mainView: 1 } },
          blank: { id: 'blank', blank: true, updatedAt: 1, retainedBy: {} },
        },
      },
    ),
    'w2',
  )
  assert.equal(sessionId, undefined)
})

test('a workspace the pane layout cannot show falls back to the native reveal', () => {
  const { ctx, calls } = fakeCtx()
  const { panes } = fakePanes({ switched: false })
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [['w2', { clearPreviousDraft: false }]])
})

test('a refused pane switch still reveals the workspace conversation', () => {
  const { ctx, calls } = fakeCtx({
    workspaces: [{ workspaceId: 'w2', sessionIds: ['s9'] }],
    sessionsList: {
      phase: 'ready',
      byId: { s9: { id: 's9', blank: false, updatedAt: 3, retainedBy: {} } },
    },
  })
  const { panes } = fakePanes({ switched: false })
  const actions = createSectionActions(ctx, { panes })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.openSession, ['s9'])
  assert.deepEqual(calls.startSession, [])
})

/**
 * A real pane kernel on a ctx that records `layout.selectPanel`, so a workspace
 * click can be seen to close a 全局面板 before it switches.
 *
 * @param {{ active?: boolean }} [options]
 */
function workspaceClickRig({ active = true } = {}) {
  const calls = { selectPanel: [], startSession: [], openSession: [] }
  const panel = { activePanelId: 'plugins' }
  const rows = {
    s1: { id: 's1', blank: false, updatedAt: 1, retainedBy: { mainView: 1 }, running: false },
    s2: { id: 's2', blank: false, updatedAt: 2, retainedBy: {}, running: false },
  }
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s2'] },
  ]
  const ctx = {
    calls,
    panel,
    sessions: {
      list: { getSnapshot: () => ({ byId: rows }) },
      retain() {
        return { release() {} }
      },
    },
    layout: {
      panelInfo: { getSnapshot: () => ({ activePanelId: panel.activePanelId }) },
      selectPanel(panelId) {
        calls.selectPanel.push(panelId)
        calls.workspaceWhenPanel = ctx.controller?.getSnapshot?.().workspaceId ?? null
        panel.activePanelId = panelId
      },
    },
    slots: { snapshot: () => [] },
    workspaces: {
      list: {
        getSnapshot: () => ({ items: workspaces, archivedSessionIds: [], phase: 'ready' }),
      },
    },
    get(name) {
      if (name === 'uiWorkspace') {
        return {
          startSession(workspaceId, opts) {
            calls.startSession.push([workspaceId, opts])
            if (ctx.startSessionError !== undefined) throw ctx.startSessionError
          },
          openSession(sessionId) {
            calls.openSession.push(sessionId)
          },
        }
      }
      if (name === 'workspaces') return ctx.workspaces
      if (name === 'sessions') return ctx.sessions
      return undefined
    },
  }
  const controller = createPaneController(ctx)
  ctx.controller = controller
  if (active) {
    controller.markRegistered()
    controller.activate('s1')
  }
  return { ctx, calls, controller, panel }
}

/** The pane face a workspace click actually uses. */
function rigPanes(controller, { active, switched } = {}) {
  return {
    active: () => (active === undefined ? controller.getSnapshot().active : active),
    returnToPanes: () => controller.returnToPanes(),
    switchWorkspace: (workspaceId) =>
      switched === undefined ? controller.switchWorkspace(workspaceId) : switched,
  }
}

test('a workspace click closes the global panel before switching the pane tree', () => {
  const { ctx, calls, controller } = workspaceClickRig()
  const actions = createSectionActions(ctx, { panes: rigPanes(controller) })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.selectPanel, [null])
  assert.equal(calls.workspaceWhenPanel, 'w1')
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.equal(ctx.panel.activePanelId, null)
  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [])
})

test('a workspace click closes the panel even when the panel snapshot cannot be read', () => {
  const { ctx, calls, controller } = workspaceClickRig()
  // A stale/missing panel face must not turn the explicit click into a no-op:
  // the click itself is the request to show the panes again.
  ctx.layout.panelInfo.getSnapshot = () => {
    throw new Error('panelInfo unavailable')
  }
  const actions = createSectionActions(ctx, { panes: rigPanes(controller) })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.selectPanel, [null])
  assert.equal(controller.getSnapshot().workspaceId, 'w2')
  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [])
})

test('a pane face that throws still lets the native reveal run', () => {
  const { ctx, calls } = workspaceClickRig()
  const actions = createSectionActions(ctx, {
    panes: {
      returnToPanes() {
        throw new Error('panel close failed')
      },
      active: () => true,
      switchWorkspace: () => true,
    },
  })

  const originalError = console.error
  console.error = () => {}
  try {
    actions.openWorkspace('w2')
  } finally {
    console.error = originalError
  }

  assert.deepEqual(calls.selectPanel, [])
  assert.deepEqual(calls.openSession, ['s2'])
  assert.deepEqual(calls.startSession, [])
})

test('a workspace click outside split mode does not touch the global panel', () => {
  const { ctx, calls, controller } = workspaceClickRig({ active: false })
  const actions = createSectionActions(ctx, { panes: rigPanes(controller) })

  actions.openWorkspace('w2')

  assert.deepEqual(calls.selectPanel, [])
  assert.equal(ctx.panel.activePanelId, 'plugins')
  assert.deepEqual(calls.openSession, ['s2'])
  assert.deepEqual(calls.startSession, [])
})

test('a workspace with nothing to show still surfaces the host failure and does not touch the panel', () => {
  const failure = new Error('workspace/not-found: gone')
  const { ctx, calls, controller } = workspaceClickRig({ active: false })
  ctx.startSessionError = failure
  const actions = createSectionActions(ctx, { panes: rigPanes(controller) })

  assert.throws(() => actions.openWorkspace('gone'), failure)
  assert.deepEqual(calls.selectPanel, [])
  assert.equal(ctx.panel.activePanelId, 'plugins')
  assert.deepEqual(calls.openSession, [])
  assert.deepEqual(calls.startSession, [['gone', { clearPreviousDraft: false }]])
})

test('a refused workspace switch still closes the global panel and keeps the host failure', () => {
  const failure = new Error('workspace/not-found: gone')
  const { ctx, calls, controller } = workspaceClickRig()
  ctx.startSessionError = failure
  const actions = createSectionActions(ctx, {
    panes: rigPanes(controller, { active: true, switched: false }),
  })

  assert.throws(() => actions.openWorkspace('gone'), failure)
  assert.deepEqual(calls.selectPanel, [null])
  assert.equal(ctx.panel.activePanelId, null)
  assert.deepEqual(calls.startSession, [['gone', { clearPreviousDraft: false }]])
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
// Deleting a workspace: the public service first, then the local
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

  assert.equal(workspaceRunningCount(catalogOf(workspaces, sessions, statuses), 'w1'), 2)
  assert.equal(workspaceRunningCount(catalogOf(workspaces, sessions, statuses), 'unknown'), 0)
  assert.equal(workspaceRunningCount(catalogOf({ phase: 'loading' }, sessions, statuses), 'w1'), 0)
  assert.equal(workspaceRunningCount(catalogOf(workspaces, { phase: 'loading' }, statuses), 'w1'), 0)
})

test('the enabled set is computed once per pane snapshot, not per store tick', () => {
  const workspaces = {
    phase: 'ready',
    items: [
      { workspaceId: 'w1', title: 'A', sessionIds: [] },
      { workspaceId: 'w2', title: 'B', sessionIds: [] },
    ],
    archivedSessionIds: [],
  }
  const sessions = { phase: 'ready', ids: [], byId: {} }
  const paneSnapshot = { active: true, workspaceId: 'w1', layouts: {} }
  let probes = 0
  const panes = {
    isWorkspaceEnabled(workspaceId) {
      probes += 1
      return workspaceId === 'w1'
    },
  }

  const first = sectionModel(catalogOf(workspaces, sessions), panes, paneSnapshot)
  assert.equal(probes, 2, 'one probe per workspace on the first projection')
  assert.deepEqual(first.map((row) => row.light), ['gray', 'gray'])

  // A later store tick rebuilds the catalog but not the pane snapshot: the
  // inventory is the same, so the storage probes must not run again.
  sectionModel(catalogOf(workspaces, { ...sessions }), panes, paneSnapshot)
  assert.equal(probes, 2)

  // A new controller snapshot means the loaded layouts may have moved.
  sectionModel(catalogOf(workspaces, { ...sessions }), panes, { ...paneSnapshot })
  assert.equal(probes, 4)
})