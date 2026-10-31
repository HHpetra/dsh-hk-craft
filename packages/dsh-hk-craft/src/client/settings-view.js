'use strict'

/**
 * The HK Craft page in dsh's Settings panel.
 *
 * This used to be two sidebar footer actions — a floating diagnostics panel and
 * the native ⇄ pane toggle. Both are transitional developer entry points, so they
 * moved here: the diagnostics render inline, the workspace pane limit is edited
 * beside them, and the split-view switch lives next to both until a long-term
 * entry point is decided.
 *
 * The component consumes only the pane controller face and the slot's locale
 * translator; every dsh-specific assumption stays in `dsh-pane-host.js`. The pure
 * helpers are exported so the Node tests can cover the projections and the
 * success/failure policy without a DOM or a React renderer.
 *
 * Written with `React.createElement` and a lazy `require('react')` for the same
 * reason as `pane-view.js`: the repository links client modules itself and the
 * unit tests run in Node, where the platform module graph does not exist.
 */

const { createTranslator, react } = require('./react-and-translator.js')
const { buttonStyle } = require('./pane-styles.js')
const { normalizeMaxPanes, parseNonNegativeInteger } = require('./pane-budget.js')
const { messageOf } = require('./shared.js')

/** The build entry named in the diagnostics. */
const ENTRY_NAME = 'src/client/index.js'

const pageStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  maxWidth: 680,
  padding: '16px 4px 24px',
  fontSize: 13,
  lineHeight: 1.55,
}

const headingStyle = { margin: 0, fontSize: 16, fontWeight: 600 }

const groupStyle = { display: 'flex', flexDirection: 'column', gap: 8 }

const groupTitleStyle = { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.7 }

const rowsStyle = { display: 'flex', flexDirection: 'column', gap: 6 }

const rowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(140px, max-content) 1fr',
  gap: 12,
  alignItems: 'baseline',
}

const labelStyle = { opacity: 0.7 }
const valueStyle = { minWidth: 0, wordBreak: 'break-word' }
const modeStyle = { opacity: 0.7 }

const actionStyle = {
  ...buttonStyle,
  alignSelf: 'flex-start',
  fontSize: 13,
  padding: '4px 10px',
}

const inputStyle = {
  width: 88,
  boxSizing: 'border-box',
  padding: '3px 6px',
  border: '1px solid color-mix(in srgb, currentColor 28%, transparent)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

const noteStyle = { margin: 0, fontSize: 11, lineHeight: 1.5, opacity: 0.62 }

const errorStyle = {
  padding: '6px 8px',
  borderRadius: 6,
  background: 'color-mix(in srgb, tomato 16%, transparent)',
  wordBreak: 'break-word',
}

/**
 * The localized status key of a `conversation.content` probe result.
 *
 * @param {string|undefined} status one of dsh-pane-host's probe statuses
 * @returns {string}
 */
function probeStatusKey(status) {
  switch (status) {
    case 'present':
      return 'settings.diag.status.present'
    case 'missing':
      return 'settings.diag.status.missing'
    case 'error':
      return 'settings.diag.status.error'
    default:
      return 'settings.diag.status.unknown'
  }
}

/**
 * Which localized mode name the settings page shows: split or native.
 *
 * @param {{active?: boolean}|undefined} snapshot the pane controller snapshot
 * @returns {'settings.view.split'|'settings.view.native'}
 */
function paneModeKey(snapshot) {
  return snapshot?.active === true ? 'settings.view.split' : 'settings.view.native'
}

/**
 * The diagnostics as plain `{ key, label, value }` rows.
 *
 * @param {any} snapshot the pane controller snapshot (probe + active)
 * @param {(key: string) => string} t the slot's locale translator
 * @returns {Array<{key: string, label: string, value: string}>}
 */
function diagnosticsRows(snapshot, t) {
  const probe = snapshot?.probe ?? {}
  const status = t(probeStatusKey(probe.status))
  const message = typeof probe.message === 'string' && probe.message !== '' ? probe.message : null
  return [
    { key: 'loaded', label: t('settings.diag.loaded'), value: '✓' },
    { key: 'entry', label: t('settings.diag.entry'), value: ENTRY_NAME },
    {
      key: 'content',
      label: t('settings.diag.content'),
      value: message === null ? status : `${status} — ${message}`,
    },
    { key: 'view', label: t('settings.diag.view'), value: t(paneModeKey(snapshot)) },
  ]
}

/**
 * Activate or leave the pane workspace from the settings page.
 *
 * The controller reports failure through its snapshot (both `activate()` and
 * `deactivate()` emit `error`), so the caller must re-read it after the call.
 * On success the settings page closes; on failure the error stays on the page
 * and the page stays open. Never rejects.
 *
 * @param {any} controller the pane controller face
 * @param {{close?: () => void, setBusy?: (busy: boolean) => void, setError?: (error: string|null) => void}} [handlers]
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
function togglePaneMode(controller, handlers = {}) {
  const close = typeof handlers.close === 'function' ? handlers.close : () => {}
  const setBusy = typeof handlers.setBusy === 'function' ? handlers.setBusy : () => {}
  const setError = typeof handlers.setError === 'function' ? handlers.setError : () => {}

  setBusy(true)
  setError(null)

  return Promise.resolve()
    .then(() => {
      const before = controller.getSnapshot()
      if (before?.active === true) {
        controller.deactivate()
      } else if (controller.activate() !== true) {
        const failed = controller.getSnapshot()
        // An empty reason still counts as a failure: the page shows its
        // localized "switch failed" line even when the controller gives none.
        return { ok: false, error: failed?.error ?? '' }
      }
      const after = controller.getSnapshot()
      return after?.error == null ? { ok: true } : { ok: false, error: after.error }
    })
    .catch((error) => ({ ok: false, error: messageOf(error) }))
    .then((result) => {
      setBusy(false)
      if (result.ok === true) close()
      else setError(result.error)
      return result
    })
}

/** A failure line: the localized summary alone when the detail is empty. */
function withReason(summary, detail) {
  return detail === '' ? summary : `${summary} — ${detail}`
}

/**
 * Parse the pane-limit input.
 *
 * The field is a number input, so the only accepted drafts are a non-negative
 * whole number (`0` means unlimited). An empty or fractional draft is invalid
 * rather than silently coerced, so the page can say why it did not save.
 *
 * @param {unknown} draft raw input value
 * @returns {number|null} the parsed cap, or null when the draft is invalid
 */
function parseMaxPanesDraft(draft) {
  // Numbers are judged as text, the same way the number input reports them.
  if (typeof draft === 'number') return parseNonNegativeInteger(String(draft))
  return parseNonNegativeInteger(draft)
}

/**
 * Save the pane limit through the controller.
 *
 * Never rejects: an invalid draft, a controller without `setMaxPanes`, and a
 * throwing controller are all reported as `{ ok: false, reason }` so the page
 * can keep the draft and show a localized reason. A controller that keeps the
 * new cap in memory but fails to persist it reports that through
 * `snapshot.maxPanesError` (a string, empty when storage is missing) instead of
 * throwing; the page shows the failure and the in-memory cap stays in effect.
 * On success the value is the controller's normalised cap, which may differ
 * from the draft only when the controller applies its own fallback.
 *
 * @param {any} controller the pane controller face
 * @param {unknown} draft raw input value
 * @returns {{ok: true, value: number} | {ok: false, reason: 'invalid'|'unsupported'|'error', message?: string}}
 */
function saveMaxPanes(controller, draft) {
  const value = parseMaxPanesDraft(draft)
  if (value === null) return { ok: false, reason: 'invalid' }
  if (typeof controller?.setMaxPanes !== 'function') return { ok: false, reason: 'unsupported' }
  try {
    const applied = controller.setMaxPanes(value)
    const snap = typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : null
    if (snap !== null && snap !== undefined && typeof snap.maxPanesError === 'string') {
      return { ok: false, reason: 'error', message: snap.maxPanesError }
    }
    const next = normalizeMaxPanes(applied, value)
    return { ok: true, value: next }
  } catch (error) {
    return { ok: false, reason: 'error', message: messageOf(error) }
  }
}

/**
 * Build the `settings.section` component for one pane controller.
 *
 * @param {any} controller the pane controller face
 * @returns {(props: { t?: (key: string) => string, close?: () => void }) => any}
 */
function createSettingsSection(controller) {
  return function HkCraftSettings(props) {
    const React = react()
    const h = React.createElement
    const t = createTranslator(props)
    const close = typeof props?.close === 'function' ? props.close : undefined
    const state = React.useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    )
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)
    const inFlight = React.useRef(false)
    const maxPanes = normalizeMaxPanes(state?.maxPanes)
    const [limitDraft, setLimitDraft] = React.useState(String(maxPanes))
    /** Outcome of the last save: `{kind: 'saved'}`, `{kind: 'invalid'}` or `{kind: 'error', message}`. */
    const [limitNotice, setLimitNotice] = React.useState(null)

    // The probe is a point-in-time slot snapshot; re-read it when the page opens
    // so the diagnostics describe the shell as it is now, not as it was at load.
    React.useEffect(() => {
      if (typeof controller.refreshProbe === 'function') controller.refreshProbe()
    }, [controller])

    // A change made elsewhere (another window, a restored store) wins over the
    // draft; an in-progress edit is left alone because only the committed value
    // changes this dependency.
    React.useEffect(() => {
      setLimitDraft(String(maxPanes))
    }, [maxPanes])

    const saveLimit = () => {
      const result = saveMaxPanes(controller, limitDraft)
      if (result.ok === true) {
        setLimitDraft(String(result.value))
        setLimitNotice({ kind: 'saved' })
      } else if (result.reason === 'invalid') {
        setLimitNotice({ kind: 'invalid' })
      } else {
        setLimitNotice({ kind: 'error', message: result.message ?? '' })
      }
    }

    const toggle = () => {
      // `setBusy(true)` only lands on the next render, so a ref also guards a
      // double click in the same tick.
      if (inFlight.current) return
      inFlight.current = true
      togglePaneMode(controller, { close, setBusy, setError }).then(() => {
        inFlight.current = false
      })
    }

    const toggleLabel = busy
      ? t('settings.pane.busy')
      : t(state?.active === true ? 'settings.pane.exit' : 'settings.pane.enter')
    const errorText = error === null ? null : withReason(t('settings.pane.error'), error)

    const rows = diagnosticsRows(state, t)

    return h(
      'div',
      { style: pageStyle, 'data-hkcraft': 'settings' },
      h('h2', { style: headingStyle }, t('settings.title')),
      h(
        'section',
        { style: groupStyle },
        h('h3', { style: groupTitleStyle }, t('settings.diag.title')),
        h(
          'div',
          { style: rowsStyle },
          rows.map((row) =>
            h(
              'div',
              { key: row.key, style: rowStyle },
              h('span', { style: labelStyle }, row.label),
              h('span', { style: valueStyle }, row.value),
            ),
          ),
        ),
      ),
      h(
        'section',
        { style: groupStyle, 'data-hkcraft': 'settings-split' },
        h('h3', { style: groupTitleStyle }, t('settings.split.title')),
        h(
          'label',
          { style: rowStyle },
          h('span', { style: labelStyle }, t('settings.split.label')),
          h('input', {
            type: 'number',
            min: 0,
            step: 1,
            inputMode: 'numeric',
            value: limitDraft,
            'aria-label': t('settings.split.label'),
            'data-hkcraft-split-limit': '',
            style: inputStyle,
            onChange: (event) => {
              const next = event.target.value
              setLimitDraft(next)
              // A draft that no longer matches the saved cap is not saved yet.
              // Leaving the saved notice up would claim the edit had already landed.
              // An invalid notice describes the draft, so it also goes away once
              // the field is back to the cap that is already in effect.
              if (next.trim() !== String(maxPanes) || limitNotice?.kind === 'invalid') {
                setLimitNotice(null)
              }
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              saveLimit()
            },
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { type: 'button', onClick: saveLimit, style: actionStyle }, t('settings.split.save')),
          limitNotice?.kind === 'saved'
            ? h('span', { role: 'status', style: noteStyle }, t('settings.split.saved'))
            : null,
        ),
        limitNotice?.kind === 'invalid'
          ? h('div', { role: 'alert', style: errorStyle }, t('settings.split.invalid'))
          : null,
        limitNotice?.kind === 'error'
          ? h(
              'div',
              { role: 'alert', style: errorStyle },
              withReason(t('settings.split.error'), limitNotice.message),
            )
          : null,
        h('p', { style: noteStyle }, t('settings.split.note')),
      ),
      h(
        'section',
        { style: groupStyle },
        h('h3', { style: groupTitleStyle }, t('settings.pane.title')),
        h('div', { style: modeStyle }, `${t('settings.pane.current')}: ${t(paneModeKey(state))}`),
        h(
          'button',
          {
            type: 'button',
            onClick: toggle,
            disabled: busy,
            'aria-busy': busy ? 'true' : undefined,
            style: { ...actionStyle, opacity: busy ? 0.6 : 1 },
          },
          toggleLabel,
        ),
        errorText === null ? null : h('div', { role: 'alert', style: errorStyle }, errorText),
        h('p', { style: noteStyle }, t('settings.pane.note')),
      ),
    )
  }
}

module.exports = {
  ENTRY_NAME,
  probeStatusKey,
  paneModeKey,
  diagnosticsRows,
  togglePaneMode,
  parseMaxPanesDraft,
  saveMaxPanes,
  createSettingsSection,
}
