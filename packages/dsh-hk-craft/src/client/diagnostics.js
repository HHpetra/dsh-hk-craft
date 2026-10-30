'use strict'

/**
 * The plugin's verifiable presence in the shell: a sidebar footer action that
 * opens a small diagnostic panel.
 *
 * Written with `React.createElement` on purpose — the repository links client
 * modules itself (no bundler, no JSX transform), so the client half is plain
 * CommonJS plus a platform `require('react')`.
 *
 * `react` is resolved lazily: unit tests run in Node without the platform
 * module graph, so nothing may touch it at module load. The shell always
 * provides it (declared in `dsh.client.inject`).
 */

const { dictionaries } = require('./locale.js')

let reactModule = null

/** @returns {any} the platform React instance */
function react() {
  if (reactModule === null) reactModule = require('react')
  return reactModule
}

/**
 * @param {unknown} props
 * @returns {(key: string) => string}
 */
function createTranslator(props) {
  const t = /** @type {{ t?: unknown }} */ (props)?.t
  if (typeof t === 'function') return (key) => t(key)
  const tag =
    (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) || 'en'
  const table = tag.toLowerCase().startsWith('zh') ? dictionaries.zh : dictionaries.en
  return (key) => table[key] ?? dictionaries.en[key] ?? key
}

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  padding: '2px 8px',
}

const panelStyle = {
  position: 'fixed',
  left: 16,
  bottom: 56,
  zIndex: 2147483000,
  width: 320,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  fontSize: 12,
  lineHeight: 1.5,
}

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const mutedStyle = { opacity: 0.65 }

/**
 * @param {{ t?: (key: string) => string }} [props]
 */
function DiagnosticsAction(props) {
  const React = react()
  const h = React.createElement
  const t = createTranslator(props)
  const [open, setOpen] = React.useState(false)

  return h(
    React.Fragment,
    null,
    h(
      'button',
      {
        type: 'button',
        title: t('action.title'),
        style: buttonStyle,
        onClick: () => setOpen((value) => !value),
      },
      t('action.label'),
    ),
    open
      ? h(
          'div',
          { role: 'dialog', 'aria-label': t('panel.title'), style: panelStyle },
          h(
            'div',
            { style: { ...rowStyle, fontWeight: 600, marginBottom: 6 } },
            h('span', null, t('panel.title')),
            h(
              'button',
              {
                type: 'button',
                onClick: () => setOpen(false),
                style: { ...buttonStyle, padding: '0 6px' },
              },
              t('panel.close'),
            ),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: mutedStyle }, t('panel.loaded')),
            h('span', null, '✓'),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: mutedStyle }, t('panel.entry')),
            h('code', null, 'src/client/index.js'),
          ),
          h('div', { style: { ...mutedStyle, marginTop: 6 } }, t('panel.hint')),
        )
      : null,
  )
}

module.exports = { DiagnosticsAction, createTranslator, react }
