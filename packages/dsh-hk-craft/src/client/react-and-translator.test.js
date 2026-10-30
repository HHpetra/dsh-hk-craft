'use strict'

/**
 * The shared client helpers: translator params and the lazy React accessor.
 *
 * `createTranslator` is what every view uses when a slot hands it a translator
 * (or none), so its params contract is the difference between a dialog title
 * that reads "Delete workspace “Project A”" and one that shows a literal
 * `{name}`. These tests pin that contract and the documented non-memoized
 * `react()`.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const { createTranslator, interpolate, react } = require('./react-and-translator.js')
const { en, zh } = require('./locale.js')

/** Node exposes `navigator` as a configurable getter; swap it for one call. */
function withNavigator(language, body) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true })
  try {
    return body()
  } finally {
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
  }
}

test('the slot translator receives the key and its params', () => {
  const calls = []
  const t = createTranslator({
    t: (key, params) => {
      calls.push([key, params])
      return `${key}:${params?.n ?? ''}`
    },
  })

  assert.equal(t('strip.shortcut', { n: 3 }), 'strip.shortcut:3')
  assert.deepEqual(calls, [['strip.shortcut', { n: 3 }]])
})

test('the fallback dictionary fills {name} and {n}', () => {
  withNavigator('en-US', () => {
    const t = createTranslator({})
    assert.equal(t('workspace.delete.title', { name: 'Project A' }), 'Delete workspace “Project A”')
    assert.equal(
      t('workspace.delete.running', { n: 2 }).includes('Running conversations in this workspace: 2.'),
      true,
    )
    assert.equal(t('strip.shortcut', { n: 3 }), 'Ctrl+3')
  })
})

test('the fallback translator follows the browser language', () => {
  withNavigator('zh-CN', () => {
    const t = createTranslator(undefined)
    assert.equal(t('workspace.delete.title', { name: '项目 A' }), '删除工作区「项目 A」')
    assert.equal(t('workspace.delete.cancel'), zh['workspace.delete.cancel'])
  })
})

test('a missing param leaves its placeholder, and missing copy falls back to the key', () => {
  withNavigator('en-US', () => {
    const t = createTranslator({})
    assert.equal(interpolate('Hello {name}', {}), 'Hello {name}')
    assert.equal(interpolate('Hello {name}', { name: 'A' }), 'Hello A')
    assert.equal(t('missing.key', { n: 1 }), 'missing.key')
    // A translator that drops params still owns the result; the helper does not
    // guess at the slot's copy.
    assert.equal(createTranslator({ t: (key) => en[key] })('workspace.delete.title', { name: 'A' }), en['workspace.delete.title'])
  })
})

test('react() resolves the platform module on every call, not once for the process', () => {
  const originalLoad = Module._load
  const first = { name: 'first' }
  const second = { name: 'second' }
  try {
    Module._load = (request, parent, isMain) =>
      request === 'react' ? first : originalLoad.call(Module, request, parent, isMain)
    assert.equal(react(), first)
    Module._load = (request, parent, isMain) =>
      request === 'react' ? second : originalLoad.call(Module, request, parent, isMain)
    assert.equal(react(), second, 'a memoized instance would pin the first stand-in')
  } finally {
    Module._load = originalLoad
  }
})
