'use strict'

/**
 * The workspace pane budget and the persisted `maxPanes` setting.
 *
 * dsh's right sidebar caps a docking surface at a fixed number of panes and
 * disables its split control once that budget is spent
 * (`@deepseek-ai/dsh-client-ui-dockkit/engine/constraints.ts`). This plugin
 * follows the same rule, but the cap is a user setting: 4 panes by default, 0
 * means unlimited. The budget only gates *creating* a pane; it never closes an
 * existing one, so lowering the setting (or restoring a wider saved layout)
 * cannot destroy work.
 *
 * The setting is origin-wide, like the per-workspace layout keys in
 * `layout-store.js`, and lives under one versioned key:
 *
 *   `dsh.hkcraft.settings.v1` → `{ "version": 1, "maxPanes": 4 }`
 *
 * Reading never throws: a missing store, a corrupt payload or an invalid value
 * falls back to the default. Writing is best-effort, exactly like layout
 * persistence.
 *
 * This module has no React, no DOM and no dsh imports.
 */

const { leaves } = require('./layout-tree.js')

/** Pane cap used when the setting is absent or invalid. */
const DEFAULT_MAX_PANES = 4

/** Prefix and version of the origin-wide settings payload. */
const PANE_SETTINGS_KEY = 'dsh.hkcraft.settings.v1'
const PANE_SETTINGS_VERSION = 1

/**
 * Read a non-negative safe integer from a number or a digit string.
 *
 * Unusable input is `null` (no fallback). `normalizeMaxPanes` turns that into
 * the default cap; the settings field keeps the `null` so it can show a
 * validation error instead of saving. Numbers stay numbers. Strings are
 * trimmed and must be all digits.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseNonNegativeInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^\d+$/u.test(text)) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Coerce a setting value to a usable pane cap.
 *
 * Accepts a non-negative safe integer or a string of digits (the number input
 * hands back strings). Everything else — negatives, decimals, NaN, booleans,
 * an empty string — falls back, so a corrupted store can never make panes
 * unopenable.
 *
 * @param {unknown} value raw setting value
 * @param {number} [fallback] cap used when `value` is unusable
 * @returns {number} a non-negative integer; 0 means unlimited
 */
function normalizeMaxPanes(value, fallback = DEFAULT_MAX_PANES) {
  const base = Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : DEFAULT_MAX_PANES
  return parseNonNegativeInteger(value) ?? base
}

/**
 * The pane cap stored in one storage seam.
 *
 * @param {{getItem?: (key: string) => unknown}|undefined|null} storage
 * @returns {number} the stored cap, or `DEFAULT_MAX_PANES`
 */
function readMaxPanes(storage) {
  let raw = null
  try {
    if (typeof storage?.getItem === 'function') raw = storage.getItem(PANE_SETTINGS_KEY)
  } catch (_error) {
    return DEFAULT_MAX_PANES
  }
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MAX_PANES
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_error) {
    return DEFAULT_MAX_PANES
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== PANE_SETTINGS_VERSION) {
    return DEFAULT_MAX_PANES
  }
  return normalizeMaxPanes(parsed.maxPanes)
}

/**
 * Persist one pane cap. Failures (quota, disabled storage, no store) are
 * reported as `false` and never thrown.
 *
 * @param {{setItem?: (key: string, value: string) => unknown}|undefined|null} storage
 * @param {unknown} value raw cap; it is normalised before writing
 * @returns {{ok: boolean, maxPanes: number, message?: string}} the value that was
 *   written. `ok: false` never throws; `message` is empty when there is no store.
 */
function writeMaxPanes(storage, value) {
  const maxPanes = normalizeMaxPanes(value)
  if (typeof storage?.setItem !== 'function') return { ok: false, maxPanes, message: '' }
  try {
    storage.setItem(
      PANE_SETTINGS_KEY,
      JSON.stringify({ version: PANE_SETTINGS_VERSION, maxPanes }),
    )
    return { ok: true, maxPanes }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, maxPanes, message }
  }
}

/**
 * The number of panes one layout currently holds.
 *
 * @param {{root?: object|null}|null|undefined} layout
 * @returns {number}
 */
function paneCount(layout) {
  return leaves(layout?.root ?? null).length
}

/**
 * Whether a pane total has reached the cap.
 *
 * `maxPanes` is normalised first, so a missing value reads as the default cap
 * rather than as unlimited. `0` means unlimited. `count` is whatever the
 * caller is gating on: open leaves, or open leaves plus splits already
 * reserved but not yet written into the tree.
 *
 * @param {number} count
 * @param {unknown} maxPanes the configured cap; 0 means unlimited
 * @returns {boolean}
 */
function isPaneBudgetSpent(count, maxPanes) {
  const limit = normalizeMaxPanes(maxPanes)
  if (limit === 0) return false
  return count >= limit
}

/**
 * Whether one layout has spent its pane budget.
 *
 * Floating panes do not exist in this plugin, so the docked leaf count is the
 * whole count. In-flight reservations are not leaves; the controller adds
 * those before calling `isPaneBudgetSpent`.
 *
 * @param {{root?: object|null}|null|undefined} layout layout or snapshot with a root
 * @param {unknown} maxPanes the configured cap; 0 means unlimited
 * @returns {boolean}
 */
function paneBudgetBlocked(layout, maxPanes) {
  return isPaneBudgetSpent(paneCount(layout), maxPanes)
}

module.exports = {
  DEFAULT_MAX_PANES,
  PANE_SETTINGS_KEY,
  PANE_SETTINGS_VERSION,
  parseNonNegativeInteger,
  normalizeMaxPanes,
  readMaxPanes,
  writeMaxPanes,
  paneCount,
  isPaneBudgetSpent,
  paneBudgetBlocked,
}
