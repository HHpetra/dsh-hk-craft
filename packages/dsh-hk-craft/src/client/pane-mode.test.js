'use strict'

/**
 * Read-only current-mode badge.
 *
 * The badge is a projection, not a control: a pane's session summary carries
 * the preset id the conversation started with, and a label resolution turns that
 * id into copy. These tests fix the projection rules only; the React badge and
 * the optional roster adapter have their own tests.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  BUILT_IN_MODE_KEYS,
  presetIdOfSession,
  modeRosterRows,
  resolveModeLabel,
} = require('./pane-mode.js')

/** A session list snapshot whose row records `projectionValues.agentPreset`. */
function sessionsWith(sessionId, preset) {
  return { byId: { [sessionId]: { id: sessionId, projectionValues: { agentPreset: preset } } } }
}

/** Stand-in translator: returns the key, so assertions can see which key is used. */
const t = (key) => key

test('a pane session exposes the preset it started with', () => {
  assert.equal(presetIdOfSession(sessionsWith('s1', 'standard'), 's1'), 'standard')
  assert.equal(presetIdOfSession(sessionsWith('s1', 'review'), 's1'), 'review')
})

test('a missing session, row or preset yields no mode', () => {
  assert.equal(presetIdOfSession(sessionsWith('s1', 'standard'), undefined), undefined)
  assert.equal(presetIdOfSession(sessionsWith('s1', 'standard'), ''), undefined)
  assert.equal(presetIdOfSession(sessionsWith('s1', 'standard'), 'gone'), undefined)
  assert.equal(presetIdOfSession({ byId: { s1: {} } }, 's1'), undefined)
  assert.equal(presetIdOfSession(sessionsWith('s1', ''), 's1'), undefined)
  assert.equal(presetIdOfSession(sessionsWith('s1', 42), 's1'), undefined)
})

test('the four shipped presets resolve to their localized names', () => {
  assert.deepEqual(Object.keys(BUILT_IN_MODE_KEYS).sort(), ['cordis', 'minimal', 'ptc', 'standard'])
  assert.equal(resolveModeLabel('standard', [], t).label, 'pane.mode.standard')
  assert.equal(resolveModeLabel('ptc', [], t).label, 'pane.mode.ptc')
  assert.equal(resolveModeLabel('minimal', [], t).label, 'pane.mode.minimal')
  assert.equal(resolveModeLabel('cordis', [], t).label, 'pane.mode.cordis')
})

test('a preset the shell does not know falls back to its raw id', () => {
  assert.deepEqual(resolveModeLabel('my-review', [], t), {
    id: 'my-review',
    label: 'my-review',
    title: 'pane.mode.hint',
  })
  // Ids that collide with Object.prototype keys are unknown ids, not built-ins.
  assert.equal(resolveModeLabel('constructor', [], t).label, 'constructor')
})

test('no pane session or no recorded preset renders nothing', () => {
  // The badge composes these two public rules; there is no third "project" entry
  // point just for the tests.
  const badgeOf = (sessions, sessionId) => {
    const presetId = presetIdOfSession(sessions, sessionId)
    return presetId === undefined ? null : resolveModeLabel(presetId, [], t)
  }
  assert.equal(badgeOf(sessionsWith('s1', 'standard'), undefined), null)
  assert.equal(badgeOf(sessionsWith('s1', 'standard'), 's1').label, 'pane.mode.standard')
  assert.equal(badgeOf(sessionsWith('s1', 'standard'), 'gone'), null)
  assert.equal(badgeOf({ byId: {} }, 's1'), null)
})

test('a custom preset shows the name it published, ahead of any built-in name', () => {
  const roster = [
    { id: 'review', name: 'Code review', description: 'Prioritize bugs and test gaps.' },
    { id: 'standard', name: 'House standard' },
  ]

  assert.deepEqual(resolveModeLabel('review', roster, t), {
    id: 'review',
    label: 'Code review',
    title: 'Prioritize bugs and test gaps.',
  })
  assert.equal(resolveModeLabel('standard', roster, t).label, 'House standard')
  // A shipped preset publishes no name, so the localized name still applies.
  assert.equal(resolveModeLabel('ptc', roster, t).label, 'pane.mode.ptc')
})

test('the title falls back to the explanation when the roster has no description', () => {
  assert.equal(resolveModeLabel('standard', [], t).title, 'pane.mode.hint')
  assert.equal(resolveModeLabel('review', [{ id: 'review', name: 'Code review' }], t).title, 'pane.mode.hint')
})

test('the remote roster result is normalized to plain, well-formed rows', () => {
  assert.deepEqual(
    modeRosterRows({
      ok: true,
      value: {
        presets: [
          { id: 'standard', isDefault: true },
          { id: 'review', name: 'Code review', description: 'Prioritize bugs.' },
        ],
      },
    }),
    [
      { id: 'standard' },
      { id: 'review', name: 'Code review', description: 'Prioritize bugs.' },
    ],
  )
})

test('an absent, failed or malformed roster degrades to no rows', () => {
  assert.deepEqual(modeRosterRows(undefined), [])
  assert.deepEqual(modeRosterRows(null), [])
  assert.deepEqual(modeRosterRows({ ok: false, error: { message: 'unavailable' } }), [])
  assert.deepEqual(modeRosterRows({ ok: true, value: {} }), [])
  assert.deepEqual(modeRosterRows({ ok: true, value: { presets: 'nope' } }), [])
  assert.deepEqual(
    modeRosterRows({
      ok: true,
      value: {
        presets: [null, 'x', { name: 'no id' }, { id: '' }, { id: 7 }, { id: 'review', name: 42 }],
      },
    }),
    [{ id: 'review' }],
  )
})
