'use strict'

/**
 * Shared UI helpers for the client half: the lazy React accessor and the
 * slot-translator fallback every view uses.
 *
 * The diagnostics UI used to live here as a floating sidebar-footer panel; it
 * moved inline into the HK Craft settings page (ticket 05, `settings-view.js`).
 * The helpers stay because the views load this module in Node, where the
 * platform module graph (and `react`) does not exist.
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
 * Prefer the slot-provided translator; fall back to the browser language so a
 * component rendered outside a slot still shows copy instead of raw keys.
 *
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

module.exports = { createTranslator, react }
