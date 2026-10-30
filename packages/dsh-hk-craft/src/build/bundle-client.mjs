/**
 * Pure-JS client bundle linker.
 *
 * `lib/client.js` must be a single file the dsh Web shell can boot straight from
 * a `<script>`: `window.__ModuleLoader__.load({ id, factory })`, where
 * `factory(require)` returns the entry module's exports and `require` resolves
 * the platform modules the shell seeds (`react`, …). There is no bundler and no
 * child process in this environment, so this module does the one thing a bundler
 * would do here: walk the relative `require` graph of `src/client/**` and wrap
 * every module body in a function of `(module, exports, require)`.
 *
 * Module ids are bundle-relative paths (`index.js`, `nested/x.js`), which is
 * exactly how the sources already write their specifiers.
 */
import { posix } from 'node:path'

/** A `require('./relative')` (or `../`), the only kind this linker follows. */
const RELATIVE_REQUIRE = /require\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g

/**
 * Resolve one relative specifier against the module that requires it.
 *
 * @param {string} fromId bundle-relative id of the requiring module
 * @param {string} specifier relative specifier as written
 * @returns {string} bundle-relative id of the target
 */
export function resolveModuleId(fromId, specifier) {
  return posix.normalize(posix.join(posix.dirname(fromId), specifier))
}

/**
 * Walk the relative require graph from the entry module.
 *
 * Bare specifiers are platform modules and are *not* followed. A module the
 * reader cannot supply is a hard build failure: the shell would otherwise fail
 * at runtime with a much worse message.
 *
 * @param {string} entryId bundle-relative entry id
 * @param {(moduleId: string) => string | null} readModule file reader
 * @returns {Array<{ id: string, source: string }>} entry first, then discovery order
 */
export function collectModules(entryId, readModule) {
  /** @type {Map<string, string>} */
  const sources = new Map()
  /** @type {string[]} */
  const pending = [entryId]
  while (pending.length > 0) {
    const moduleId = pending.shift()
    if (moduleId === undefined || sources.has(moduleId)) continue
    const source = readModule(moduleId)
    if (source === null) throw new Error(`client module not found: ${moduleId}`)
    sources.set(moduleId, source)
    for (const match of source.matchAll(RELATIVE_REQUIRE)) {
      pending.push(resolveModuleId(moduleId, match[2]))
    }
  }
  return [...sources].map(([id, source]) => ({ id, source }))
}

/**
 * Render the single-file bundle the shell loader accepts.
 *
 * The generated factory keeps a per-module cache and runs each body exactly once
 * — factory-form CommonJS cannot hand out partial exports, so a cycle is a
 * runtime error rather than a silent half-initialized module.
 *
 * @param {{ id: string, entryId: string, modules: ReadonlyArray<{ id: string, source: string }> }} input
 * @returns {string}
 */
export function renderBundle({ id, entryId, modules }) {
  const definitions = modules
    .map(
      (module) =>
        `    define(${JSON.stringify(module.id)}, function (module, exports, require) {\n${module.source}\n    });`,
    )
    .join('\n\n')

  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    'use strict'

    var definitions = Object.create(null)
    var cache = Object.create(null)

    /** Register one bundled module body. */
    function define(moduleId, body) {
      definitions[moduleId] = body
    }

    /** Resolve a specifier from one module: platform modules go straight out. */
    function load(fromId, specifier) {
      if (specifier.charAt(0) !== ".") return require(specifier)
      var parts = (fromId.slice(0, fromId.lastIndexOf('/') + 1) + specifier).split('/')
      var normalized = []
      for (var index = 0; index < parts.length; index += 1) {
        var part = parts[index]
        if (part === '' || part === '.') continue
        if (part === '..') {
          normalized.pop()
          continue
        }
        normalized.push(part)
      }
      return materialize(normalized.join('/'))
    }

    /** Run one module body exactly once. */
    function materialize(moduleId) {
      var cached = cache[moduleId]
      if (cached !== undefined) return cached.exports
      var body = definitions[moduleId]
      if (body === undefined) throw new Error('client bundle: unknown module "' + moduleId + '"')
      var module = { exports: {} }
      cache[moduleId] = module
      body(module, module.exports, function (specifier) {
        return load(moduleId, specifier)
      })
      return module.exports
    }

${definitions}

    return materialize(${JSON.stringify(entryId)})
  },
})
`
}
