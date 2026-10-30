'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  registerCommands,
  createCtrlEnterTracker,
  createNewConversationBinding,
  isModN,
} = require('./commands.js')

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
    'command.resume.inPane': 'In pane {n}',
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
  // Two command registrations plus the Ctrl+Enter modifier tracker.
  assert.equal(h.disposers.length, 3)
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

// ---------------------------------------------------------------------------
// Pane-aware handoff (ticket 05, extending ticket 03's commands)
// ---------------------------------------------------------------------------

/** A stand-in for the pane host face the commands call. */
function fakePanes({ active = true, focused = { paneId: 'p2', sessionId: 's1' }, paneIndexOf } = {}) {
  const calls = { replaced: [], newConversation: [], openedInNewPane: [], focused: [] }
  return {
    calls,
    active: () => active,
    focused: () => focused,
    paneIndexFor: paneIndexOf ?? (() => null),
    replaceFocused: (sessionId) => {
      calls.replaced.push(sessionId)
      return true
    },
    newConversation: (workspaceId) => {
      calls.newConversation.push(workspaceId)
      return Promise.resolve(true)
    },
    openInNewPane: (sessionId) => {
      calls.openedInNewPane.push(sessionId)
      return Promise.resolve(true)
    },
  }
}

test('/clear puts a new conversation in the focused pane instead of closing the split view', () => {
  const panes = fakePanes()
  const h = harness({ panes })
  command(h, 'clear').ui.run({ sessionId: 's1' })

  assert.deepEqual(panes.calls.newConversation, ['w1'])
  assert.deepEqual(h.calls.started, [])
})

test('/clear still uses the native path when the pane workspace is not showing', () => {
  const panes = fakePanes({ active: false })
  const h = harness({ panes })
  command(h, 'clear').ui.run({ sessionId: 's1' })

  assert.deepEqual(panes.calls.newConversation, [])
  assert.deepEqual(h.calls.started, ['w1'])
})

test('/resume replaces the focused pane session rather than navigating the shell', async () => {
  const panes = fakePanes()
  const h = harness({ panes })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.replaced, ['s2'])
  assert.deepEqual(h.calls.opened, [])
})

test('/resume uses the native reveal when no pane is focused', async () => {
  const panes = fakePanes({ active: false, focused: null })
  const h = harness({ panes })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(h.calls.opened, ['s2'])
})

test('/resume uses the native reveal when the pane workspace is showing but empty', async () => {
  const panes = fakePanes({ active: true, focused: null })
  const h = harness({ panes })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(h.calls.opened, ['s2'])
})

test('/resume marks conversations already open in a pane with their position', async () => {
  const panes = fakePanes({ paneIndexOf: (sessionId) => (sessionId === 's2' ? 2 : null) })
  const rows = [
    {
      sessionId: 's2',
      workspaceId: 'w1',
      title: 'Open already',
      firstPrompt: '',
      updatedAt: NOW - 60_000,
      running: true,
      blank: false,
      archived: false,
    },
  ]
  const h = harness({ panes, rows })
  const options = await command(h, 'resume').ui.options({ sessionId: 's1' }, undefined)

  assert.equal(options[0].badge, 'running · In pane 2')
})

test('/resume does not claim a pane position outside the pane workspace', async () => {
  const panes = fakePanes({ active: false, paneIndexOf: () => 2 })
  const h = harness({
    panes,
    rows: [
      {
        sessionId: 's2',
        workspaceId: 'w1',
        title: 'Open already',
        firstPrompt: '',
        updatedAt: 1,
        running: false,
        blank: false,
        archived: false,
      },
    ],
  })
  const options = await command(h, 'resume').ui.options({ sessionId: 's1' }, undefined)
  assert.equal('badge' in options[0], false)
})

test('/resume selecting an already-open conversation focuses its pane', async () => {
  const panes = fakePanes()
  const h = harness({ panes })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  // `replaceFocused` is the host's "focus the holder, otherwise replace" seam;
  // the controller tests cover the focus-don't-remount half.
  assert.deepEqual(panes.calls.replaced, ['s2'])
  assert.deepEqual(panes.calls.openedInNewPane, [])
})

// ---------------------------------------------------------------------------
// Mod+N: identical to /clear while the pane workspace is active (spec D8)
// ---------------------------------------------------------------------------

test('Mod+N opens a new conversation in the focused pane while the pane workspace is active', () => {
  assert.equal(isModN({ key: 'n', ctrlKey: true }), true)
  assert.equal(isModN({ code: 'KeyN', ctrlKey: true }), true)
  assert.equal(isModN({ key: 'N', metaKey: true }), true)
  assert.equal(isModN({ key: 'n', ctrlKey: true, shiftKey: true }), false)
  assert.equal(isModN({ key: 'n', ctrlKey: true, altKey: true }), false)
  assert.equal(isModN({ key: 'n' }), false)
  assert.equal(isModN({ key: 'j', ctrlKey: true }), false)

  const target = fakeEventTarget()
  const panes = fakePanes()
  const binding = createNewConversationBinding(target, panes)

  target.dispatch('keydown', { key: 'n', ctrlKey: true, preventDefault() {}, stopPropagation() {} })

  assert.deepEqual(panes.calls.newConversation.length, 1)
  binding.dispose()
})

test('Mod+N outside the pane workspace keeps dsh\'s native meaning', () => {
  const target = fakeEventTarget()
  const panes = fakePanes({ active: false })
  const binding = createNewConversationBinding(target, panes)

  target.dispatch('keydown', { key: 'n', ctrlKey: true, preventDefault() {}, stopPropagation() {} })

  assert.deepEqual(panes.calls.newConversation, [])
  binding.dispose()
})

test('registerCommands binds Mod+N only when a pane host exists', () => {
  const target = fakeEventTarget()
  const panes = fakePanes()
  const h = harness({ panes, keyTarget: target })
  // /clear + /resume + Ctrl+Enter tracker + Mod+N binding.
  assert.equal(h.disposers.length, 4)

  target.dispatch('keydown', { key: 'n', ctrlKey: true, preventDefault() {}, stopPropagation() {} })
  assert.equal(panes.calls.newConversation.length, 1)

  for (const dispose of h.disposers) dispose()
  assert.equal(target.listeners.size, 0)
})

// ---------------------------------------------------------------------------
// Ctrl+Enter: open the chosen conversation in a new pane (ticket 06)
// ---------------------------------------------------------------------------

test('/resume + Ctrl+Enter opens the chosen conversation in a new pane', async () => {
  const panes = fakePanes()
  const h = harness({ panes, newPaneRequested: () => true })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.openedInNewPane, ['s2'])
  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(h.calls.opened, [])
})

test('/resume without Ctrl+Enter still replaces the focused pane', async () => {
  const panes = fakePanes()
  const h = harness({ panes, newPaneRequested: () => false })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.openedInNewPane, [])
  assert.deepEqual(panes.calls.replaced, ['s2'])
})

test('/resume + Ctrl+Enter outside the pane workspace reveals natively', async () => {
  const panes = fakePanes({ active: false, focused: null })
  const h = harness({ panes, newPaneRequested: () => true })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.openedInNewPane, [])
  assert.deepEqual(h.calls.opened, ['s2'])
})

test('the Ctrl+Enter tracker arms on the chord and is consumed once', () => {
  const target = fakeEventTarget()
  const tracker = createCtrlEnterTracker(target)

  assert.equal(tracker.consume(), false)

  target.dispatch('keydown', { key: 'Enter', ctrlKey: true })
  assert.equal(tracker.consume(), true)
  assert.equal(tracker.consume(), false)
})

test('plain Enter and a released modifier never arm the new-pane selection', () => {
  const target = fakeEventTarget()
  const tracker = createCtrlEnterTracker(target)

  target.dispatch('keydown', { key: 'Enter' })
  assert.equal(tracker.consume(), false)

  target.dispatch('keydown', { key: 'Enter', ctrlKey: true })
  target.dispatch('keyup', { key: 'Enter' })
  assert.equal(tracker.consume(), false)
})

test('disposing the tracker removes its listeners', () => {
  const target = fakeEventTarget()
  const tracker = createCtrlEnterTracker(target)

  assert.equal(target.listeners.size, 2)
  tracker.dispose()
  assert.equal(target.listeners.size, 0)
})

test('a tracker without a document is a harmless no-op', () => {
  const tracker = createCtrlEnterTracker(undefined)
  assert.equal(tracker.consume(), false)
  tracker.dispose()
})

/** Tiny EventTarget stand-in: listeners are kept by type so tests can dispatch. */
function fakeEventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      const set = listeners.get(type)
      if (set === undefined) return
      set.delete(listener)
      if (set.size === 0) listeners.delete(type)
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
  }
}
