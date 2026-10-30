'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { NS, inject, apply } = require('./index.js')
const { zh, en } = require('./locale.js')

/** Minimal stand-in for the Cordis client context. */
function fakeCtx() {
  const calls = { effect: [], locale: [], injected: [], registered: [] }
  return {
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
  }
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
  assert.deepEqual(ctx.calls.injected, ['sidebar.footer.action'])
  assert.equal(ctx.calls.registered.length, 1)
  const { options, component } = ctx.calls.registered[0]
  assert.equal(options.name, 'sidebar.footer.action')
  assert.equal(options.id, 'dsh-hk-craft.diagnostics')
  assert.equal(options.locale, NS)
  assert.equal(typeof component, 'function')
})

test('apply is idempotent in shape: no module-level state leaks between loads', () => {
  const first = fakeCtx()
  const second = fakeCtx()
  apply(first)
  apply(second)
  assert.equal(first.calls.registered.length, second.calls.registered.length)
})
