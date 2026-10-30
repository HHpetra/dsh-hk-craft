'use strict'

/**
 * Pane keyboard bindings (ticket 10).
 *
 * The table is the single source of truth for both the document listener and
 * the tooltips, so a hint can never advertise a chord the listener does not
 * accept. The chords were checked against dsh's shortcut catalog (see the
 * ticket's Comments); this module only owns their pure interpretation.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FOCUS_LIMIT,
  PANE_SHORTCUTS,
  paneShortcutAction,
  paneShortcutHint,
  shortcutLabel,
  focusShortcutLabel,
  tabShortcutIndex,
  withShortcut,
} = require('./pane-shortcuts.js')

test('Ctrl+1..4 focus the Nth pane; every other combination is ignored', () => {
  assert.deepEqual(paneShortcutAction({ key: '1', ctrlKey: true }), { kind: 'focus', index: 1 })
  assert.deepEqual(paneShortcutAction({ key: '4', ctrlKey: true }), { kind: 'focus', index: 4 })
  assert.deepEqual(paneShortcutAction({ key: '2', metaKey: true }), { kind: 'focus', index: 2 })
  // Layout-independent fallback: the physical code works when `key` is absent.
  assert.deepEqual(paneShortcutAction({ code: 'Digit3', ctrlKey: true }), { kind: 'focus', index: 3 })

  assert.equal(tabShortcutIndex({ key: '5', ctrlKey: true }), null)
  assert.equal(tabShortcutIndex({ key: '0', ctrlKey: true }), null)
  assert.equal(paneShortcutAction({ key: '1' }), null)
  assert.equal(paneShortcutAction({ key: '1', ctrlKey: true, shiftKey: true }), null)
  assert.equal(paneShortcutAction({ key: '1', ctrlKey: true, altKey: true }), null)
  assert.equal(paneShortcutAction({ key: 'a', ctrlKey: true }), null)
  assert.equal(paneShortcutAction({ key: '1', ctrlKey: true, defaultPrevented: true }), null)
  assert.equal(paneShortcutAction({ key: '1', ctrlKey: true, repeat: true }), null)
  assert.equal(paneShortcutAction(null), null)
  assert.equal(FOCUS_LIMIT, 4)
})

test('every declared action binding resolves to its own action', () => {
  assert.equal(PANE_SHORTCUTS.length, 4)
  for (const shortcut of PANE_SHORTCUTS) {
    // The hint text and the accepted combination are the same record.
    assert.equal(shortcut.label, shortcutLabel(shortcut.id))
    assert.deepEqual(
      paneShortcutAction({ code: shortcut.code, ctrlKey: true, shiftKey: true }),
      shortcut.action,
      `${shortcut.id} must be accepted exactly as its hint advertises`,
    )
  }

  assert.deepEqual(paneShortcutAction({ code: 'KeyE', ctrlKey: true, shiftKey: true }), {
    kind: 'split',
    dir: 'row',
  })
  assert.deepEqual(paneShortcutAction({ code: 'KeyD', ctrlKey: true, shiftKey: true }), {
    kind: 'split',
    dir: 'col',
  })
  assert.deepEqual(paneShortcutAction({ code: 'KeyX', ctrlKey: true, shiftKey: true }), {
    kind: 'close',
  })
  assert.deepEqual(paneShortcutAction({ code: 'KeyN', ctrlKey: true, shiftKey: true }), {
    kind: 'new',
  })
})

test('a missing physical code falls back to the shifted letter key', () => {
  assert.deepEqual(paneShortcutAction({ key: 'E', ctrlKey: true, shiftKey: true }), {
    kind: 'split',
    dir: 'row',
  })
  assert.deepEqual(paneShortcutAction({ key: 'n', ctrlKey: true, shiftKey: true }), { kind: 'new' })
  // `code` wins when present: a different physical key is not the binding.
  assert.equal(paneShortcutAction({ code: 'KeyQ', key: 'e', ctrlKey: true, shiftKey: true }), null)
})

test('action bindings require exactly primary+shift', () => {
  assert.equal(paneShortcutAction({ code: 'KeyE', ctrlKey: true }), null)
  assert.equal(paneShortcutAction({ code: 'KeyE', ctrlKey: true, shiftKey: true, altKey: true }), null)
  assert.equal(paneShortcutAction({ code: 'KeyE', shiftKey: true }), null)
  assert.equal(paneShortcutAction({ code: 'KeyE', ctrlKey: true, shiftKey: true, repeat: true }), null)
  assert.equal(
    paneShortcutAction({ code: 'KeyE', ctrlKey: true, shiftKey: true, defaultPrevented: true }),
    null,
  )
})

test('the shortcut table is exactly the documented set', () => {
  assert.deepEqual(
    PANE_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.label]),
    [
      ['split-right', 'Ctrl+Shift+E'],
      ['split-down', 'Ctrl+Shift+D'],
      ['close-pane', 'Ctrl+Shift+X'],
      ['new-conversation', 'Ctrl+Shift+N'],
    ],
  )
  assert.equal(focusShortcutLabel(1), 'Ctrl+1')
  assert.equal(focusShortcutLabel(4), 'Ctrl+4')
  assert.equal(shortcutLabel('missing'), '')
  assert.equal(withShortcut('Split right', 'Ctrl+Shift+E'), 'Split right (Ctrl+Shift+E)')
  assert.equal(withShortcut('Split right', ''), 'Split right')
})

test('the hint text is built from the same labels the listener accepts', () => {
  const hint = paneShortcutHint((key) => key)

  for (const shortcut of PANE_SHORTCUTS) {
    assert.ok(hint.includes(shortcut.label), `hint must mention ${shortcut.label}`)
  }
  assert.ok(hint.includes('Ctrl+1–Ctrl+4'))
  assert.ok(hint.includes('pane.shortcuts.focus'))
  assert.ok(hint.includes('pane.splitRight'))
  assert.ok(hint.includes('pane.close'))
  assert.ok(hint.includes('tab.new'))
})
