'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  SOURCE,
  workspaceIdOf,
  conversationsOf,
  firstUserPromptOf,
  firstPromptOf,
  listConversations,
  listWorkspaceConversations,
  openConversation,
  startConversation,
} = require('./dsh-sessions.js')

/** @param {object[]} items */
function workspacesSnapshot(items, archived = []) {
  return { items, archivedSessionIds: archived, pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
}

/** @param {object[]} rows */
function sessionsSnapshot(rows) {
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return { ids: rows.map((row) => row.id), byId, phase: 'ready', projectionsBySession: {} }
}

/** A host-shaped session list row (`doc/upstream-contracts.md#session-summary-fields`). */
function sessionRow(overrides = {}) {
  return {
    id: 's1',
    displayTitle: 'project-dir',
    updatedAt: 1_000,
    running: false,
    blank: false,
    ...overrides,
  }
}

/** A fake ClientSessions service with a scripted `using`. */
function fakeSessions(snapshot, sessions = {}) {
  const calls = { using: [] }
  return {
    calls,
    list: { getSnapshot: () => snapshot },
    async using(target, options, operation) {
      calls.using.push({ target, options })
      const session = sessions[target]
      return operation({ sessionId: target, binding: session === undefined ? undefined : { session } })
    },
  }
}

/** A fake Session whose event window is scripted. */
function fakeSession(pages, options = {}) {
  let index = 0
  const state = { loadOlderCalls: 0 }
  const session = {
    hasMore: pages.length > 1,
    eventSource: { getSnapshot: () => ({ entries: pages[Math.min(index, pages.length - 1)], hasMore: index < pages.length - 1 }) },
    async loadOlder() {
      state.loadOlderCalls += 1
      index = Math.min(index + 1, pages.length - 1)
      session.hasMore = index < pages.length - 1
    },
  }
  return { session, state }
}

/** @param {string} text */
function userEntry(text, kind = 'user') {
  return { event: { type: 'user/message', seq: 1, data: { source: { kind }, content: [{ type: 'text', text }] } } }
}

/** A page entry that carries no human prompt. */
function turnEntry() {
  return { event: { type: 'turn/start', seq: 0, data: {} } }
}

test('workspaceIdOf resolves the workspace owning a session', () => {
  const snapshot = workspacesSnapshot([
    { workspaceId: 'w1', sessionIds: ['a'] },
    { workspaceId: 'w2', sessionIds: ['b', 'c'] },
  ])
  assert.equal(workspaceIdOf(snapshot, 'c'), 'w2')
  assert.equal(workspaceIdOf(snapshot, 'missing'), undefined)
  assert.equal(workspaceIdOf(undefined, 'a'), undefined)
})

test('conversationsOf lists the workspace sessions with their durable state', () => {
  const sessions = sessionsSnapshot([
    sessionRow({ id: 'a', title: 'Fix login', running: true, updatedAt: 5 }),
    sessionRow({ id: 'b', blank: true }),
    sessionRow({ id: 'elsewhere', title: 'Other workspace' }),
  ])
  const workspaces = workspacesSnapshot(
    [{ workspaceId: 'w1', sessionIds: ['a', 'b', 'gone'] }],
    ['b'],
  )
  const rows = conversationsOf({ sessions, workspaces, workspaceId: 'w1' })
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['a', 'b'],
  )
  assert.deepEqual(rows[0], {
    sessionId: 'a',
    workspaceId: 'w1',
    title: 'Fix login',
    firstPrompt: '',
    updatedAt: 5,
    running: true,
    blank: false,
    archived: false,
  })
  assert.equal(rows[1].blank, true)
  assert.equal(rows[1].archived, true)
})

test('conversationsOf reads the durable title only, never the display fallback', () => {
  const sessions = sessionsSnapshot([sessionRow({ id: 'a', displayTitle: 'repo-name' })])
  const workspaces = workspacesSnapshot([{ workspaceId: 'w1', sessionIds: ['a'] }])
  const rows = conversationsOf({ sessions, workspaces, workspaceId: 'w1' })
  assert.equal(rows[0].title, '')
})

test('conversationsOf is empty for an unknown workspace', () => {
  const sessions = sessionsSnapshot([sessionRow({ id: 'a' })])
  const workspaces = workspacesSnapshot([{ workspaceId: 'w1', sessionIds: ['a'] }])
  assert.deepEqual(conversationsOf({ sessions, workspaces, workspaceId: 'nope' }), [])
})

test('firstUserPromptOf returns the first human-authored text', () => {
  const entries = [
    { event: { type: 'session/title', data: { title: 'T' } } },
    userEntry('hello', 'assistant'),
    userEntry('  第一行\n第二行  '),
    userEntry('later'),
  ]
  assert.equal(firstUserPromptOf(entries), '第一行 第二行')
})

test('firstUserPromptOf skips empty or malformed human messages', () => {
  const entries = [
    userEntry('   '),
    { event: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image' }] } } },
    userEntry('real prompt'),
  ]
  assert.equal(firstUserPromptOf(entries), 'real prompt')
  assert.equal(firstUserPromptOf(undefined), '')
})

test('firstPromptOf pages older history until the first prompt is found', async () => {
  const { session, state } = fakeSession([
    [turnEntry()],
    [turnEntry()],
    [userEntry('very first'), userEntry('second')],
  ])
  const sessions = fakeSessions(sessionsSnapshot([sessionRow({ id: 'a' })]), { a: session })
  const prompt = await firstPromptOf(sessions, 'a', undefined, { maxPages: 5 })
  assert.equal(prompt, 'very first')
  assert.equal(state.loadOlderCalls, 2)
  assert.equal(sessions.calls.using[0].options.source, SOURCE)
})

test('firstPromptOf stops after the page budget', async () => {
  const { session, state } = fakeSession([[turnEntry()], [turnEntry()], [userEntry('first')]])
  const sessions = fakeSessions(sessionsSnapshot([sessionRow({ id: 'a' })]), { a: session })
  assert.equal(await firstPromptOf(sessions, 'a', undefined, { maxPages: 1 }), '')
  assert.equal(state.loadOlderCalls, 1)
})

test('firstPromptOf swallows an unavailable session', async () => {
  const sessions = {
    list: { getSnapshot: () => sessionsSnapshot([sessionRow({ id: 'a' })]) },
    async using() {
      throw new Error('session controller is disposed')
    },
  }
  assert.equal(await firstPromptOf(sessions, 'a'), '')
})

test('listConversations scopes to the triggering session workspace and enriches titleless rows', async () => {
  const { session } = fakeSession([[userEntry('first prompt text')]])
  const sessions = fakeSessions(
    sessionsSnapshot([
      sessionRow({ id: 'a', title: 'Titled' }),
      sessionRow({ id: 'b', updatedAt: 2_000 }),
      sessionRow({ id: 'c', blank: true }),
      sessionRow({ id: 'other' }),
    ]),
    { b: session, c: session },
  )
  const workspaces = workspacesSnapshot([
    { workspaceId: 'w1', sessionIds: ['a', 'b', 'c'] },
    { workspaceId: 'w2', sessionIds: ['other'] },
  ])
  const rows = await listConversations(
    { sessions, workspaces: { list: { getSnapshot: () => workspaces } } },
    'b',
  )
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['a', 'b', 'c'],
  )
  assert.equal(rows[1].firstPrompt, 'first prompt text')
  assert.equal(rows[2].firstPrompt, '')
  assert.deepEqual(
    sessions.calls.using.map((call) => call.target),
    ['b'],
  )
})

test('listConversations caps how many titleless conversations it opens', async () => {
  const { session } = fakeSession([[userEntry('first prompt text')]])
  const sessions = fakeSessions(
    sessionsSnapshot([sessionRow({ id: 'b' }), sessionRow({ id: 'c' })]),
    { b: session, c: session },
  )
  const workspaces = { list: { getSnapshot: () => workspacesSnapshot([{ workspaceId: 'w1', sessionIds: ['b', 'c'] }]) } }
  const rows = await listConversations({ sessions, workspaces }, 'b', { promptLookups: 1 })
  assert.deepEqual(
    sessions.calls.using.map((call) => call.target),
    ['b'],
  )
  assert.equal(rows[0].firstPrompt, 'first prompt text')
  assert.equal(rows[1].firstPrompt, '')
})

test('listConversations returns nothing when the session is in no workspace', async () => {
  const sessions = fakeSessions(sessionsSnapshot([sessionRow({ id: 'a' })]))
  const workspaces = workspacesSnapshot([{ workspaceId: 'w1', sessionIds: ['other'] }])
  assert.deepEqual(
    await listConversations({ sessions, workspaces: { list: { getSnapshot: () => workspaces } } }, 'a'),
    [],
  )
})

test('listWorkspaceConversations reuses the /resume projection for an explicit workspace', async () => {
  const { session } = fakeSession([[userEntry('first prompt text')]])
  const sessions = fakeSessions(
    sessionsSnapshot([
      sessionRow({ id: 'a', title: 'Titled', updatedAt: 5 }),
      sessionRow({ id: 'b', updatedAt: 9 }),
      sessionRow({ id: 'c', blank: true }),
      sessionRow({ id: 'other', title: 'Elsewhere' }),
    ]),
    { b: session },
  )
  const workspaces = workspacesSnapshot([
    { workspaceId: 'w1', sessionIds: ['a', 'b', 'c'] },
    { workspaceId: 'w2', sessionIds: ['other'] },
  ])

  const rows = await listWorkspaceConversations(
    { sessions, workspaces: { list: { getSnapshot: () => workspaces } } },
    'w1',
  )

  // The same rows `/resume` builds: catalog order, durable fields, and the
  // first-prompt fallback for titleless non-blank conversations.
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['a', 'b', 'c'],
  )
  assert.equal(rows[1].firstPrompt, 'first prompt text')
  assert.equal(rows[0].title, 'Titled')
  assert.deepEqual(
    sessions.calls.using.map((call) => call.target),
    ['b'],
  )
})

test('listWorkspaceConversations returns nothing without a usable workspace or catalog', async () => {
  const sessions = fakeSessions(sessionsSnapshot([sessionRow({ id: 'a' })]))
  const workspaces = workspacesSnapshot([{ workspaceId: 'w1', sessionIds: ['a'] }])
  const services = { sessions, workspaces: { list: { getSnapshot: () => workspaces } } }

  assert.deepEqual(await listWorkspaceConversations(services, 'nope'), [])
  assert.deepEqual(await listWorkspaceConversations(services, ''), [])
  assert.deepEqual(await listWorkspaceConversations(services, undefined), [])
  assert.deepEqual(await listWorkspaceConversations({}, 'w1'), [])
  assert.deepEqual(await listWorkspaceConversations(services, 'w1'), [
    {
      sessionId: 'a',
      workspaceId: 'w1',
      title: '',
      firstPrompt: '',
      updatedAt: 1_000,
      running: false,
      blank: false,
      archived: false,
    },
  ])
})

test('openConversation asks the workspace service to reveal the session', () => {
  const calls = []
  openConversation({ openSession: (id) => calls.push(id) }, 's9')
  assert.deepEqual(calls, ['s9'])
})

test('startConversation asks for a new session in the given workspace', () => {
  const calls = []
  startConversation({ startSession: (workspaceId) => calls.push(workspaceId) }, 'w1')
  startConversation({ startSession: (workspaceId) => calls.push(workspaceId) }, undefined)
  assert.deepEqual(calls, ['w1', undefined])
})
