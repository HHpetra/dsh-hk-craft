'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { withFakeReact } = require('./fake-react.js')

const {
  ENTRY_NAME,
  NOTIFICATION_TYPE_LABEL,
  createSettingsSection,
  diagnosticsRows,
  notifyFailureText,
  paneModeKey,
  parseMaxPanesDraft,
  permissionKey,
  saveMaxPanes,
} = require('./settings-view.js')
const { zh } = require('./locale.js')
const { NOTIFICATION_TYPES } = require('./notifications.js')

/** Read the locale table the way a slot `t` does, so assertions carry real copy. */
const t = (key) => zh[key] ?? key

/**
 * A React stand-in for the settings render: only the calls the component makes.
 * `settings-view.js` resolves `react` lazily, so the shared installer routes it to
 * this instance.
 */
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children },
  }),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** @returns {string} every text node under an element tree, joined by spaces */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}

/** @returns {object|undefined} the first button whose visible text contains `label` */
function buttonWithText(node, label) {
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = buttonWithText(child, label)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node === 'string' || typeof node === 'number') return undefined
  if (node.type === 'button' && textOf(node).includes(label)) return node
  return buttonWithText(node.props?.children, label)
}

/** @returns {object|undefined} the first element whose props satisfy `predicate` */
function elementWhere(node, predicate) {
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = elementWhere(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node === 'string' || typeof node === 'number') return undefined
  if (predicate(node)) return node
  return elementWhere(node.props?.children, predicate)
}

/**
 * The controller face the settings page consumes: a snapshot, a subscription
 * and the pane-limit action.
 *
 * @param {{active?: boolean, probe?: object, maxPanes?: number}} [options]
 */
function fakeController(options = {}) {
  const calls = { refreshProbe: 0, setMaxPanes: [] }
  let snapshot = {
    active: options.active === true,
    probe: options.probe ?? { ok: true, status: 'present' },
    maxPanes: options.maxPanes ?? 4,
    error: null,
  }
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refreshProbe() {
      calls.refreshProbe += 1
    },
    budget: {
      setMaxPanes(value) {
        calls.setMaxPanes.push(value)
        snapshot = { ...snapshot, maxPanes: value }
        return value
      },
    },
  }
}

test('the diagnostics report the loaded client, the entry, the probe and the view', () => {
  const rows = diagnosticsRows({ active: false, probe: { ok: true, status: 'present' } }, t)

  assert.deepEqual(
    rows.map((row) => row.label),
    [
      zh['settings.diag.loaded'],
      zh['settings.diag.entry'],
      zh['settings.diag.content'],
      zh['settings.diag.view'],
    ],
  )
  assert.deepEqual(
    rows.map((row) => row.value),
    ['✓', ENTRY_NAME, zh['settings.diag.status.present'], zh['settings.view.native']],
  )
})

test('a failed probe keeps its message next to the localized status', () => {
  const message = 'factory "conversation.content" is not registered'
  const rows = diagnosticsRows({ active: true, probe: { ok: false, status: 'missing', message } }, t)
  const content = rows.find((row) => row.key === 'content')

  assert.equal(content.value, `${zh['settings.diag.status.missing']} — ${message}`)
})

test('a snapshot without a probe reads as an unknown probe, not as missing copy', () => {
  const rows = diagnosticsRows({ active: false }, t)
  const content = rows.find((row) => row.key === 'content')

  assert.equal(content.value, zh['settings.diag.status.unknown'])
})

test('the pane mode key follows the controller snapshot', () => {
  assert.equal(paneModeKey({ active: true }), 'settings.view.split')
  assert.equal(paneModeKey({ active: false }), 'settings.view.native')
  assert.equal(paneModeKey(undefined), 'settings.view.native')
})

test('the settings page renders diagnostics and the pane limit, without a way back to the native view', () => {
  withFakeReact(fakeReact, () => {
    const Section = createSettingsSection(fakeController({ active: true }))
    const view = Section({ t })
    const text = textOf(view)

    assert.match(text, /HK Craft/)
    assert.ok(text.includes(zh['settings.diag.title']))
    assert.ok(text.includes(zh['settings.diag.loaded']))
    assert.ok(text.includes(ENTRY_NAME))
    assert.ok(text.includes(zh['settings.diag.status.present']))
    assert.ok(text.includes(zh['settings.view.split']))
    assert.ok(text.includes(zh['settings.split.title']))
    assert.equal(text.includes('回到原生视图'), false)
    assert.equal(text.includes('进入分屏窗格'), false)
    assert.notEqual(buttonWithText(view, zh['settings.split.save']), undefined)
  })
})

test('the pane limit field accepts 0 (unlimited) and positive whole numbers only', () => {
  assert.equal(parseMaxPanesDraft('0'), 0)
  assert.equal(parseMaxPanesDraft(' 4 '), 4)
  assert.equal(parseMaxPanesDraft(6), 6)
  for (const draft of ['', '  ', '-1', '2.5', 'four', null, undefined, {}]) {
    assert.equal(parseMaxPanesDraft(draft), null, `draft ${String(draft)}`)
  }
})

test('saving the pane limit reports invalid input and controller failures without rejecting', () => {
  const controller = fakeController()

  assert.deepEqual(saveMaxPanes(controller, 'abc'), { ok: false, reason: 'invalid' })
  assert.deepEqual(controller.calls.setMaxPanes, [])

  assert.deepEqual(saveMaxPanes(controller, '2'), { ok: true, value: 2 })
  assert.deepEqual(controller.calls.setMaxPanes, [2])
  assert.equal(controller.getSnapshot().maxPanes, 2)

  assert.deepEqual(saveMaxPanes({}, '2'), { ok: false, reason: 'unsupported' })

  const exploding = {
    budget: {
      setMaxPanes() {
        throw new Error('store exploded')
      },
    },
  }
  assert.deepEqual(saveMaxPanes(exploding, '2'), {
    ok: false,
    reason: 'error',
    message: 'store exploded',
  })

  let failed = { maxPanes: 4, maxPanesError: null }
  let writeError = 'quota'
  const unstored = {
    getSnapshot: () => failed,
    budget: {
      setMaxPanes(value) {
        failed = { maxPanes: value, maxPanesError: writeError }
        return value
      },
    },
  }
  assert.deepEqual(saveMaxPanes(unstored, '6'), { ok: false, reason: 'error', message: 'quota' })
  assert.equal(unstored.getSnapshot().maxPanes, 6)

  writeError = ''
  assert.deepEqual(saveMaxPanes(unstored, '8'), { ok: false, reason: 'error', message: '' })
  assert.equal(unstored.getSnapshot().maxPanes, 8)
})

test('the settings page shows the pane limit, its default and the unlimited hint', () => {
  withFakeReact(fakeReact, () => {
    const Section = createSettingsSection(fakeController({ maxPanes: 4 }))
    const view = Section({ t, close: () => {} })
    const text = textOf(view)

    assert.ok(text.includes(zh['settings.split.title']))
    assert.ok(text.includes(zh['settings.split.label']))
    assert.ok(text.includes(zh['settings.split.note']))
    assert.notEqual(buttonWithText(view, zh['settings.split.save']), undefined)

    const input = elementWhere(view, (node) => node.props?.['data-hkcraft-split-limit'] === '')
    assert.notEqual(input, undefined)
    assert.equal(input.type, 'input')
    assert.equal(input.props.type, 'number')
    assert.equal(input.props.min, 0)
    assert.equal(input.props.step, 1)
    assert.equal(input.props.value, '4')
  })
})

test('permission labels cover every state the notifier can report', () => {
  assert.equal(permissionKey('granted'), 'settings.notify.granted')
  assert.equal(permissionKey('default'), 'settings.notify.default')
  assert.equal(permissionKey('denied'), 'settings.notify.denied')
  assert.equal(permissionKey('unsupported'), 'settings.notify.unsupported')
  assert.equal(permissionKey(undefined), 'settings.notify.default')
})

test('a failed test notification explains unsupported and denied states', () => {
  assert.equal(notifyFailureText('unsupported', t), zh['settings.notify.unsupported'])
  assert.equal(notifyFailureText('permission', t), zh['settings.notify.denied'])
  assert.equal(notifyFailureText('error', t), '')
})

test('the settings page renders one switch per notification type plus the test action', () => {
  for (const type of NOTIFICATION_TYPES) {
    assert.equal(typeof NOTIFICATION_TYPE_LABEL[type], 'string', type)
    assert.notEqual(zh[NOTIFICATION_TYPE_LABEL[type]], undefined, type)
  }
  withFakeReact(fakeReact, () => {
    const notifications = fakeNotifications()
    const Section = createSettingsSection(fakeController(), { notifications })
    const view = Section({ t })
    const text = textOf(view)

    assert.ok(text.includes(zh['settings.notify.title']))
    assert.ok(text.includes(zh['settings.notify.enable']))
    assert.ok(text.includes(zh['settings.notify.permission']))
    assert.ok(text.includes(zh['settings.notify.granted']))
    assert.ok(text.includes(zh['settings.notify.sound']))
    assert.ok(text.includes(zh['settings.notify.suppressWhenVisible']))
    assert.ok(text.includes(zh['settings.notify.suppressHint']))
    assert.ok(text.includes(zh['settings.notify.note']))

    for (const type of Object.keys(NOTIFICATION_TYPE_LABEL)) {
      assert.ok(text.includes(zh[NOTIFICATION_TYPE_LABEL[type]]), type)
      const input = elementWhere(view, (node) => node.props?.['data-hkcraft-notify-type'] === type)
      assert.notEqual(input, undefined, type)
      assert.equal(input.props.type, 'checkbox')
      assert.equal(input.props.checked, true)
    }

    const master = elementWhere(view, (node) => node.props?.['data-hkcraft-notify-enable'] === '')
    assert.notEqual(master, undefined)
    assert.equal(master.props.checked, true)
    const suppress = elementWhere(view, (node) => node.props?.['data-hkcraft-notify-suppress'] === '')
    assert.notEqual(suppress, undefined)
    assert.equal(suppress.props.type, 'checkbox')
    assert.equal(suppress.props.checked, false)
    assert.notEqual(buttonWithText(view, zh['settings.notify.test']), undefined)
  })
})

test('a shell without the notification face renders no notification section', () => {
  withFakeReact(fakeReact, () => {
    const Section = createSettingsSection(fakeController())
    const text = textOf(Section({ t }))
    assert.equal(text.includes(zh['settings.notify.title']), false)
  })
})

/** The notification face the settings page consumes, without dsh or a DOM. */
function fakeNotifications() {
  const settings = {
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
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ settings, supported: true, permission: 'granted' }),
    setSettings() {},
    requestPermission: async () => 'granted',
    sendTest: async () => ({ ok: true }),
  }
}
