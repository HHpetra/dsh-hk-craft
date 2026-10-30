'use strict'

/**
 * Pane keyboard bindings (ticket 10, spec §10 S3).
 *
 * One table is the source of truth for three consumers:
 *
 * - `PaneShortcuts` in `pane-view.js` installs the document listener from
 *   `paneShortcutAction`;
 * - the pane header, the `+` button and the empty state build their tooltips
 *   and hints from `shortcutLabel` / `paneShortcutHint`, so a hint can never
 *   advertise a chord the listener does not accept;
 * - `pane-strip.js` renders the per-entry `Ctrl+N` hint through
 *   `focusShortcutLabel`.
 *
 * Chords were checked against dsh's own catalog before being chosen
 * (`dsh-client-ui-workspace`, `-ui-layout`, `-ui-sidebar-right`,
 * `-ui-settings-general`, `-ui-sidebar-browser` and the fixed input actions of
 * `-ui-conversation`). dsh owns `Mod+N`, `Mod+K`, `Mod+O`, `Mod+B`,
 * `Mod+Alt+B`, `Mod+Alt+G`, `Mod+Alt+F` / `Mod+Shift+F`, `Mod+Shift+A` /
 * `Mod+Alt+A`, `Mod+,`, `Mod+\`, `Mod+Alt+Enter`, `Mod+W`, `Mod+R`, `Mod+T`
 * plus the bare `Enter` / `Shift+Enter` / `Mod+Enter` / `/` / `@` / `Esc Esc`
 * input actions. The pane chords below avoid every one of them.
 *
 * `Mod+N` is the one deliberate exception: spec D8 makes it identical to
 * `/clear`, so `commands.js` takes that chord over while the pane panel is
 * active (a document capture listener registered before the shell handler).
 * Outside the pane workspace it keeps dsh's native meaning, "new session".
 *
 * Physical `code` values are matched first (layout independent); `key` is only
 * a fallback for synthetic events that omit `code`.
 */

/** How many open conversations (1-based) the focus chords address. */
const FOCUS_LIMIT = 4

/** The prefix every hint uses; `primary` is Control on the supported platforms. */
const PRIMARY = 'Ctrl'

/**
 * The action chords, in hint order.
 *
 * @typedef {{id: string, label: string, code: string, key: string, action: {kind: 'split', dir: 'row'|'col'}|{kind: 'close'}|{kind: 'new'}}} PaneShortcut
 * @type {readonly PaneShortcut[]}
 */
const PANE_SHORTCUTS = Object.freeze([
  Object.freeze({
    id: 'split-right',
    label: `${PRIMARY}+Shift+E`,
    code: 'KeyE',
    key: 'e',
    action: Object.freeze({ kind: 'split', dir: 'row' }),
  }),
  Object.freeze({
    id: 'split-down',
    label: `${PRIMARY}+Shift+D`,
    code: 'KeyD',
    key: 'd',
    action: Object.freeze({ kind: 'split', dir: 'col' }),
  }),
  Object.freeze({
    id: 'close-pane',
    label: `${PRIMARY}+Shift+X`,
    code: 'KeyX',
    key: 'x',
    action: Object.freeze({ kind: 'close' }),
  }),
  Object.freeze({
    id: 'new-conversation',
    label: `${PRIMARY}+Shift+N`,
    code: 'KeyN',
    key: 'n',
    action: Object.freeze({ kind: 'new' }),
  }),
])

/** @type {Readonly<Record<string, string>>} */
const SHORTCUT_LABELS = Object.freeze(
  Object.fromEntries(PANE_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.label])),
)

/** @param {number} index 1-based strip position @returns {string} */
function focusShortcutLabel(index) {
  return `${PRIMARY}+${index}`
}

/**
 * The hint for one action, from the same label the listener matches.
 *
 * @param {string} id shortcut id
 * @returns {string} e.g. `Ctrl+Shift+E`, or '' for an unknown id
 */
function shortcutLabel(id) {
  return SHORTCUT_LABELS[id] ?? ''
}

/**
 * `label (chord)` for a tooltip; an empty chord leaves the label alone.
 *
 * @param {string} label
 * @param {string} chord
 * @returns {string}
 */
function withShortcut(label, chord) {
  return chord === '' ? label : `${label} (${chord})`
}

/**
 * The one-line keyboard hint shown in the empty state and on the strip.
 *
 * @param {(key: string) => string} t translator
 * @returns {string}
 */
function paneShortcutHint(t) {
  return [
    `${t('pane.shortcuts.focus')} ${focusShortcutLabel(1)}–${focusShortcutLabel(FOCUS_LIMIT)}`,
    `${t('pane.splitRight')} ${shortcutLabel('split-right')}`,
    `${t('pane.splitDown')} ${shortcutLabel('split-down')}`,
    `${t('pane.close')} ${shortcutLabel('close-pane')}`,
    `${t('strip.new')} ${shortcutLabel('new-conversation')}`,
  ].join(' · ')
}

/**
 * The 1-based strip position a key event addresses, or null.
 *
 * Primary (Ctrl, or Cmd on macOS) plus a bare digit 1–4; no Alt/Shift, no
 * already-handled event, no auto-repeat. Kept separate from the DOM listener so
 * the chord rules stay testable in Node.
 *
 * @param {{key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, repeat?: boolean, defaultPrevented?: boolean}|null|undefined} event
 * @returns {number|null}
 */
function focusShortcutIndex(event) {
  if (event === null || event === undefined || typeof event !== 'object') return null
  if (event.defaultPrevented === true || event.repeat === true) return null
  if (event.ctrlKey !== true && event.metaKey !== true) return null
  if (event.altKey === true || event.shiftKey === true) return null
  let digit = null
  if (typeof event.key === 'string' && /^[1-9]$/u.test(event.key)) {
    digit = Number(event.key)
  } else if (typeof event.code === 'string' && /^Digit[1-9]$/u.test(event.code)) {
    digit = Number(event.code.slice('Digit'.length))
  }
  if (digit === null || digit > FOCUS_LIMIT) return null
  return digit
}

/**
 * Whether one event matches one action binding.
 *
 * @param {PaneShortcut} shortcut
 * @param {object} event
 * @returns {boolean}
 */
function matchesAction(shortcut, event) {
  if (event.defaultPrevented === true || event.repeat === true) return false
  if (event.ctrlKey !== true && event.metaKey !== true) return false
  if (event.altKey === true || event.shiftKey !== true) return false
  if (typeof event.code === 'string' && event.code !== '') return event.code === shortcut.code
  return typeof event.key === 'string' && event.key.toLowerCase() === shortcut.key
}

/**
 * Interpret a keyboard event as one pane action, or null.
 *
 * @param {object|null|undefined} event
 * @returns {{kind: 'focus', index: number}|{kind: 'split', dir: 'row'|'col'}|{kind: 'close'}|{kind: 'new'}|null}
 */
function paneShortcutAction(event) {
  const index = focusShortcutIndex(event)
  if (index !== null) return { kind: 'focus', index }
  if (event === null || event === undefined || typeof event !== 'object') return null
  for (const shortcut of PANE_SHORTCUTS) {
    if (matchesAction(shortcut, event)) return { ...shortcut.action }
  }
  return null
}

module.exports = {
  FOCUS_LIMIT,
  PANE_SHORTCUTS,
  SHORTCUT_LABELS,
  focusShortcutLabel,
  shortcutLabel,
  withShortcut,
  paneShortcutHint,
  focusShortcutIndex,
  paneShortcutAction,
}
