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

test('the system prompt separates the user terminal from the agent shell sandbox', () => {
  const registered = []
  const ctx = {
    logger: { debug() {}, warn() {} },
    get: () => undefined,
    inject(names, callback) {
      if (!names.includes('systemPrompt')) return
      callback({
        get: () => ({
          getContextOrder: () => 42,
          context: (entry) => {
            registered.push(entry)
            return () => {}
          },
        }),
      })
    },
  }

  apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'dsh-hk-craft:user-terminal-scope')
  assert.equal(registered[0].order, 43)
  assert.equal(registered[0].required, false)
  assert.match(registered[0].text, /user-operated system shell/)
  assert.match(registered[0].text, /outside the Agent sandbox/)
  assert.match(registered[0].text, /do not say the sidebar terminal is sandboxed/)
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
