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

test('a configured terminal shell skips the PowerShell probe', () => {
  const logged = []
  const chosen = { path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd', args: [] }
  const controller = { config: { shell: chosen } }
  const services = { terminalController: controller }
  const ctx = {
    logger: { debug: (...args) => logged.push(args.join(' ')), warn() {} },
    get: (serviceName) => services[serviceName],
    inject(names, callback) {
      callback({ get: (serviceName) => services[serviceName] })
    },
  }

  apply(ctx)

  assert.equal(controller.config.shell, chosen, 'the user choice must stay untouched')
  assert.ok(
    logged.some((line) => line.includes('skipping PowerShell probe')),
    'the skip must be visible in the log',
  )
})

test('a missing terminal controller config is not fatal', () => {
  const controller = { config: null }
  const ctx = {
    logger: { debug() {}, warn() {} },
    inject(names, callback) {
      callback({ get: () => controller })
    },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(controller.config, null)
})
