'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  NS,
  inject,
  COMMAND_SERVICES,
  apply,
  createModeRosterLoader,
  createHeaderSeats,
  WORKSPACE_SLOT_PRIORITY,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SLOT,
  catalogRefresher,
} = require('./index.js')
const { zh, en } = require('./locale.js')
const { BUILT_IN_MODE_KEYS } = require('./pane-mode.js')
const { CONTENT_FACTORY, CONVERSATION_KEY, MAIN_PANEL_PRIORITY, PANE_SLOT } = require('./dsh-pane-host.js')

/** @returns {object} one fake workspace snapshot store */
function workspaceService(items = []) {
  const deletes = []
  return {
    deletes,
    list: {
      getSnapshot: () => ({ items, archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready' }),
    },
    async delete(workspaceId) {
      deletes.push(workspaceId)
    },
  }
}

/** Services the sidebar workspace section needs, so its slot always registers. */
function workspaceServices() {
  return {
    uiWorkspace: { openSession() {}, startSession() {}, pickDirectory: async () => null },
    workspaces: workspaceService([{ workspaceId: 'w1', sessionIds: ['s1'] }]),
  }
}

/**
 * Minimal stand-in for the Cordis client context.
 *
 * `inject(names, callback)` mirrors the real contract: the callback only runs
 * once every named service exists.
 *
 * @param {{services?: Record<string, unknown>, absentSlots?: string[]}} [options]
 */
function fakeCtx({ services = workspaceServices(), absentSlots = [] } = {}) {
  const calls = {
    effect: [],
    locale: [],
    injected: [],
    registered: [],
    injections: [],
    services: [],
    snapshot: [],
    retained: [],
    selectPanel: [],
  }
  const panel = { activePanelId: null }
  const panelListeners = new Set()
  const ctx = {
    calls,
    panel,
    services,
    effect(fn, label) {
      calls.effect.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      calls.services.push(name)
      return services[name]
    },
    inject(names, callback) {
      if (!names.every((name) => services[name] !== undefined)) return () => {}
      calls.injections.push(names)
      callback(ctx)
      return () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        calls.locale.push({ namespace, dictionaries })
        return () => {}
      },
      bind(namespace) {
        return (key) => {
          const table = namespace === NS ? zh : en
          return table[key] ?? key
        }
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: {} }) },
      retain(sessionId, options) {
        calls.retained.push({ sessionId, options })
        return { sessionId, release() {} }
      },
    },
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: panel.activePanelId }),
        subscribe(listener) {
          panelListeners.add(listener)
          return () => panelListeners.delete(listener)
        },
      },
      selectPanel(panelId) {
        calls.selectPanel.push(panelId)
        panel.activePanelId = panelId
        for (const listener of [...panelListeners]) listener()
      },
    },
    slots: {
      inject(key, callback) {
        calls.injected.push(key)
        if (absentSlots.includes(key)) return () => {}
        const result = callback()
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          const disposers = []
          for (const value of result) if (typeof value === 'function') disposers.push(value)
          return () => {
            for (const dispose of disposers.reverse()) dispose()
          }
        }
        return typeof result === 'function' ? result : () => {}
      },
      register(options, component) {
        calls.registered.push({ options, component })
        return () => {}
      },
      snapshot(name) {
        calls.snapshot.push(name)
        return name === `factory:${CONTENT_FACTORY}`
          ? [{ type: 'factory', name: CONTENT_FACTORY, scope: 'session-maybe' }]
          : []
      },
    },
  }
  return ctx
}

/** @returns {{options: any, component: any}} */
function entryNamed(ctx, name) {
  const entry = ctx.calls.registered.find((candidate) => candidate.options.name === name)
  assert.ok(entry !== undefined, `no registration for slot ${name}`)
  return entry
}

/** @returns {Record<string, unknown>} a full set of command services plus its stub */
function commandServices({ fork = true } = {}) {
  const commands = []
  const base = workspaceServices()
  const uiWorkspace = { ...base.uiWorkspace }
  if (fork) uiWorkspace.forkSession = () => Promise.resolve('child')
  return {
    services: {
      ...base,
      uiWorkspace,
      commandUi: {
        register(spec) {
          commands.push(spec)
          return () => {}
        },
      },
      sessions: { list: { getSnapshot: () => ({ items: [], byId: {}, phase: 'ready' }) } },
    },
    commands,
  }
}

test('declares the services it uses', () => {
  assert.deepEqual(inject, ['slots', 'locale', 'sessions', 'layout'])
  assert.deepEqual(COMMAND_SERVICES, ['commandUi', 'sessions', 'workspaces', 'uiWorkspace'])
})

test('registers both locales under the plugin namespace', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.equal(ctx.calls.locale.length, 1)
  assert.equal(ctx.calls.locale[0].namespace, NS)
  assert.deepEqual(Object.keys(ctx.calls.locale[0].dictionaries).sort(), ['en', 'zh'])
})

test('zh and en carry the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('the five workspace lights have localized names and green is reserved for unread completions', () => {
  for (const light of ['gray', 'idle', 'green', 'yellow', 'red']) {
    const key = `workspace.light.${light}`
    assert.equal(typeof zh[key], 'string', key)
    assert.notEqual(zh[key], '', key)
    assert.equal(typeof en[key], 'string', key)
    assert.notEqual(en[key], '', key)
  }
  assert.match(zh['workspace.light.gray'], /未启用/)
  assert.match(en['workspace.light.gray'], /not enabled/i)
  assert.notEqual(zh['workspace.light.green'], '无活动会话')
  assert.match(zh['workspace.light.green'], /未查看/)
  assert.match(en['workspace.light.green'], /unread/i)
  assert.equal(zh['workspace.light.idle'], '空闲')
  assert.match(en['workspace.light.idle'], /idle/i)
})

test('the running-pane close confirmation says the conversation is kept in history', () => {
  assert.equal(zh['pane.close.confirm.title'], '会话将被中断并保留在历史中')
  assert.match(en['pane.close.confirm.title'], /history/)
})

test('shadows the conversation cell and never selects a panel', () => {
  const ctx = fakeCtx()
  apply(ctx)

  const main = ctx.calls.registered.find((entry) => entry.options.name === 'main')
  assert.notEqual(main, undefined)
  assert.equal(main.options.key, CONVERSATION_KEY)
  assert.equal(CONVERSATION_KEY, 'conversation')
  assert.equal(main.options.priority, MAIN_PANEL_PRIORITY)
  assert.equal(MAIN_PANEL_PRIORITY, -1)
  assert.equal(main.options.locale, NS)
  assert.deepEqual(main.options.children, {
    [PANE_SLOT]: { kind: 'single', scope: 'session' },
  })
  assert.deepEqual(ctx.calls.selectPanel, [])
  assert.equal(ctx.panel.activePanelId, null)
  assert.equal(typeof main.component, 'function')

  const body = ctx.calls.registered.find((entry) => entry.options.name === PANE_SLOT)
  assert.notEqual(body, undefined)
  assert.equal(typeof body.component, 'function')
})

test('the strip rightbar labels exist in both locales', () => {
  assert.equal(zh['strip.rightbar'], '右栏')
  assert.equal(en['strip.rightbar'], 'Right')
  assert.equal(zh['strip.rightbar.open'], '打开右侧边栏')
  assert.equal(en['strip.rightbar.open'], 'Open right sidebar')
  assert.equal(zh['strip.rightbar.close'], '收起右侧边栏')
  assert.equal(en['strip.rightbar.close'], 'Collapse right sidebar')
})

test('a missing right bar still lets the plugin load', () => {
  const ctx = fakeCtx()
  apply(ctx)

  assert.equal(
    ctx.calls.injections.some((names) => names.includes('sidebarRight')),
    false,
  )
  assert.ok(ctx.calls.registered.some((entry) => entry.options.name === 'main'))
  assert.deepEqual(ctx.calls.selectPanel, [])
})

test('wires the right bar and the session current when those services exist', () => {
  let expandedReads = 0
  let currentSubs = 0
  const ctx = fakeCtx({
    services: {
      ...workspaceServices(),
      sidebarRight: {
        isExpanded() {
          expandedReads += 1
          return false
        },
        toggleExpanded() {},
      },
      uiSession: {
        adapter: {
          current: {
            getSnapshot: () => ({ key: null }),
            subscribe() {
              currentSubs += 1
              return () => {}
            },
          },
        },
      },
    },
  })
  apply(ctx)

  assert.ok(expandedReads > 0)
  assert.equal(currentSubs, 1)
  assert.deepEqual(ctx.calls.selectPanel, [])
  assert.ok(ctx.calls.registered.some((entry) => entry.options.name === 'main'))
})

test('registers a dedicated HK Craft settings section instead of sidebar footer actions', () => {
  const ctx = fakeCtx()
  apply(ctx)

  const footer = ctx.calls.registered.filter(
    (entry) => entry.options.name === 'sidebar.footer.action',
  )
  assert.deepEqual(footer, [])
  assert.equal(ctx.calls.injected.includes('sidebar.footer.action'), false)

  const section = entryNamed(ctx, SETTINGS_SLOT)
  assert.equal(section.options.id, SETTINGS_SECTION_ID)
  assert.equal(section.options.locale, NS)
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), zh['settings.nav'])
  assert.equal(typeof section.component, 'function')
  assert.equal(section.options.order, SETTINGS_SECTION_ORDER)
  // Official top-level sections use orders -10..20; this page follows them.
  assert.ok(section.options.order > 20)
})

test('feature-probes conversation.content when the pane registration mounts', () => {
  const ctx = fakeCtx()
  apply(ctx)

  assert.ok(ctx.calls.snapshot.includes(`factory:${CONTENT_FACTORY}`))
})

test('waits for the workspace services before touching the workspaces slot', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.deepEqual(ctx.calls.injections, [['uiWorkspace', 'workspaces']])
})

test('stays out of the settings panel when the shell declares no section slot', () => {
  const ctx = fakeCtx({ absentSlots: [SETTINGS_SLOT] })
  apply(ctx)

  assert.equal(
    ctx.calls.registered.some((entry) => entry.options.name === SETTINGS_SLOT),
    false,
  )
  assert.equal(ctx.calls.injected.includes(SETTINGS_SLOT), true)
  // The rest of the plugin still mounts: a shell without settings is degraded,
  // not broken.
  assert.ok(ctx.calls.registered.some((entry) => entry.options.name === 'main'))
  assert.ok(ctx.calls.registered.some((entry) => entry.options.name === 'sidebar.workspaces'))
})

test('registers the workspace entry alongside this ticket\'s pane entries', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.deepEqual(
    ctx.calls.registered.map((entry) => entry.options.name).sort(),
    ['hkcraft.pane', 'main', 'settings.section', 'sidebar.workspaces'],
  )
  assert.deepEqual(ctx.calls.injected, ['settings.section', 'main', 'sidebar.workspaces'])
})

test('shadows the sidebar workspace section at a lower priority than the shipped occupant', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const { options, component } = entryNamed(ctx, 'sidebar.workspaces')
  assert.equal(options.id, 'dsh-hk-craft.workspaces')
  assert.equal(options.locale, NS)
  // dsh's slot core sorts ascending by `priority ?? 0` and renders the first, and
  // ui-workspace registers this slot at the default 0 — "lowest renders".
  assert.equal(options.priority, WORKSPACE_SLOT_PRIORITY)
  assert.ok(options.priority < 0, 'must be below the shipped occupant\'s default priority')
  assert.equal(typeof component, 'function')
})

test('the workspace entry injects the callbacks, the reorder callback and the pane enablement face', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const { options } = entryNamed(ctx, 'sidebar.workspaces')
  assert.equal(typeof options.inject, 'function')
  const injected = options.inject()
  assert.deepEqual(Object.keys(injected).sort(), [
    'addWorkspace',
    'deleteWorkspace',
    'openWorkspace',
    'panes',
    'reorderWorkspace',
  ])
  assert.equal(typeof injected.openWorkspace, 'function')
  assert.equal(typeof injected.addWorkspace, 'function')
  assert.equal(typeof injected.deleteWorkspace, 'function')
  assert.equal(typeof injected.reorderWorkspace, 'function')

  // The row light reads enablement and follows the controller snapshot; nothing
  // dsh-shaped leaks through this face.
  assert.equal(typeof injected.panes.isWorkspaceEnabled, 'function')
  assert.equal(typeof injected.panes.getSnapshot, 'function')
  assert.equal(typeof injected.panes.subscribe, 'function')
  assert.equal(injected.panes.getSnapshot().active, true, 'split view is on after the plugin loads')
  assert.equal(injected.panes.isWorkspaceEnabled('w1'), true, 'entering split view loads the current workspace')
  assert.equal(typeof injected.panes.subscribe(() => {}), 'function')
})

test('the workspaces entry deletes through the public service and the pane controller', async () => {
  const services = workspaceServices()
  const ctx = fakeCtx({ services })
  apply(ctx)
  const { options } = entryNamed(ctx, 'sidebar.workspaces')

  await options.inject().deleteWorkspace('w1')

  assert.deepEqual(services.workspaces.deletes, ['w1'])
})

test('the workspace entry declares no child slots and no store', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const { options } = entryNamed(ctx, 'sidebar.workspaces')
  assert.equal(options.children, undefined)
  assert.equal(options.store, undefined)
})

test('registers /clear, /new, /resume, /fork and /trace once the command services exist', () => {
  const { services, commands } = commandServices()
  const ctx = fakeCtx({ services })
  apply(ctx)
  assert.deepEqual(
    commands.map((spec) => spec.name),
    ['clear', 'new', 'resume', 'fork', 'trace'],
  )
  assert.deepEqual(
    commands.map((spec) => spec.ui.kind),
    ['action', 'action', 'popupSelect', 'action', 'action'],
  )
  assert.equal(commands[2].ui.searchMode, 'fuzzy-label')
  for (const spec of commands) assert.equal('execute' in spec.ui, false)
})

test('skips /fork when the shell has no forkSession and still registers the others', () => {
  const { services, commands } = commandServices({ fork: false })
  const ctx = fakeCtx({ services })
  apply(ctx)
  assert.deepEqual(
    commands.map((spec) => spec.name),
    ['clear', 'new', 'resume', 'trace'],
  )
})

test('skips command registration when a command service is missing', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.deepEqual(ctx.calls.injections, [['uiWorkspace', 'workspaces']])
  assert.equal(ctx.calls.registered.length, 4)
})

test('the pane header seats are the read-only mode badge and the subagent viewer', () => {
  const seats = createHeaderSeats(fakeCtx())
  assert.equal(typeof seats.mode, 'function')
  assert.equal(typeof seats.subagents, 'function')
  assert.deepEqual(Object.keys(seats), ['mode', 'subagents'])
})

test('the catalog refresher reads sessions through ctx.get and stays quiet without it', () => {
  const refreshed = []
  const withSessions = fakeCtx({
    services: {
      ...workspaceServices(),
      sessions: {
        refreshProjections(sessionId) {
          refreshed.push(sessionId)
        },
      },
    },
  })
  catalogRefresher(withSessions)('s9')
  assert.deepEqual(refreshed, ['s9'])

  const withoutSessions = fakeCtx({ services: { ...workspaceServices() } })
  assert.equal(catalogRefresher(withoutSessions)('s9'), undefined)
})

test('apply is idempotent in shape: no module-level state leaks between loads', () => {
  const first = fakeCtx()
  const second = fakeCtx()
  apply(first)
  apply(second)
  assert.equal(first.calls.registered.length, second.calls.registered.length)
})

test('every shipped preset and the badge explanation have copy in both languages', () => {
  for (const [language, table] of [
    ['zh', zh],
    ['en', en],
  ]) {
    for (const key of [...Object.values(BUILT_IN_MODE_KEYS), 'pane.mode.hint']) {
      assert.equal(typeof table[key], 'string', `${language} is missing ${key}`)
      assert.notEqual(table[key], '')
    }
  }
})

test('the mode roster loader reads the optional remote once per preset id', async () => {
  const calls = []
  const services = {
    ...workspaceServices(),
    remote: {
      agentPresets: {
        async list() {
          calls.push('list')
          return {
            ok: true,
            value: { presets: [{ id: 'review', name: 'Code review', description: 'Prioritize bugs.' }] },
          }
        },
      },
    },
  }
  const ctx = fakeCtx({ services })
  const loadRoster = createModeRosterLoader(ctx)

  assert.deepEqual(await loadRoster('review'), [
    { id: 'review', name: 'Code review', description: 'Prioritize bugs.' },
  ])
  // A focus switch back to the same preset must not fetch again.
  assert.deepEqual(await loadRoster('review'), [
    { id: 'review', name: 'Code review', description: 'Prioritize bugs.' },
  ])
  assert.deepEqual(calls, ['list'])

  // A different preset id is the documented retry point.
  await loadRoster('standard')
  assert.deepEqual(calls, ['list', 'list'])
  assert.deepEqual(ctx.calls.services, ['remote', 'remote'])
})

test('the roster loader degrades silently and retries after a failed read', async () => {
  const absent = createModeRosterLoader(fakeCtx())
  assert.deepEqual(await absent('standard'), [])

  let attempts = 0
  const flaky = {
    ...workspaceServices(),
    remote: {
      agentPresets: {
        async list() {
          attempts += 1
          if (attempts === 1) throw new Error('gateway not ready')
          return { ok: true, value: { presets: [{ id: 'standard' }] } }
        },
      },
    },
  }
  const loadRoster = createModeRosterLoader(fakeCtx({ services: flaky }))
  assert.deepEqual(await loadRoster('standard'), [])
  // Failures are not cached: the next preset/focus retry may succeed.
  assert.deepEqual(await loadRoster('standard'), [{ id: 'standard' }])
  assert.equal(attempts, 2)

  const malformed = createModeRosterLoader(
    fakeCtx({
      services: {
        ...workspaceServices(),
        remote: { agentPresets: { list: async () => ({ ok: true, value: {} }) } },
      },
    }),
  )
  assert.deepEqual(await malformed('standard'), [])
})
