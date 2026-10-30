'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  NS,
  inject,
  COMMAND_SERVICES,
  apply,
  WORKSPACE_SLOT_PRIORITY,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SLOT,
} = require('./index.js')
const { zh, en } = require('./locale.js')
const { CONTENT_FACTORY, PANEL_KEY, PANE_SLOT } = require('./dsh-pane-host.js')

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
function commandServices() {
  const commands = []
  return {
    services: {
      ...workspaceServices(),
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

test('the four workspace lights have localized names and green is no longer "no active session"', () => {
  for (const light of ['gray', 'green', 'yellow', 'red']) {
    const key = `workspace.light.${light}`
    assert.equal(typeof zh[key], 'string', key)
    assert.notEqual(zh[key], '', key)
    assert.equal(typeof en[key], 'string', key)
    assert.notEqual(en[key], '', key)
  }
  assert.match(zh['workspace.light.gray'], /未启用/)
  assert.match(en['workspace.light.gray'], /not enabled/i)
  assert.notEqual(zh['workspace.light.green'], '无活动会话')
  assert.match(zh['workspace.light.green'], /结束/)
  assert.match(en['workspace.light.green'], /finished/i)
})

test('the running-pane close confirmation says the conversation is kept in history', () => {
  assert.equal(zh['pane.close.confirm.title'], '会话将被中断并保留在历史中')
  assert.match(en['pane.close.confirm.title'], /history/)
})

test('registers its main key with a session-scoped child slot', () => {
  const ctx = fakeCtx()
  apply(ctx)

  const main = ctx.calls.registered.find((entry) => entry.options.name === 'main')
  assert.notEqual(main, undefined)
  assert.equal(main.options.key, PANEL_KEY)
  assert.equal(main.options.locale, NS)
  assert.deepEqual(main.options.children, {
    [PANE_SLOT]: { kind: 'single', scope: 'session' },
  })
  assert.equal(typeof main.component, 'function')

  const body = ctx.calls.registered.find((entry) => entry.options.name === PANE_SLOT)
  assert.notEqual(body, undefined)
  assert.equal(typeof body.component, 'function')
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
  assert.equal(injected.panes.isWorkspaceEnabled('w1'), false, 'nothing opened in split yet')
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

test('registers /clear and /resume once the command services exist', () => {
  const { services, commands } = commandServices()
  const ctx = fakeCtx({ services })
  apply(ctx)
  assert.deepEqual(
    commands.map((spec) => spec.name),
    ['clear', 'resume'],
  )
  assert.deepEqual(commands.map((spec) => spec.ui.kind), ['action', 'popupSelect'])
  assert.equal(commands[1].ui.searchMode, 'fuzzy-label')
})

test('skips command registration when a command service is missing', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.deepEqual(ctx.calls.injections, [['uiWorkspace', 'workspaces']])
  assert.equal(ctx.calls.registered.length, 4)
})

test('apply is idempotent in shape: no module-level state leaks between loads', () => {
  const first = fakeCtx()
  const second = fakeCtx()
  apply(first)
  apply(second)
  assert.equal(first.calls.registered.length, second.calls.registered.length)
})
