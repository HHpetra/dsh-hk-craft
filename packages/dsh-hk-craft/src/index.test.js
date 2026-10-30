import test from 'node:test'
import assert from 'node:assert/strict'

import { name, inject, apply } from './index.js'

test('exports the row identity used by the bundle patch', () => {
  assert.equal(name, 'dsh-hk-craft')
})

test('loads without host services', () => {
  assert.deepEqual(inject, [])
  assert.doesNotThrow(() => apply({}))
})
