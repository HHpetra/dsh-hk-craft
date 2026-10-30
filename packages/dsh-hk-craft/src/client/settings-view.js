'use strict'

/**
 * The HK Craft page in dsh's Settings panel.
 *
 * This used to be two sidebar footer actions — a floating diagnostics panel and
 * the native ⇄ pane toggle. Both are transitional developer entry points, so they
 * moved here: the diagnostics render inline and the split-view switch lives next
 * to them until a long-term entry point is decided.
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

    // The probe is a point-in-time slot snapshot; re-read it when the page opens
    // so the diagnostics describe the shell as it is now, not as it was at load.
    React.useEffect(() => {
      if (typeof controller.refreshProbe === 'function') controller.refreshProbe()
    }, [controller])

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
    const errorText =
      error === null
        ? null
        : error === ''
          ? t('settings.pane.error')
          : `${t('settings.pane.error')} — ${error}`

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
  createSettingsSection,
}
