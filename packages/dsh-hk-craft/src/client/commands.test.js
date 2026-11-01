'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  registerCommands,
  createCtrlEnterTracker,
  createNewConversationBinding,
  isModN,
} = require('./commands.js')
const { zh, en } = require('./locale.js')

/** @param {object} table */
function fakeT(table) {
  const base = {
    'command.clear.label': 'New conversation',
    'command.clear.description': 'Start a new conversation in this workspace.',
    'command.new.label': 'New conversation',
    'command.new.description': 'Equivalent to /clear today.',
    'command.fork.label': 'Fork conversation',
    'command.fork.description': 'Copy the current conversation into a restorable copy.',
    'command.trace.label': 'Trajectory view',
    'command.trace.description': 'Switch the current pane to the trajectory view.',
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
      return () => {
        const index = registered.indexOf(spec)
        if (index !== -1) registered.splice(index, 1)
      }
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

test('registerCommands registers /clear, /new and /resume with localized copy', () => {
  const h = harness()
  assert.deepEqual(
    h.commandUi.registered.map((spec) => spec.name),
    ['clear', 'new', 'resume'],
  )
  for (const spec of h.commandUi.registered) {
    assert.equal(typeof spec.label, 'function')
    assert.equal(typeof spec.description, 'function')
    assert.equal(typeof spec.available, 'function')
    assert.equal(spec.available({ sessionId: 's1' }), true)
    assert.notEqual(spec.label(), spec.description())
    assert.equal(spec.label().startsWith('command.'), false)
    assert.equal(spec.description().startsWith('command.'), false)
  }
  // Three command registrations plus the Ctrl+Enter modifier tracker.
  // /fork and /trace stay unregistered until their optional services exist.
  assert.equal(h.disposers.length, 4)
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

test('/new starts a session in the triggering workspace the same way /clear does', () => {
  const h = harness()
  const spec = command(h, 'new')
  assert.equal(spec.ui.kind, 'action')
  spec.ui.run({ sessionId: 's1' })
  assert.deepEqual(h.calls.started, ['w1'])
  assert.deepEqual(h.calls.opened, [])
})

test('/new falls back to the shell current workspace when the session has none', () => {
  const h = harness({ workspaces: fakeWorkspaces([{ workspaceId: 'w1', sessionIds: ['other'] }]) })
  command(h, 'new').ui.run({ sessionId: 's1' })
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
  const h = harness({
    panes: fakePanes(),
    uiWorkspace: { forkSession: () => Promise.resolve('child') },
  })
  assert.deepEqual(
    h.commandUi.registered.map((spec) => spec.name),
    ['clear', 'new', 'resume', 'fork', 'trace'],
  )
  for (const spec of h.commandUi.registered) {
    // Action and popupSelect specs are purely client-local: no `execute`, no
    // `command()`-style host round-trip is reachable from them.
    assert.equal('execute' in spec.ui, false)
  }
  assert.equal('run' in command(h, 'resume').ui, false)
  assert.equal(command(h, 'new').ui.kind, 'action')
  assert.equal(command(h, 'fork').ui.kind, 'action')
  assert.equal(command(h, 'trace').ui.kind, 'action')
})

// ---------------------------------------------------------------------------
// Pane-aware handoff (ticket 05, extending ticket 03's commands)
// ---------------------------------------------------------------------------

/** A stand-in for the pane host face the commands call. */
function fakePanes({
  active = true,
  focused = { paneId: 'p2', sessionId: 's1' },
  paneIndexOf,
  canTrace = true,
  trace = true,
  openResult = Promise.resolve(true),
} = {}) {
  const calls = { replaced: [], newConversation: [], openedInNewPane: [], focused: [], setView: [] }
  const face = {
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
      return openResult
    },
  }
  if (trace) {
    face.canTrace = () => canTrace
    face.setView = (paneId, view) => {
      calls.setView.push([paneId, view])
      return true
    }
  }
  return face
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

test('/new puts a new conversation in the focused pane instead of closing the split view', () => {
  const panes = fakePanes()
  const h = harness({ panes })
  command(h, 'new').ui.run({ sessionId: 's1' })

  assert.deepEqual(panes.calls.newConversation, ['w1'])
  assert.deepEqual(h.calls.started, [])
})

test('/new still uses the native path when the pane workspace is not showing', () => {
  const panes = fakePanes({ active: false })
  const h = harness({ panes })
  command(h, 'new').ui.run({ sessionId: 's1' })

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

test('Mod+N while a modal is open does not start a conversation or reach the native handler', () => {
  const previous = globalThis.document
  globalThis.document = {
    querySelector(selector) {
      return selector === '[role="dialog"][aria-modal="true"]' ? {} : null
    },
  }
  try {
    const target = fakeEventTarget()
    const panes = fakePanes()
    const binding = createNewConversationBinding(target, panes)
    let native = 0
    target.addEventListener('keydown', () => {
      native += 1
    })
    const event = {
      key: 'n',
      ctrlKey: true,
      prevented: false,
      preventDefault() {
        this.prevented = true
      },
      stopPropagation() {},
    }
    target.dispatch('keydown', event)

    assert.equal(native, 0)
    assert.equal(event.prevented, true)
    assert.deepEqual(panes.calls.newConversation, [])
    binding.dispose()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
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
  // /clear + /new + /resume + /trace + Ctrl+Enter tracker + Mod+N binding.
  assert.equal(h.disposers.length, 6)

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

test('/resume + Ctrl+Enter on an empty pane workspace opens the first pane', async () => {
  const panes = fakePanes({ active: true, focused: null })
  const h = harness({ panes, newPaneRequested: () => true })
  await command(h, 'resume').ui.onSelect({ id: 's2', sessionId: 's2', label: 'x' }, { sessionId: 's1' })

  assert.deepEqual(panes.calls.openedInNewPane, ['s2'])
  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(h.calls.opened, [])
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

// ---------------------------------------------------------------------------
// /fork and /trace (slash conversation commands)
// ---------------------------------------------------------------------------

/** @param {object} [overrides] */
function forkHarness(overrides = {}) {
  const forks = []
  const uiWorkspace = {
    forkSession(sessionId, onCreated, options) {
      forks.push({ sessionId, onCreated, options })
      return Promise.resolve('child-1')
    },
    ...overrides.uiWorkspace,
  }
  const h = harness({ panes: fakePanes(), ...overrides, uiWorkspace })
  return { ...h, forks }
}

test('/fork is absent when the shell cannot fork a session', () => {
  const h = harness({ panes: fakePanes() })
  assert.equal(command(h, 'fork'), undefined)
  assert.equal(command(h, 'new').name, 'new')
  assert.equal(command(h, 'trace').name, 'trace')
})

test('/fork copies the current session without navigating away from the native view', () => {
  const panes = fakePanes({ active: false })
  const h = forkHarness({ panes })
  command(h, 'fork').ui.run({ sessionId: 's1' })

  assert.deepEqual(h.forks, [
    { sessionId: 's1', onCreated: undefined, options: { allowMigration: false } },
  ])
  assert.deepEqual(panes.calls.openedInNewPane, [])
  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(h.calls.opened, [])
  assert.deepEqual(h.calls.started, [])
})

test('/fork opens the copy in a new pane and leaves the focused pane alone', () => {
  const panes = fakePanes()
  const h = forkHarness({ panes })
  command(h, 'fork').ui.run({ sessionId: 's1' })

  assert.equal(h.forks[0].sessionId, 's1')
  assert.deepEqual(h.forks[0].options, { allowMigration: false })
  h.forks[0].onCreated('child-9')

  assert.deepEqual(panes.calls.openedInNewPane, ['child-9'])
  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(h.calls.opened, [])
  assert.deepEqual(h.calls.started, [])
})

test('/fork keeps the copy when a new pane is refused', async () => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => {
    warnings.push(args)
  }
  try {
    const panes = fakePanes({ openResult: Promise.resolve(false) })
    const h = forkHarness({ panes })
    command(h, 'fork').ui.run({ sessionId: 's1' })
    await h.forks[0].onCreated('child-9')
    assert.deepEqual(panes.calls.openedInNewPane, ['child-9'])
    assert.deepEqual(panes.calls.replaced, [])
    assert.deepEqual(warnings, [])
  } finally {
    console.warn = original
  }
})

test('/fork is hidden for a blank conversation and shown once the conversation has content', () => {
  const h = forkHarness({
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: {
            blank: { id: 'blank', blank: true },
            used: { id: 'used', blank: false },
          },
        }),
      },
    },
  })
  const spec = command(h, 'fork')
  assert.equal(spec.available({ sessionId: 'blank' }), false)
  assert.equal(spec.available({ sessionId: 'used' }), true)
  assert.equal(spec.available({ sessionId: 'missing' }), true)
})

test('/fork stays quiet when the host rejects the fork', async () => {
  const cases = [
    Object.assign(new Error('no completed turn'), {
      name: 'SessionForkError',
      rpcError: { code: 'session/fork-unavailable' },
    }),
    Object.assign(new Error('migrate first'), {
      name: 'SessionForkError',
      rpcError: { code: 'session/migration-required' },
    }),
    new Error('fork child rename failed'),
  ]
  const unhandled = []
  const onUnhandled = (error) => {
    unhandled.push(error)
  }
  process.on('unhandledRejection', onUnhandled)
  const original = console.warn
  try {
    for (const error of cases) {
      const warnings = []
      console.warn = (...args) => {
        warnings.push(args)
      }
      const panes = fakePanes()
      const h = forkHarness({
        panes,
        uiWorkspace: {
          forkSession() {
            return Promise.reject(error)
          },
        },
      })
      command(h, 'fork').ui.run({ sessionId: 's1' })
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(panes.calls.openedInNewPane, [], error.message)
      assert.equal(warnings.length, 1, error.message)
      const text = warnings[0].map((part) => String(part)).join(' ')
      if (error.rpcError !== undefined) assert.match(text, new RegExp(error.rpcError.code))
    }

    const warnings = []
    console.warn = (...args) => {
      warnings.push(args)
    }
    const panes = fakePanes()
    const h = forkHarness({
      panes,
      uiWorkspace: {
        forkSession() {
          throw new Error('sync boom')
        },
      },
    })
    assert.doesNotThrow(() => command(h, 'fork').ui.run({ sessionId: 's1' }))
    assert.equal(warnings.length, 1)
    assert.deepEqual(panes.calls.openedInNewPane, [])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    console.warn = original
    process.off('unhandledRejection', onUnhandled)
  }
})

test('/trace switches the focused pane to the trajectory view and does not change the session', () => {
  const panes = fakePanes()
  const h = harness({ panes })
  const spec = command(h, 'trace')
  assert.equal(spec.ui.kind, 'action')
  assert.equal(spec.available({ sessionId: 's1' }), true)
  spec.ui.run({ sessionId: 's1' })
  spec.ui.run({ sessionId: 's1' })

  assert.deepEqual(panes.calls.setView, [
    ['p2', 'trajectory'],
    ['p2', 'trajectory'],
  ])
  assert.deepEqual(panes.calls.replaced, [])
  assert.deepEqual(panes.calls.newConversation, [])
  assert.deepEqual(h.calls.opened, [])
  assert.deepEqual(h.calls.started, [])
})

test('/trace is offered only for a focused pane in the split while trajectory is available', () => {
  assert.equal(command(harness({ panes: fakePanes({ canTrace: false }) }), 'trace').available(), false)
  assert.equal(
    command(harness({ panes: fakePanes({ focused: null }) }), 'trace').available(),
    false,
  )
  assert.equal(
    command(harness({ panes: fakePanes({ active: false }) }), 'trace').available(),
    false,
  )
})

test('/trace ends quietly when the view switch is refused', () => {
  const panes = fakePanes()
  panes.setView = () => false
  const h = harness({ panes })
  assert.doesNotThrow(() => command(h, 'trace').ui.run({ sessionId: 's1' }))
  assert.deepEqual(h.calls.opened, [])
})

test('/trace is absent when the pane host cannot switch views', () => {
  const h = harness({
    panes: fakePanes({ trace: false }),
    uiWorkspace: { forkSession: () => Promise.resolve('child') },
  })
  assert.equal(command(h, 'trace'), undefined)
  assert.equal(command(h, 'fork').name, 'fork')
  assert.equal(command(h, 'new').name, 'new')
})

test('/new, /fork and /trace show localized menu copy', () => {
  for (const table of [zh, en]) {
    const h = harness({
      t: (key) => table[key] ?? key,
      panes: fakePanes(),
      uiWorkspace: { forkSession: () => Promise.resolve('child') },
    })
    for (const name of ['new', 'fork', 'trace']) {
      const spec = command(h, name)
      assert.equal(spec.label().startsWith('command.'), false, name)
      assert.equal(spec.description().startsWith('command.'), false, name)
      assert.notEqual(spec.label(), spec.description())
    }
  }
  assert.equal(zh['command.new.label'], '新会话')
  assert.equal(en['command.new.label'], 'New conversation')
  assert.match(zh['command.new.description'], /与 \/clear 当前等价/)
  assert.match(en['command.new.description'], /\/clear/)
  assert.match(zh['command.clear.description'], /与 \/new 当前等价/)
  assert.match(en['command.clear.description'], /\/new/)
  assert.equal(zh['command.fork.label'], '分叉会话')
  assert.equal(en['command.fork.label'], 'Fork conversation')
  assert.match(zh['command.fork.description'], /复制当前会话为可恢复副本，原会话不受影响/)
  assert.match(en['command.fork.description'], /original is unaffected/)
  assert.match(zh['command.fork.description'], /已完成回合/)
  assert.match(en['command.fork.description'], /last completed turn/)
  assert.equal(zh['command.trace.label'], '轨迹视图')
  assert.equal(en['command.trace.label'], 'Trajectory view')
  assert.equal(zh['command.trace.description'], '把当前窗格切换到轨迹视图')
  assert.equal(en['command.trace.description'], 'Switch the current pane to the trajectory view')
})

test('releasing the registrations drops /clear, /new, /resume, /fork and /trace', () => {
  const h = harness({
    panes: fakePanes(),
    uiWorkspace: { forkSession: () => Promise.resolve('child') },
  })
  assert.deepEqual(
    h.commandUi.registered.map((spec) => spec.name),
    ['clear', 'new', 'resume', 'fork', 'trace'],
  )
  for (const dispose of h.disposers) dispose()
  assert.deepEqual(h.commandUi.registered, [])
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
      let stopped = false
      const stopNow = event.stopImmediatePropagation
      event.stopImmediatePropagation = () => {
        stopped = true
        stopNow?.()
      }
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event)
        if (stopped) break
      }
    },
  }
}
