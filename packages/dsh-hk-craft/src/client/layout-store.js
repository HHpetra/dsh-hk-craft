'use strict'

/**
 * The per-workspace layout store: a versioned codec plus the narrow storage
 * seam. This module has no React, no DOM and no dsh imports.
 *
 * Why a key per workspace: `localStorage` is browser-origin-wide, so a single
 * shared key would let two workspaces overwrite each other's tree. Every entry
 * lives under `dsh.hkcraft.layout.v1.<workspaceId>` (spec §9).
 *
 * Payload (one JSON string per key):
 *
 *   {
 *     version: 1,
 *     root: LayoutNode | null,
 *     panes: { [paneId]: { paneId, sessionId, view } },
 *     activePaneId: string | null,
 *   }
 *
 * The workspace id is *not* duplicated in the payload: it lives in the key and
 * is the argument `decodeLayout` labels the result with. A payload carrying a
 * foreign `workspaceId` cannot leak its scope.
 *
 * `decodeLayout` is the boot safety net: a corrupt, truncated, missing-field or
 * version-mismatched payload decodes to the workspace's empty layout, never to
 * a throw. Reconciliation against the live session catalog happens here too,
 * because "the session no longer exists" is a decode-time fact:
 * - panes whose `sessionId` is not in `knownSessionIds` are dropped;
 * - a session mounted twice keeps only its first pane (spec §4.4: 1:1);
 * - the tree is normalised (duplicate leaves pruned, ratios clamped, focus
 *   repaired) by `layout-tree.js`.
 *
 * Passing `knownSessionIds: null`/`undefined` means "the catalog is not ready
 * yet", and keeps every pane instead of guessing.
 */

const layoutTree = require('./layout-tree.js')

/** Prefix of every workspace-scoped layout key; the trailing dot is required. */
const LAYOUT_KEY_PREFIX = 'dsh.hkcraft.layout.v1.'

/**
 * The workspace whose tree was last visible.
 *
 * The per-workspace keys above cannot say which tree the user was looking at,
 * so a fresh controller (a dsh restart, or a plugin reload while the app keeps
 * running) had to guess from dsh's "current session". That guess follows the
 * native selection, which can be an older conversation than the one a pane was
 * showing. This key records the plugin's own answer; it is only a hint, and
 * every read validates it against the catalog before it is used.
 */
const ACTIVE_WORKSPACE_KEY = 'dsh.hkcraft.active-workspace.v1'

/** The payload version. Kept equal to the layout's own structural version. */
const LAYOUT_PAYLOAD_VERSION = layoutTree.LAYOUT_VERSION

/**
 * @param {unknown} workspaceId
 * @returns {string|null} the scoped storage key, or null when there is no workspace
 */
function layoutKey(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') return null
  return `${LAYOUT_KEY_PREFIX}${workspaceId}`
}

/**
 * @param {string|null} [workspaceId]
 * @returns {object} the layout for a workspace with nothing open
 */
function emptyLayout(workspaceId = null) {
  return layoutTree.createLayout(typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : null)
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>|null}
 */
function parsePayload(value) {
  let parsed = value
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    try {
      parsed = JSON.parse(value)
    } catch (_error) {
      return null
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

/**
 * Rebuild pane records from the map keys. The key is authoritative, so a
 * payload whose records disagree with their keys still decodes safely, and a
 * record without a usable `sessionId` is unusable at restore time and dropped.
 *
 * @param {unknown} panes
 * @returns {Record<string, {paneId: string, sessionId: string, view: string}>}
 */
function panesFrom(panes) {
  if (panes === null || typeof panes !== 'object' || Array.isArray(panes)) return {}
  const rebuilt = {}
  for (const [paneId, value] of Object.entries(panes)) {
    if (paneId === '' || value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.sessionId !== 'string' || value.sessionId === '') continue
    rebuilt[paneId] = {
      paneId,
      sessionId: value.sessionId,
      view: value.view === 'trajectory' ? 'trajectory' : layoutTree.DEFAULT_VIEW,
    }
  }
  return rebuilt
}

/**
 * Encode a layout for persistence. The payload is normalised first, so a stale
 * ratio or a foreign extra field can never be written back.
 *
 * @param {object|null|undefined} layout
 * @returns {string|null} JSON string, or null when the value is not a layout
 */
function encodeLayout(layout) {
  if (layout === null || layout === undefined || typeof layout !== 'object') return null
  if (Array.isArray(layout)) return null
  const normalized = layoutTree.normalizeLayout(layout)
  return JSON.stringify({
    version: LAYOUT_PAYLOAD_VERSION,
    root: normalized.root,
    panes: normalized.panes,
    activePaneId: normalized.activePaneId,
  })
}

/**
 * Drop panes whose session is not in the live catalog, and keep only the first
 * pane of a session mounted twice (spec §4.4). A `null`/`undefined` catalog
 * means "not ready yet": unknown-session pruning waits, but the 1:1 duplicate
 * rule still applies because it never depends on the catalog.
 *
 * Pure and idempotent: it returns the same object when nothing changed. Used at
 * decode time and again by the pane controller when a catalog that was loading
 * becomes ready (spec §9).
 *
 * @param {object} layout normalized layout
 * @param {Set<string>|null|undefined} knownSessionIds
 * @returns {object}
 */
function pruneToKnownSessions(layout, knownSessionIds) {
  if (layout === null || typeof layout !== 'object') return layout
  const known = knownSessionIds instanceof Set ? knownSessionIds : null
  const seenSessions = new Set()
  const surviving = {}
  for (const paneId of layoutTree.leaves(layout.root)) {
    const pane = layout.panes?.[paneId]
    if (pane === undefined) continue
    if (known !== null && !known.has(pane.sessionId)) continue
    if (seenSessions.has(pane.sessionId)) continue
    seenSessions.add(pane.sessionId)
    surviving[paneId] = pane
  }

  const total = Object.keys(layout.panes ?? {}).length
  if (Object.keys(surviving).length === total) return layout
  return layoutTree.normalizeLayout({ ...layout, panes: surviving })
}

/**
 * Decode one stored payload into a safe layout. Never throws.
 *
 * @param {unknown} raw string from storage (a parsed object is accepted too)
 * @param {{workspaceId?: string|null, knownSessionIds?: Set<string>|null}} [options]
 *   `knownSessionIds` is the live catalog; omit or pass null while it is loading.
 * @returns {object} always a normalized layout, empty when nothing survives
 */
function decodeLayout(raw, options = {}) {
  const workspaceId =
    typeof options.workspaceId === 'string' && options.workspaceId !== '' ? options.workspaceId : null
  if (workspaceId === null) return emptyLayout(null)

  const payload = parsePayload(raw)
  if (payload === null || payload.version !== LAYOUT_PAYLOAD_VERSION) return emptyLayout(workspaceId)

  const panes = panesFrom(payload.panes)
  if (Object.keys(panes).length === 0) return emptyLayout(workspaceId)

  const layout = layoutTree.normalizeLayout({
    version: LAYOUT_PAYLOAD_VERSION,
    workspaceId,
    root: payload.root ?? null,
    panes,
    activePaneId: typeof payload.activePaneId === 'string' ? payload.activePaneId : null,
  })

  return pruneToKnownSessions(layout, options.knownSessionIds)
}

/**
 * Whether a workspace has ever been opened in split, judged by the mere
 * existence of its layout key. The value is deliberately not parsed: the sidebar
 * light only needs "there is a record", and a corrupt payload still proves the
 * workspace was opened. A broken store reports `false` instead of
 * throwing, which degrades to "not enabled" only for that one workspace.
 *
 * @param {{getItem?: (key: string) => unknown}|undefined|null} storage
 * @param {string} workspaceId
 * @returns {boolean}
 */
function hasLayoutKey(storage, workspaceId) {
  const key = layoutKey(workspaceId)
  if (key === null) return false
  try {
    if (typeof storage?.getItem !== 'function') return false
    const raw = storage.getItem(key)
    return raw !== null && raw !== undefined
  } catch (_error) {
    return false
  }
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function usableId(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The workspace id remembered by `writeActiveWorkspace`, or null.
 *
 * Best-effort like every other read here: a disabled or throwing store simply
 * means "no hint", and the controller falls back to the shell's current session.
 *
 * @param {{getItem?: (key: string) => unknown}|undefined|null} storage
 * @returns {string|null}
 */
function readActiveWorkspace(storage) {
  try {
    if (typeof storage?.getItem !== 'function') return null
    return usableId(storage.getItem(ACTIVE_WORKSPACE_KEY))
  } catch (_error) {
    return null
  }
}

/**
 * Remember the visible workspace. Only an id is stored, never a layout: the
 * restore path still reads the per-workspace key and validates it against the
 * catalog.
 *
 * @param {{setItem?: (key: string, value: string) => unknown}|undefined|null} storage
 * @param {unknown} workspaceId
 * @returns {boolean} whether the write was attempted without throwing
 */
function writeActiveWorkspace(storage, workspaceId) {
  const id = usableId(workspaceId)
  if (id === null) return false
  if (typeof storage?.setItem !== 'function') return false
  try {
    storage.setItem(ACTIVE_WORKSPACE_KEY, id)
    return true
  } catch (_error) {
    return false
  }
}

/**
 * Forget the visible workspace, for when it no longer exists.
 *
 * @param {{removeItem?: (key: string) => unknown}|undefined|null} storage
 * @returns {boolean} whether the removal was attempted without throwing
 */
function clearActiveWorkspace(storage) {
  if (typeof storage?.removeItem !== 'function') return false
  try {
    storage.removeItem(ACTIVE_WORKSPACE_KEY)
    return true
  } catch (_error) {
    return false
  }
}

/**
 * Read one workspace's layout through the storage seam.
 *
 * @param {{getItem?: (key: string) => unknown}|undefined|null} storage
 * @param {string} workspaceId
 * @param {{knownSessionIds?: Set<string>|null}} [options]
 * @returns {object} a layout; the workspace's empty layout when absent or broken
 */
function readLayout(storage, workspaceId, options = {}) {
  const key = layoutKey(workspaceId)
  if (key === null) return emptyLayout(null)
  let raw = null
  try {
    if (typeof storage?.getItem === 'function') raw = storage.getItem(key)
  } catch (_error) {
    // Private-mode storage and quota errors must not break boot.
    raw = null
  }
  return decodeLayout(raw, { ...options, workspaceId })
}

/**
 * Write one workspace's layout. Failures (quota, disabled storage, no key) are
 * reported as `false` and never thrown: persisting is best-effort.
 *
 * @param {{setItem?: (key: string, value: string) => unknown}|undefined|null} storage
 * @param {object} layout
 * @returns {boolean}
 */
function writeLayout(storage, layout) {
  const key = layoutKey(layout?.workspaceId)
  if (key === null) return false
  const raw = encodeLayout(layout)
  if (raw === null) return false
  if (typeof storage?.setItem !== 'function') return false
  try {
    storage.setItem(key, raw)
    return true
  } catch (_error) {
    return false
  }
}

/**
 * Remove one workspace's persisted layout. Used when the workspace itself is
 * deleted: the key must not outlive its workspace, or the "enabled" inference
 * (`hasLayout`) would resurrect a ghost workspace on the next boot.
 *
 * Failures (no store, no `removeItem`, a locked-down store) are reported as
 * `false` and never thrown: cleanup is best-effort, exactly like writing.
 *
 * @param {{removeItem?: (key: string) => unknown}|undefined|null} storage
 * @param {unknown} workspaceId
 * @returns {boolean} whether a removal was attempted without throwing
 */
function removeLayout(storage, workspaceId) {
  const key = layoutKey(workspaceId)
  if (key === null) return false
  if (typeof storage?.removeItem !== 'function') return false
  try {
    storage.removeItem(key)
    return true
  } catch (_error) {
    return false
  }
}

module.exports = {
  LAYOUT_KEY_PREFIX,
  LAYOUT_PAYLOAD_VERSION,
  ACTIVE_WORKSPACE_KEY,
  layoutKey,
  emptyLayout,
  encodeLayout,
  decodeLayout,
  pruneToKnownSessions,
  hasLayoutKey,
  readActiveWorkspace,
  writeActiveWorkspace,
  clearActiveWorkspace,
  readLayout,
  writeLayout,
  removeLayout,
}
