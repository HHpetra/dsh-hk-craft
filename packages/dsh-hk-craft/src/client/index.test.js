'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { NS, inject, apply, WORKSPACE_SLOT_PRIORITY } = require('./index.js')
const { zh, en } = require('./locale.js')

/** Minimal stand-in for the Cordis client context. */
function fakeCtx() {
  const calls = { effect: [], locale: [], injected: [], registered: [], injections: [] }
  const ctx = {
    calls,
    effect(fn, label) {
      calls.effect.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        calls.locale.push({ namespace, dictionaries })
        return () => {}
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
    inject(services, callback) {
      calls.injections.push(services)
      callback(ctx)
      return () => {}
    },
    get() {
      return undefined
    },
  }
  return ctx
}

/** @returns {{ options: any, component: any }} */
function entryNamed(ctx, name) {
  const entry = ctx.calls.registered.find((candidate) => candidate.options.name === name)
  assert.ok(entry !== undefined, `no registration for slot ${name}`)
  return entry
}

test('declares the services it uses', () => {
  assert.deepEqual(inject, ['slots', 'locale'])
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

test('apply is idempotent in shape: no module-level state leaks between loads', () => {
  const first = fakeCtx()
  const second = fakeCtx()
  apply(first)
  apply(second)
  assert.equal(first.calls.registered.length, second.calls.registered.length)
})
