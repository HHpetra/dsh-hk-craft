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

/** Stable stand-in so a missing hook never changes the hook call count. */
function absentHook() {
  return undefined
}

module.exports = { messageOf, absentHook }
