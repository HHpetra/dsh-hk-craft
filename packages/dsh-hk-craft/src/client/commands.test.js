'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { registerCommands } = require('./commands.js')

/** @param {object} table */
function fakeT(table) {
  const base = {
    'command.clear.label': 'New conversation',
    'command.clear.description': 'Start a new conversation in this workspace.',
    'command.resume.label': 'Resume conversation',
    'command.resume.description': 'Switch to a past conversation in this workspace.',
    'command.resume.search.placeholder': 'Search titles and first prompts',
    'command.resume.search.empty': 'No past conversations in this workspace',
    'command.resume.search.noResults': 'No matching conversations',
    'session.untitled': 'Untitled conversation',
    'badge.running': 'running',
    'time.justNow': 'just now',
    'time.minutesAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'time.daysAgo': '{n}d ago',
    ...table,
  }
  return (key, params) => {
    const template = base[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }
}

function fakeCommandUi() {
  const registered = []
  return {
    registered,
    register(spec) {
      registered.push(spec)
      return () => {}
    },
  }
}

function fakeWorkspaces(items, archivedSessionIds = []) {
  return { list: { getSnapshot: () => ({ items, archivedSessionIds, pinnedSessionIds: [], phase: 'ready' }) } }
}

const WORKSPACES = fakeWorkspaces([{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }])

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)

/** @param {object} [overrides] */
function harness(overrides = {}) {
  const commandUi = fakeCommandUi()
  const calls = { conversations: [], opened: [], started: [] }
  const services = {
    commandUi,
    sessions: {},
    workspaces: WORKSPACES,
    uiWorkspace: {},
    t: fakeT({}),
    now: () => NOW,
    conversationsFor: async (sessionId, signal) => {
      calls.conversations.push({ sessionId, signal })
      return overrides.rows ?? []
    },
    openConversation: (sessionId) => calls.opened.push(sessionId),
    startConversation: (workspaceId) => calls.started.push(workspaceId),
    ...overrides,
  }
  const disposers = registerCommands(services)
  return { commandUi, calls, services, disposers }
}

/** @param {ReturnType<typeof harness>} h */
function command(h, name) {
  return h.commandUi.registered.find((spec) => spec.name === name)
}

test('registerCommands registers /clear and /resume with localized copy', () => {
  const h = harness()
  assert.deepEqual(
    h.commandUi.registered.map((spec) => spec.name),
    ['clear', 'resume'],
  )
  for (const spec of h.commandUi.registered) {
    assert.equal(typeof spec.label, 'function')
    assert.equal(typeof spec.description, 'function')
    assert.equal(typeof spec.available, 'function')
    assert.equal(spec.available({ sessionId: 's1' }), true)
    assert.notEqual(spec.label(), spec.description())
    assert.equal(spec.label().startsWith('command.'), false)
  }
  assert.equal(h.disposers.length, 2)
})

test('/clear is a local action that starts a session in the triggering workspace', () => {
  const h = harness()
  const spec = command(h, 'clear')
  assert.equal(spec.ui.kind, 'action')
  spec.ui.run({ sessionId: 's1' })
  assert.deepEqual(h.calls.started, ['w1'])
  assert.deepEqual(h.calls.opened, [])
})

test('/clear falls back to the shell current workspace when the session has none', () => {
  const h = harness({ workspaces: fakeWorkspaces([{ workspaceId: 'w1', sessionIds: ['other'] }]) })
  command(h, 'clear').ui.run({ sessionId: 's1' })
  assert.deepEqual(h.calls.started, [undefined])
})

test('/resume is a fuzzy popup with its own search copy', () => {
  const h = harness()
  const spec = command(h, 'resume')
  assert.equal(spec.ui.kind, 'popupSelect')
  assert.equal(spec.ui.searchMode, 'fuzzy-label')
  assert.deepEqual(spec.ui.searchLabels(), {
    placeholder: 'Search titles and first prompts',
    empty: 'No past conversations in this workspace',
    noResults: 'No matching conversations',
  })
})

test('/resume options are built from the triggering workspace conversations', async () => {
  const rows = [
    {
      sessionId: 's2',
      workspaceId: 'w1',
      title: 'Fix login bug',
      firstPrompt: '登录页报错 500',
      updatedAt: NOW - 60_000,
      running: true,
      blank: false,
      archived: false,
    },
    {
      sessionId: 's1',
      workspaceId: 'w1',
      title: '',
      firstPrompt: 'Write docs',
      updatedAt: NOW - 5 * 60_000,
      running: false,
      blank: false,
      archived: false,
    },
  ]
  const h = harness({ rows })
  const signal = new AbortController().signal
  const options = await command(h, 'resume').ui.options({ sessionId: 's1' }, signal)
  assert.equal(h.calls.conversations.length, 1)
  assert.equal(h.calls.conversations[0].sessionId, 's1')
  assert.equal(h.calls.conversations[0].signal, signal)
  assert.deepEqual(
    options.map((option) => option.id),
    ['s2', 's1'],
  )
  assert.equal(options[0].label, 'Fix login bug · 登录页报错 500')
  assert.equal(options[0].detail, '1m ago')
  assert.equal(options[0].badge, 'running')
  assert.equal(options[1].label, 'Write docs')
})

test('/resume lists nothing for a session outside every workspace', async () => {
  const h = harness({ rows: [] })
  const options = await command(h, 'resume').ui.options({ sessionId: 'outsider' }, undefined)
  assert.deepEqual(options, [])
  assert.equal(h.calls.conversations[0].sessionId, 'outsider')
})

test('/resume selecting a row reveals that conversation', async () => {
  const h = harness()
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })
  assert.deepEqual(h.calls.opened, ['s2'])
})

test('registerCommands never talks to the model', () => {
  const h = harness()
  const clear = command(h, 'clear')
  const resume = command(h, 'resume')
  // Action and popupSelect specs are purely client-local: no `execute`, no
  // `command()`-style host round-trip is reachable from them.
  assert.equal('execute' in clear.ui, false)
  assert.equal('execute' in resume.ui, false)
  assert.equal('run' in resume.ui, false)
})
