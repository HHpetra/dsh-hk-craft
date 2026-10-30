'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { NS, inject, COMMAND_SERVICES, apply, WORKSPACE_SLOT_PRIORITY } = require('./index.js')
const { zh, en } = require('./locale.js')

/** @returns {object} one fake workspace snapshot store */
function workspaceService(items = []) {
  return {
    list: {
      getSnapshot: () => ({ items, archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready' }),
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
 * @param {{services?: Record<string, unknown>}} [options]
 */
function fakeCtx({ services = workspaceServices() } = {}) {
  const calls = { effect: [], locale: [], injected: [], registered: [], injections: [], services: [] }
  const ctx = {
    calls,
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
          const table = namespace === NS ? dictionaries.zh : {}
          return table[key] ?? key
        }
      },
    },
    slots: {
      inject(key, callback) {
        calls.injected.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        calls.registered.push({ options, component })
        return () => {}
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
  assert.deepEqual(inject, ['slots', 'locale'])
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

test('registers one sidebar footer action inside its slot', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const { options, component } = entryNamed(ctx, 'sidebar.footer.action')
  assert.equal(options.id, 'dsh-hk-craft.diagnostics')
  assert.equal(options.locale, NS)
  assert.equal(typeof component, 'function')
})

test('waits for the workspace services before touching the workspaces slot', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.deepEqual(ctx.calls.injections, [['uiWorkspace', 'workspaces']])
})

test('registers exactly the two slot entries this ticket owns', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.deepEqual(ctx.calls.injected, ['sidebar.footer.action', 'sidebar.workspaces'])
  assert.equal(ctx.calls.registered.length, 2)
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

test('the workspace entry injects only the two callbacks the component consumes', () => {
  const ctx = fakeCtx()
  apply(ctx)
  const { options } = entryNamed(ctx, 'sidebar.workspaces')
  assert.equal(typeof options.inject, 'function')
  const injected = options.inject()
  assert.deepEqual(Object.keys(injected).sort(), ['addWorkspace', 'openWorkspace'])
  assert.equal(typeof injected.openWorkspace, 'function')
  assert.equal(typeof injected.addWorkspace, 'function')
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
  assert.equal(ctx.calls.registered.length, 2)
})

test('apply is idempotent in shape: no module-level state leaks between loads', () => {
  const first = fakeCtx()
  const second = fakeCtx()
  apply(first)
  apply(second)
  assert.equal(first.calls.registered.length, second.calls.registered.length)
})
