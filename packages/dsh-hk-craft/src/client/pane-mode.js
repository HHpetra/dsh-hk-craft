'use strict'

/**
 * The read-only current-mode projection.
 *
 * A conversation records the Agent preset it was composed with on its session
 * summary row (`projectionValues.agentPreset`, the same value the native
 * session header reads — `docs/upstream-contracts.md#session-preset-and-optional-roster`).
 * That id is all a pane can know: dsh fixes the composition after the first
 * turn, so this module resolves copy only; it never offers a switch.
 *
 * dsh shapes stop at `catalog.js`. The seat receives the catalog and the pane's
 * own session id, and passes the normalized roster rows (or nothing) in.
 */

/** Localized names for the shipped presets whose copy the plugin carries. */
const BUILT_IN_MODE_KEYS = {
  standard: 'pane.mode.standard',
  ptc: 'pane.mode.ptc',
  minimal: 'pane.mode.minimal',
  cordis: 'pane.mode.cordis',
}

/** The explanation used when the roster publishes no description. */
const MODE_HINT_KEY = 'pane.mode.hint'

/**
 * The preset id recorded on one pane's session summary.
 *
 * @param {{projectionsOf?: (sessionId: string) => any}|undefined} catalog the read model
 * @param {string|undefined} sessionId the pane's conversation
 * @returns {string|undefined} a non-empty preset id, or undefined
 */
function presetIdOfSession(catalog, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const value = catalog?.projectionsOf?.(sessionId)?.session?.agentPreset
  if (typeof value !== 'string') return undefined
  const presetId = value.trim()
  return presetId === '' ? undefined : presetId
}

/**
 * A localized shipped-preset name, or undefined for any other id.
 *
 * A custom preset owns its own copy, so the built-in table must not rename it
 * even when its id happens to collide.
 *
 * @param {string} presetId preset id
 * @param {(key: string) => string} t translator
 * @returns {string|undefined}
 */
function builtInModeName(presetId, t) {
  // Own keys only: ids such as "constructor" must not resolve through the
  // prototype to a function and be handed to the translator.
  if (typeof t !== 'function' || !Object.hasOwn(BUILT_IN_MODE_KEYS, presetId)) return undefined
  const name = t(BUILT_IN_MODE_KEYS[presetId])
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

/**
 * Normalize one `remote.agentPresets.list()` result to plain roster rows.
 *
 * The roster is an optional capability: an absent service, a failed read, or a
 * result whose shape is not `{ ok: true, value: { presets: [...] } }` all reduce
 * to `[]`, so label resolution falls back to the localized name or the raw id
 * without blocking the strip. Rows without a usable id are dropped; a non-string
 * name or description is ignored rather than rendered.
 *
 * @param {unknown} result remote result
 * @returns {{id: string, name?: string, description?: string}[]}
 */
function modeRosterRows(result) {
  if (result === null || typeof result !== 'object' || result.ok !== true) return []
  const presets = result.value?.presets
  if (!Array.isArray(presets)) return []
  const rows = []
  for (const preset of presets) {
    if (preset === null || typeof preset !== 'object') continue
    if (typeof preset.id !== 'string' || preset.id.trim() === '') continue
    const row = { id: preset.id.trim() }
    if (typeof preset.name === 'string' && preset.name.trim() !== '') row.name = preset.name.trim()
    if (typeof preset.description === 'string' && preset.description.trim() !== '') {
      row.description = preset.description.trim()
    }
    rows.push(row)
  }
  return rows
}

/**
 * Resolve the badge copy for one preset id.
 *
 * Precedence: a roster name (a declaration that publishes its own name) beats
 * the localized shipped-preset name, which beats the raw id. The title is the
 * roster description when there is one, otherwise the explanation sentence.
 *
 * @param {string} presetId preset id
 * @param {{id: string, name?: string, description?: string}[]|null|undefined} roster normalized rows
 * @param {(key: string) => string} t translator
 * @returns {{id: string, label: string, title: string}}
 */
function resolveModeLabel(presetId, roster, t) {
  const rows = Array.isArray(roster) ? roster : []
  const row = rows.find((candidate) => candidate?.id === presetId)
  const hint = typeof t === 'function' ? t(MODE_HINT_KEY) : MODE_HINT_KEY
  return {
    id: presetId,
    label: row?.name ?? builtInModeName(presetId, t) ?? presetId,
    title: row?.description ?? hint,
  }
}

module.exports = {
  BUILT_IN_MODE_KEYS,
  MODE_HINT_KEY,
  presetIdOfSession,
  modeRosterRows,
  resolveModeLabel,
}
