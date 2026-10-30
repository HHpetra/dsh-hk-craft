'use strict'

/**
 * The two helpers every client view shares: the lazy platform React accessor and
 * the slot-translator fallback.
 *
 * The diagnostics UI that used to live here moved inline into the HK Craft
 * settings page (`settings-view.js`). The helpers stay because the views are
 * loaded in Node by the unit tests, where the platform module graph (and `react`)
 * does not exist.
 */

const { dictionaries } = require('./locale.js')

/**
 * The platform React instance, resolved lazily and on every call.
 *
 * `require` itself caches the module in the shell, so repeated calls are cheap.
 * Not memoizing in this file matters for the Node tests: the runner shares one
 * module registry (`--test-isolation=none`) and each test file installs its own
 * React stand-in through `Module._load`; a memoized instance would pin whichever
 * stand-in happened to be installed first.
 *
 * @returns {any} the platform React instance
 */
function react() {
  return require('react')
}

/**
 * Fill `{name}` placeholders from a translator's params.
 *
 * A missing param leaves its placeholder in place instead of printing
 * `undefined`, and a non-string template is returned untouched.
 *
 * @param {unknown} template
 * @param {Record<string, unknown> | null | undefined} params
 * @returns {string}
 */
function interpolate(template, params) {
  if (typeof template !== 'string') return template === undefined ? '' : String(template)
  if (params === null || params === undefined || typeof params !== 'object') return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Prefer the slot-provided translator, params included; fall back to the browser
 * language so a component rendered outside a slot still shows copy instead of
 * raw keys.
 *
 * @param {unknown} props
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 */
function createTranslator(props) {
  const t = /** @type {{ t?: unknown }} */ (props)?.t
  if (typeof t === 'function') return (key, params) => t(key, params)
  const tag =
    (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) || 'en'
  const table = tag.toLowerCase().startsWith('zh') ? dictionaries.zh : dictionaries.en
  return (key, params) => interpolate(table[key] ?? dictionaries.en[key] ?? key, params)
}

module.exports = { createTranslator, interpolate, react }
