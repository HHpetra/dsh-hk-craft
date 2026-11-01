'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  SHELL_DEFAULT_APPLIED_KEY,
  SHELL_PREFERENCE_KEY,
  installPowerShellDefault,
  planShellDefault,
} = require('./terminal-shell.js')

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function shells(...paths) {
  return paths.map((path) => ({ path }))
}

test('an unset or cmd preference tries PowerShell 7 before Windows PowerShell', () => {
  const discovered = shells(CMD, POWERSHELL, PWSH)
  assert.deepEqual(planShellDefault({ shells: discovered, currentPath: null, applied: false }), {
    path: PWSH,
    markApplied: true,
  })
  assert.deepEqual(planShellDefault({ shells: discovered, currentPath: CMD, applied: false }), {
    path: PWSH,
    markApplied: true,
  })
  assert.deepEqual(planShellDefault({ shells: discovered, currentPath: POWERSHELL, applied: false }), {
    path: PWSH,
    markApplied: true,
  })
})

test('Windows PowerShell is used when PowerShell 7 is not installed', () => {
  assert.deepEqual(
    planShellDefault({ shells: shells(CMD, POWERSHELL), currentPath: null, applied: false }),
    { path: POWERSHELL, markApplied: false },
  )
})

test('a Windows PowerShell fallback does not block a later PowerShell 7', () => {
  assert.deepEqual(
    planShellDefault({
      shells: shells(POWERSHELL, PWSH),
      currentPath: null,
      applied: false,
    }),
    { path: PWSH, markApplied: true },
  )
  assert.deepEqual(
    planShellDefault({
      shells: shells(CMD, POWERSHELL),
      currentPath: POWERSHELL,
      applied: false,
    }),
    { path: null, markApplied: false },
  )
})

test('cmd remains when neither PowerShell is installed', () => {
  assert.deepEqual(planShellDefault({ shells: shells(CMD), currentPath: CMD, applied: false }), {
    path: null,
    markApplied: false,
  })
})

test('a shell the user already picked is kept', () => {
  assert.deepEqual(
    planShellDefault({
      shells: shells(CMD, POWERSHELL),
      currentPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      applied: false,
    }),
    { path: null, markApplied: true },
  )
  assert.deepEqual(
    planShellDefault({
      shells: shells(CMD, POWERSHELL),
      currentPath: CMD,
      applied: true,
    }),
    { path: null, markApplied: false },
  )
})

test('a non-Windows default is not replaced, and a missing PowerShell is retried later', () => {
  assert.deepEqual(
    planShellDefault({
      shells: shells('/bin/zsh', POWERSHELL),
      currentPath: null,
      applied: false,
    }),
    { path: null, markApplied: true },
  )
  assert.deepEqual(
    planShellDefault({ shells: shells(CMD), currentPath: null, applied: false }),
    { path: null, markApplied: false },
  )
})

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

test('install writes the PowerShell path through the terminal service once', async () => {
  const storage = memoryStorage({ [SHELL_PREFERENCE_KEY]: CMD })
  const selected = []
  let sessionId = null
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: {} }),
      subscribe(listener) {
        sessions.listener = listener
        return () => {
          sessions.listener = null
        }
      },
    },
  }
  const stop = installPowerShellDefault({
    webTerminals: {
      async launchShells(id) {
        sessionId = id
        return { shells: shells(CMD, POWERSHELL, PWSH) }
      },
      selectShell(path) {
        selected.push(path)
      },
    },
    sessions,
    storage,
  })
  sessions.list.getSnapshot = () => ({
    byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } },
  })
  sessions.listener()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sessionId, 's1')
  assert.deepEqual(selected, [PWSH])
  assert.equal(storage.getItem(SHELL_DEFAULT_APPLIED_KEY), 'pwsh-exe')
  stop()
})

test('a Windows PowerShell fallback is not recorded as PowerShell 7', async () => {
  const storage = memoryStorage({ [SHELL_PREFERENCE_KEY]: CMD })
  const selected = []
  let launches = 0
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } },
      }),
      subscribe(listener) {
        sessions.listener = listener
        return () => {}
      },
    },
  }
  const stop = installPowerShellDefault({
    webTerminals: {
      async launchShells() {
        launches += 1
        return { shells: shells(CMD, POWERSHELL) }
      },
      selectShell(path) {
        selected.push(path)
      },
    },
    sessions,
    storage,
  })
  await new Promise((resolve) => setImmediate(resolve))
  const afterFirst = launches
  sessions.listener()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(selected, [POWERSHELL])
  assert.equal(launches, afterFirst)
  assert.equal(storage.getItem(SHELL_DEFAULT_APPLIED_KEY), null)
  stop()
})
