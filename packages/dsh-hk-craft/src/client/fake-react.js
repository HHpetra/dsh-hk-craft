'use strict'

/**
 * Test-only React stand-in plumbing.
 *
 * The client modules resolve `react` lazily through `react-and-translator.js`, and
 * the Node runner shares one module registry (`--test-isolation=none`). Swapping
 * `Module._load` before the component renders is therefore how each view test
 * supplies its stand-in without a DOM. This module holds that one installer so
 * every test file does not copy it.
 *
 * It is not a test file itself (no `*.test.js` suffix), so the runner loads it only
 * when a test requires it.
 */

const Module = require('node:module')

/**
 * Route every `require('react')` to `fake` until `restore()` is called.
 *
 * @param {object} fake the React stand-in
 * @returns {() => void} restore the previous loader
 */
function installFakeReact(fake) {
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === 'react') return fake
    return originalLoad.call(this, request, parent, isMain)
  }
  return function restore() {
    Module._load = originalLoad
  }
}

/**
 * Run `body` with `fake` installed, restoring the loader even when it throws.
 *
 * An async body is awaited before the restore, so a `flush`/`await` inside the
 * body still sees the stand-in.
 *
 * @template T
 * @param {object} fake the React stand-in
 * @param {() => T} body
 * @returns {T}
 */
function withFakeReact(fake, body) {
  const restore = installFakeReact(fake)
  try {
    const result = body()
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      return result.finally(restore)
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

module.exports = { installFakeReact, withFakeReact }
