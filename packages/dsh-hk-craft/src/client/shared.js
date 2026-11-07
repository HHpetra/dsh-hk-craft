'use strict'

/**
 * Small helpers shared by the client modules, so each of them has exactly one
 * implementation.
 *
 * No React, no dsh and no DOM: this module is safe to load in Node, where the
 * unit tests run.
 */

/**
 * Normalize anything thrown or rejected into a displayable one-line message.
 *
 * @param {unknown} error thrown value
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A plain object, excluding `null` and arrays.
 *
 * Snapshot payloads and stored JSON both arrive as `unknown`. Callers that
 * branch on "is this a record" share this one check so an array cannot pass
 * as a map of fields.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The browser's origin-wide storage, or null.
 *
 * Reading `localStorage` itself throws in some locked-down profiles, and Node
 * (the unit tests) has none. A non-object value is treated as missing too.
 * Callers treat null as "no store" and never throw because of it.
 *
 * @returns {{getItem?: Function, setItem?: Function}|null}
 */
function browserStorage() {
  try {
    const storage = globalThis.localStorage
    return typeof storage === 'object' && storage !== null ? storage : null
  } catch (_error) {
    return null
  }
}

/** Stable stand-in so a missing hook never changes the hook call count. */
function absentHook() {
  return undefined
}

module.exports = { messageOf, isRecord, browserStorage, absentHook }
