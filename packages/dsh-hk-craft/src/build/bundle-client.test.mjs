/**
 * The client bundle linker is pure and load-bearing: `lib/client.js` is produced
 * by it (no bundler, no child process allowed here). These tests pin the module
 * graph rules and the shell loader contract the built file must satisfy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectModules, renderBundle, resolveModuleId } from './bundle-client.mjs'

/** @param {Record<string, string>} files */
function reader(files) {
  return (moduleId) => Object.hasOwn(files, moduleId) ? files[moduleId] : null
}

test('collects the relative require graph depth-first in a stable order', () => {
  const modules = collectModules(
    'index.js',
    reader({
      'index.js': "require('./a.js')\nrequire('./nested/b.js')",
      'a.js': "require('./nested/b.js')",
      'nested/b.js': 'module.exports = 1',
    }),
  )
  assert.deepEqual(
    modules.map((module) => module.id),
    ['index.js', 'a.js', 'nested/b.js'],
  )
})

test('resolves relative specifiers against the requiring module', () => {
  assert.equal(resolveModuleId('index.js', './a.js'), 'a.js')
  assert.equal(resolveModuleId('nested/b.js', './c.js'), 'nested/c.js')
  assert.equal(resolveModuleId('nested/b.js', '../index.js'), 'index.js')
})

test('a missing module fails the build loudly, naming the module', () => {
  assert.throws(
    () => collectModules('index.js', reader({ 'index.js': "require('./missing.js')" })),
    /missing\.js/,
  )
})

test('one module required twice is emitted once', () => {
  const modules = collectModules(
    'index.js',
    reader({ 'index.js': "require('./a.js')\nrequire('./a.js')", 'a.js': '' }),
  )
  assert.equal(modules.length, 2)
})

test('the rendered bundle boots through the shell module loader with the bundle id', () => {
  const code = renderBundle({
    id: 'dsh-hk-craft',
    entryId: 'index.js',
    modules: [{ id: 'index.js', source: 'module.exports = { ok: true }' }],
  })
  assert.ok(code.startsWith('window.__ModuleLoader__.load('))
  assert.ok(code.includes('id: "dsh-hk-craft"'))
  assert.ok(code.includes('return materialize("index.js")'))
})

test('bare specifiers stay platform requires, never bundled module lookups', () => {
  const code = renderBundle({
    id: 'x',
    entryId: 'index.js',
    modules: [{ id: 'index.js', source: "module.exports = require('react')" }],
  })
  assert.ok(code.includes('if (specifier.charAt(0) !== ".") return require(specifier)'))
  // The module body itself is preserved verbatim, so the platform require survives.
  assert.ok(code.includes("require('react')"))
})
