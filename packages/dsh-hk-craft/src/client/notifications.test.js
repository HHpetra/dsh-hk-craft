'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { interpolate } = require('./react-and-translator.js')
const { zh } = require('./locale.js')
const {
  STORAGE_KEY,
  NOTIFICATION_TYPES,
  DEFAULT_SETTINGS,
  normalizeSettings,
  readSettings,
  writeSettings,
  interactionType,
  diffSessionStatus,
  shouldNotify,
  errorExcerpt,
  notificationContent,
  notificationTag,
  createNotifier,
} = require('./notifications.js')

/** Read the locale table the way the plugin's bound `t` does. */
const t = (key, params) => interpolate(zh[key] ?? key, params)

/** A Storage stand-in that only keeps one key. */
function memoryStorage(initial) {
  const values = new Map()
  if (initial !== undefined) values.set(STORAGE_KEY, initial)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  }
}

/** A `sessionStatus` store with a controllable snapshot. */
function statusStore(initial = {}) {
  let snapshot = new Map(Object.entries(initial))
  const listeners = new Set()
  return {
    store: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next) {
      snapshot = new Map(Object.entries(next))
      for (const listener of [...listeners]) listener()
    },
    listeners,
  }
}

/** The Notification stand-in; instances are inspected by the tests. */
class FakeNotification {
  static permission = 'granted'
  static instances = []
  static requestCalls = 0

  constructor(title, options) {
    this.title = title
    this.options = options
    this.closed = false
    FakeNotification.instances.push(this)
  }

  close() {
    this.closed = true
    this.onclose?.()
  }

  static reset() {
    FakeNotification.permission = 'granted'
    FakeNotification.instances = []
    FakeNotification.requestCalls = 0
  }

  static requestPermission() {
    FakeNotification.requestCalls += 1
    return Promise.resolve(FakeNotification.permission)
  }
}

/**
 * One fake service bag: uiSession status, session rows, workspaces, remote
 * errors and uiWorkspace. `controller` defaults to the native (inactive) view.
 */
function fakeEnv(options = {}) {
  const status = statusStore(options.status ?? {})
  const byId = options.byId ?? {}
  const workspaces = options.workspaces ?? []
  const revealed = []
  const focused = []
  const errorHandlers = new Set()
  const services = {
    uiSession: { sessionStatus: status.store },
    sessions: { list: { getSnapshot: () => ({ byId }) } },
    workspaces: { list: { getSnapshot: () => ({ items: workspaces }) } },
    remote: {
      $on(event, handler) {
        if (event !== 'api-session/error') throw new Error(`unexpected event ${event}`)
        errorHandlers.add(handler)
        return () => errorHandlers.delete(handler)
      },
    },
    uiWorkspace: {
      openSession(sessionId) {
        revealed.push(sessionId)
      },
    },
  }
  const controller = options.controller ?? {
    getSnapshot: () => ({ active: false }),
    openInNewPane() {
      throw new Error('not in pane mode')
    },
  }
  return {
    status,
    byId,
    workspaces,
    revealed,
    focused,
    errorHandlers,
    controller,
    ctx: {
      get(name) {
        return services[name]
      },
    },
    emitError(sessionId, message) {
      for (const handler of [...errorHandlers]) handler(sessionId, message)
    },
  }
}

/** A mutable `document` stand-in so a test can blur/focus dsh between events. */
function focusedDocument(focused = true) {
  return {
    focused,
    visibilityState: 'visible',
    hasFocus() {
      return this.focused
    },
  }
}

function createTestNotifier(env, options = {}) {
  const notifier = createNotifier({
    ctx: env.ctx,
    controller: env.controller,
    t,
    storage: options.storage ?? memoryStorage(),
    NotificationImpl: FakeNotification,
    documentRef: options.documentRef ?? { hasFocus: () => false, visibilityState: 'visible' },
    windowRef: {
      focus() {
        env.focused.push('window')
      },
    },
  })
  return { notifier, stop: notifier.start() }
}

test('settings default to all five types, enabled, with sound and no foreground gate', () => {
  assert.deepEqual(normalizeSettings(undefined), {
    enabled: true,
    sound: true,
    suppressWhenVisible: false,
    types: {
      approval: true,
      question: true,
      'plan-review': true,
      completed: true,
      failed: true,
    },
  })
  assert.deepEqual(DEFAULT_SETTINGS.types, normalizeSettings(undefined).types)
  assert.deepEqual(NOTIFICATION_TYPES, ['approval', 'question', 'plan-review', 'completed', 'failed'])
})

test('settings merge partial values and drop unknown type keys', () => {
  const settings = normalizeSettings({
    enabled: false,
    sound: false,
    suppressWhenVisible: true,
    types: { completed: false, nope: true },
  })
  assert.equal(settings.enabled, false)
  assert.equal(settings.sound, false)
  assert.equal(settings.suppressWhenVisible, true)
  assert.equal(settings.types.completed, false)
  assert.equal(settings.types.approval, true)
  assert.equal(settings.types.nope, undefined)
})

test('readSettings falls back to defaults for missing, empty or corrupt storage', () => {
  assert.deepEqual(readSettings(undefined), normalizeSettings(undefined))
  assert.deepEqual(readSettings(memoryStorage()), normalizeSettings(undefined))
  assert.deepEqual(readSettings(memoryStorage('')), normalizeSettings(undefined))
  assert.deepEqual(readSettings(memoryStorage('{not json')), normalizeSettings(undefined))
})

test('writeSettings serializes and readSettings round-trips', () => {
  const storage = memoryStorage()
  assert.equal(writeSettings(storage, { enabled: false, sound: false, types: { failed: false } }), true)
  const restored = readSettings(storage)
  assert.equal(restored.enabled, false)
  assert.equal(restored.sound, false)
  assert.equal(restored.types.failed, false)
  assert.equal(restored.types.approval, true)
})

test('interactionType recognizes the three dsh pending kinds and ignores others', () => {
  assert.equal(interactionType({ kind: 'approval' }), 'approval')
  assert.equal(interactionType({ kind: 'question' }), 'question')
  assert.equal(interactionType({ kind: 'plan-review' }), 'plan-review')
  assert.equal(interactionType({ kind: 'future-kind' }), null)
  assert.equal(interactionType(undefined), null)
})

test('diffSessionStatus sees a new pending key and a running-to-idle transition', () => {
  const previous = {
    s1: { running: true, pendingInteraction: null },
    s2: { running: true, pendingInteraction: { key: 'old', kind: 'approval' } },
  }
  const next = {
    s1: { running: false, pendingInteraction: { key: 'q1', kind: 'question' } },
    s2: { running: true, pendingInteraction: { key: 'new', kind: 'plan-review' } },
  }
  const events = diffSessionStatus(previous, next)
  assert.deepEqual(events, [
    { kind: 'pending', sessionId: 's1', interaction: { key: 'q1', kind: 'question' } },
    { kind: 'completed', sessionId: 's1' },
    { kind: 'pending', sessionId: 's2', interaction: { key: 'new', kind: 'plan-review' } },
  ])
})

test('diffSessionStatus does not replay a seed or repeat an unchanged pending interaction', () => {
  const seed = { s1: { running: false }, s2: { running: true, pendingInteraction: { key: 'a', kind: 'approval' } } }
  assert.deepEqual(diffSessionStatus(seed, seed), [])
  assert.deepEqual(diffSessionStatus(seed, { ...seed }), [])
})

test('shouldNotify honors the master switch, per-type switch and subagent exclusion', () => {
  const settings = normalizeSettings(undefined)
  assert.equal(shouldNotify('completed', settings, {}), true)
  assert.equal(shouldNotify('completed', { ...settings, enabled: false }, {}), false)
  assert.equal(
    shouldNotify('completed', { ...settings, types: { ...settings.types, completed: false } }, {}),
    false,
  )
  assert.equal(shouldNotify('completed', settings, { origin: 'subagent' }), false)
  assert.equal(shouldNotify('failed', settings, { origin: 'subagent' }), false)
})

test('the foreground gate only suppresses a focused, visible conversation when enabled', () => {
  const settings = normalizeSettings(undefined)
  const gated = { ...settings, suppressWhenVisible: true }
  assert.equal(shouldNotify('completed', gated, {}, { dshFocused: true, visible: true }), false)
  assert.equal(shouldNotify('completed', gated, {}, { dshFocused: true, visible: false }), true)
  assert.equal(shouldNotify('completed', gated, {}, { dshFocused: false, visible: true }), true)
  assert.equal(shouldNotify('completed', settings, {}, { dshFocused: true, visible: true }), true)
})

test('errorExcerpt collapses whitespace and truncates long errors', () => {
  assert.equal(errorExcerpt('  model   failed\nretry  '), 'model failed retry')
  assert.equal(errorExcerpt(''), '')
  const long = 'x'.repeat(500)
  const excerpt = errorExcerpt(long)
  assert.equal(excerpt.length, 180)
  assert.equal(excerpt.endsWith('…'), true)
})

test('notificationContent has distinct copy and includes workspace/session/tool/error', () => {
  const meta = { sessionTitle: '修一下登录', workspaceName: 'dsh-hk-craft' }
  const approval = notificationContent('approval', meta, { toolName: 'Bash' }, t)
  assert.equal(approval.title, '需要授权')
  assert.match(approval.body, /dsh-hk-craft · 修一下登录 · 工具 Bash 请求执行/)

  const question = notificationContent('question', meta, {}, t)
  assert.equal(question.title, '需要回答')
  assert.match(question.body, /Agent 正在等待你的回答/)

  const review = notificationContent('plan-review', meta, {}, t)
  assert.equal(review.title, '计划待审阅')
  assert.match(review.body, /等待你确认/)

  const completed = notificationContent('completed', meta, {}, t)
  assert.equal(completed.title, '本轮完成')
  assert.match(completed.body, /回答已生成/)

  const failed = notificationContent('failed', meta, { error: 'quota exceeded' }, t)
  assert.equal(failed.title, '本轮失败')
  assert.match(failed.body, /quota exceeded/)

  const noWorkspace = notificationContent('completed', { sessionTitle: 'S' }, {}, t)
  assert.equal(noWorkspace.body, 'S · 回答已生成')
})

test('notificationTag stays inside the Windows toast budget for a real session id', () => {
  const sessionId = 'session-d571a708-eefe-480d-a178-766ad2cdc01a'
  const tags = NOTIFICATION_TYPES.map((type) => notificationTag(type, sessionId))
  for (const tag of tags) {
    assert.match(tag, /^[A-Za-z0-9]{20}$/)
    // Chromium prefixes `n#dsh-app://app#` (16) before Windows' 64-character cap.
    assert.ok(`n#dsh-app://app#${tag}`.length <= 64)
  }
  assert.equal(new Set(tags).size, NOTIFICATION_TYPES.length)
  assert.equal(notificationTag('completed', sessionId), tags[NOTIFICATION_TYPES.indexOf('completed')])
  assert.notEqual(notificationTag('completed', sessionId), notificationTag('completed', `${sessionId}x`))
})

test('a completion transition raises one toast and repeated snapshots do not repeat it', () => {
  FakeNotification.reset()
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: '修一下登录' } },
    workspaces: [{ workspaceId: 'w1', title: 'dsh-hk-craft', sessionIds: ['s1'] }],
  })
  const { notifier } = createTestNotifier(env)
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
  const toast = FakeNotification.instances[0]
  assert.equal(toast.title, '本轮完成')
  assert.equal(toast.options.body, 'dsh-hk-craft · 修一下登录 · 回答已生成')
  assert.equal(toast.options.tag, notificationTag('completed', 's1'))
  assert.equal(toast.options.requireInteraction, false)

  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
  notifier.dispose()
})

test('seed status does not fire a toast', () => {
  FakeNotification.reset()
  const env = fakeEnv({ status: { s1: { running: false } } })
  createTestNotifier(env)
  assert.equal(FakeNotification.instances.length, 0)
})

test('the foreground gate suppresses the native conversation that is on screen', () => {
  FakeNotification.reset()
  const documentRef = focusedDocument(true)
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S', retainedBy: { mainView: 1 } } },
  })
  const { notifier } = createTestNotifier(env, { documentRef })
  notifier.setSettings({ suppressWhenVisible: true })

  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 0)

  // Once dsh is no longer focused, the same conversation does notify.
  documentRef.focused = false
  env.status.set({ s1: { running: true } })
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
  notifier.dispose()
})

test('the foreground gate treats every pane of the visible workspace as on screen', () => {
  FakeNotification.reset()
  const documentRef = focusedDocument(true)
  const visible = new Set(['s1'])
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S' } },
    controller: {
      getSnapshot: () => ({ active: true }),
      paneIndexOf: (sessionId) => (visible.has(sessionId) ? 1 : null),
    },
  })
  const { notifier } = createTestNotifier(env, { documentRef })
  notifier.setSettings({ suppressWhenVisible: true })

  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 0)

  documentRef.focused = false
  env.status.set({ s1: { running: true } })
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
  notifier.dispose()
})

test('the foreground gate still notifies for a conversation in another workspace', () => {
  FakeNotification.reset()
  const documentRef = focusedDocument(true)
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S' } },
    controller: {
      getSnapshot: () => ({ active: true }),
      paneIndexOf: () => null,
    },
  })
  const { notifier } = createTestNotifier(env, { documentRef })
  notifier.setSettings({ suppressWhenVisible: true })
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
  notifier.dispose()
})

test('the foreground gate is off unless the setting is enabled', () => {
  FakeNotification.reset()
  const documentRef = focusedDocument(true)
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S', retainedBy: { mainView: 1 } } },
  })
  createTestNotifier(env, { documentRef })
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
})

test('each pending kind has its own toast and the interaction key dedupes it', () => {
  FakeNotification.reset()
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S' } },
  })
  const { notifier } = createTestNotifier(env)
  const approval = { key: 'a1', kind: 'approval', toolName: 'Bash' }
  env.status.set({ s1: { running: true, pendingInteraction: approval } })
  assert.equal(FakeNotification.instances.length, 1)
  assert.equal(FakeNotification.instances[0].title, '需要授权')
  assert.match(FakeNotification.instances[0].options.body, /工具 Bash/)
  assert.equal(FakeNotification.instances[0].options.requireInteraction, true)

  env.status.set({ s1: { running: true, pendingInteraction: approval } })
  assert.equal(FakeNotification.instances.length, 1)

  const question = { key: 'q1', kind: 'question' }
  env.status.set({ s1: { running: true, pendingInteraction: question } })
  assert.equal(FakeNotification.instances.length, 2)
  assert.equal(FakeNotification.instances[1].title, '需要回答')
  assert.equal(FakeNotification.instances[0].closed, true)

  const review = { key: 'p1', kind: 'plan-review' }
  env.status.set({ s1: { running: true, pendingInteraction: review } })
  assert.equal(FakeNotification.instances.length, 3)
  assert.equal(FakeNotification.instances[2].title, '计划待审阅')
  assert.equal(FakeNotification.instances[1].closed, true)
  notifier.dispose()
})

test('a failure toast wins over the completion that follows it', () => {
  FakeNotification.reset()
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S' } },
  })
  const { notifier } = createTestNotifier(env)
  env.emitError('s1', 'provider exploded')
  assert.equal(FakeNotification.instances.length, 1)
  assert.equal(FakeNotification.instances[0].title, '本轮失败')
  assert.match(FakeNotification.instances[0].options.body, /provider exploded/)

  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 1)
  notifier.dispose()
})

test('the master switch and per-type switches suppress notifications', () => {
  FakeNotification.reset()
  const env = fakeEnv({ status: { s1: { running: true } }, byId: { s1: { title: 'S' } } })
  const { notifier } = createTestNotifier(env)
  notifier.setSettings({ types: { completed: false } })
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 0)

  notifier.setSettings({ types: { completed: true }, enabled: false })
  env.status.set({ s1: { running: true } })
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 0)
  notifier.dispose()
})

test('subagent sessions are filtered out', () => {
  FakeNotification.reset()
  const env = fakeEnv({
    status: { child: { running: true } },
    byId: { child: { title: '子代理', origin: 'subagent' } },
  })
  createTestNotifier(env)
  env.status.set({ child: { running: false } })
  assert.equal(FakeNotification.instances.length, 0)
})

test('clicking a toast focuses dsh and reveals the session in native mode', () => {
  FakeNotification.reset()
  const env = fakeEnv({ status: { s1: { running: true } }, byId: { s1: { title: 'S' } } })
  createTestNotifier(env)
  env.status.set({ s1: { running: false } })
  const toast = FakeNotification.instances[0]
  toast.onclick()
  assert.deepEqual(env.focused, ['window'])
  assert.deepEqual(env.revealed, ['s1'])
})

test('clicking a toast in pane mode opens the session in a pane', () => {
  FakeNotification.reset()
  const opened = []
  const env = fakeEnv({
    status: { s1: { running: true } },
    byId: { s1: { title: 'S' } },
    controller: {
      getSnapshot: () => ({ active: true }),
      openInNewPane(sessionId) {
        opened.push(sessionId)
        return Promise.resolve(true)
      },
    },
  })
  createTestNotifier(env)
  env.status.set({ s1: { running: false } })
  FakeNotification.instances[0].onclick()
  assert.deepEqual(opened, ['s1'])
  assert.deepEqual(env.revealed, [])
})

test('a denied permission suppresses toasts and sendTest reports it', async () => {
  FakeNotification.reset()
  FakeNotification.permission = 'denied'
  const env = fakeEnv({ status: { s1: { running: true } }, byId: { s1: { title: 'S' } } })
  const { notifier } = createTestNotifier(env)
  env.status.set({ s1: { running: false } })
  assert.equal(FakeNotification.instances.length, 0)
  assert.deepEqual(await notifier.sendTest(), { ok: false, reason: 'permission' })
  notifier.dispose()
})

test('sendTest requests permission when it is still undecided and then shows a toast', async () => {
  FakeNotification.reset()
  FakeNotification.permission = 'default'
  const env = fakeEnv()
  const { notifier } = createTestNotifier(env)
  // requestPermission flips the fake to granted, as a browser prompt would.
  FakeNotification.requestPermission = () => {
    FakeNotification.requestCalls += 1
    FakeNotification.permission = 'granted'
    return Promise.resolve('granted')
  }
  assert.deepEqual(await notifier.sendTest(), { ok: true })
  assert.equal(FakeNotification.requestCalls, 1)
  assert.equal(FakeNotification.instances[0].title, '通知测试')
  notifier.dispose()
})

test('the snapshot is stable until settings change', () => {
  FakeNotification.reset()
  const env = fakeEnv()
  const { notifier } = createTestNotifier(env)
  const first = notifier.getSnapshot()
  assert.equal(notifier.getSnapshot(), first)
  const second = notifier.setSettings({ sound: false })
  assert.equal(notifier.getSnapshot(), second)
  assert.notEqual(second, first)
  assert.equal(second.settings.sound, false)
  notifier.dispose()
})

test('a missing Notification constructor degrades to unsupported', async () => {
  const env = fakeEnv()
  const notifier = createNotifier({
    ctx: env.ctx,
    controller: env.controller,
    t,
    storage: memoryStorage(),
    NotificationImpl: undefined,
  })
  assert.equal(notifier.getSnapshot().supported, false)
  assert.equal(notifier.getSnapshot().permission, 'unsupported')
  assert.deepEqual(await notifier.sendTest(), { ok: false, reason: 'unsupported' })
  notifier.dispose()
})