'use strict'

/**
 * The per-workspace layout registry: which tree exists for which workspace,
 * which one is visible, and how each tree is read from / written to storage.
 *
 * Extracted from `dsh-pane-host.js` so the controller reads as composition:
 * this module owns the layout bookkeeping and persistence, while the controller
 * owns dsh references, reconciliation and the public actions.
 *
 * Keys are workspace-scoped (`layout-store.js`, spec §9). A shell without a
 * workspaces service gets one memory-only layout under the internal
 * `UNSCOPED_WORKSPACE` key; it is never persisted or exposed as a workspace id.
 *
 * The visible workspace id has its own key (`dsh.hkcraft.active-workspace.v1`),
 * because per-workspace keys cannot say which tree was on screen. A fresh
 * registry starts from that hint, and `switchTo` / `setActiveWorkspace` keep it
 * current; disposal leaves it in storage for the next mount (ADR-0020).
 */

const layoutTree = require('./layout-tree.js')
const {
  clearActiveWorkspace,
  emptyLayout,
  pruneToKnownSessions,
  readActiveWorkspace,
  readLayout,
  removeLayout,
  writeActiveWorkspace,
  writeLayout,
} = require('./layout-store.js')

/**
 * Internal key for the memory-only layout used when no workspace can be
 * derived. It is not a workspace id: it never reaches storage or a slot prop.
 */
const UNSCOPED_WORKSPACE = '\u0000unscoped'

/**
 * @param {{storage?: any, nextPaneId?: () => string}} [options]
 * @returns {object} the layout registry
 */
function createPaneLayouts(options = {}) {
  const storage = options.storage
  const nextPaneId = typeof options.nextPaneId === 'function' ? options.nextPaneId : () => 'pane-1'

  /** @type {Record<string, object>} workspaceId → layout */
  let layouts = {}
  /** Memory-only layout for a shell without a workspaces service or a test fake. */
  let unscopedLayout = emptyLayout(null)
  /**
   * The workspace whose tree is visible. Initialised from the plugin's own
   * remembered id so a fresh controller can restore the view it was showing
   * instead of dsh's native selection (see `layout-store.js`).
   */
  let activeWorkspaceId = readActiveWorkspace(storage)

  /** @param {string|null} workspaceId */
  function layoutOf(workspaceId) {
    if (workspaceId === null) return unscopedLayout
    if (layouts[workspaceId] !== undefined) return layouts[workspaceId]
    return emptyLayout(workspaceId)
  }

  function activeLayout() {
    return layoutOf(activeWorkspaceId)
  }

  /** Every layout that currently owns panes, including the memory-only one. */
  function allLayouts() {
    const all = { ...layouts }
    if (unscopedLayout.root !== null || Object.keys(unscopedLayout.panes).length > 0) {
      all[UNSCOPED_WORKSPACE] = unscopedLayout
    }
    return all
  }

  /** The key the active layout lives under inside `allLayouts()`. */
  function activeKey() {
    return activeWorkspaceId === null ? UNSCOPED_WORKSPACE : activeWorkspaceId
  }

  function layoutsMap() {
    return layouts
  }

  function workspaceIds() {
    return Object.keys(layouts)
  }

  function hasWorkspace(workspaceId) {
    return layouts[workspaceId] !== undefined
  }

  function getActiveWorkspaceId() {
    return activeWorkspaceId
  }

  /**
   * Make one workspace visible and remember it for the next boot.
   *
   * `null` means "no workspace is visible" (the last one was deleted), which
   * removes the hint instead of leaving a ghost id behind.
   *
   * @param {string|null} workspaceId
   */
  function setActiveWorkspace(workspaceId) {
    activeWorkspaceId = workspaceId
    if (typeof workspaceId === 'string' && workspaceId !== '') writeActiveWorkspace(storage, workspaceId)
    else clearActiveWorkspace(storage)
  }

  /** Persist one workspace's layout; best-effort by design. */
  function persist(value) {
    writeLayout(storage, value)
  }

  /** Store one layout under a workspace (or the memory-only slot) and persist. */
  function store(workspaceId, value) {
    if (workspaceId === null) unscopedLayout = value
    else layouts = { ...layouts, [workspaceId]: value }
    persist(value)
  }

  /**
   * Restored pane ids came from a controller instance that knew nothing about
   * the other workspaces, so two keys can hold the same `pane-1`. Pane ids are
   * the renderer's element keys and the reference map's keys, so they must be
   * unique across all loaded workspaces.
   *
   * @param {string} workspaceId
   * @param {object} value
   * @returns {object}
   */
  function adoptPaneIds(workspaceId, value) {
    const taken = new Set()
    for (const [otherId, other] of Object.entries(allLayouts())) {
      if (otherId === workspaceId) continue
      for (const paneId of Object.keys(other.panes)) taken.add(paneId)
    }
    // Ids already in this layout are reserved too. `nextPaneId` only sees
    // layouts that are loaded, so the first free id it offers can be this
    // layout's own `pane-2`. Renaming the colliding `pane-1` onto that id
    // drops one of the two conversations.
    const reserved = new Set(taken)
    for (const paneId of Object.keys(value.panes ?? {})) reserved.add(paneId)
    const mapping = new Map()
    const allocate = () => {
      const seen = new Set()
      let next = nextPaneId()
      while (reserved.has(next)) {
        if (seen.has(next)) {
          let salt = 1
          let derived = `${next}~${salt}`
          while (reserved.has(derived)) {
            salt += 1
            derived = `${next}~${salt}`
          }
          return derived
        }
        seen.add(next)
        next = nextPaneId()
      }
      return next
    }
    for (const paneId of Object.keys(value.panes ?? {})) {
      if (!taken.has(paneId)) continue
      const next = allocate()
      reserved.add(next)
      mapping.set(paneId, next)
    }
    return mapping.size === 0 ? value : layoutTree.renamePanes(value, mapping)
  }

  /**
   * Load a workspace's layout the first time it is shown: read its scoped key,
   * reconcile against the live catalog, give restored panes globally unique ids
   * and make the pruned result the persisted truth.
   *
   * @param {string} workspaceId
   * @param {Set<string>|null} knownSessionIds `null` while the catalog is loading
   * @returns {boolean}
   */
  function ensureWorkspace(workspaceId, knownSessionIds) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    if (layouts[workspaceId] !== undefined) return true
    const restored = readLayout(storage, workspaceId, { knownSessionIds })
    const adopted = adoptPaneIds(workspaceId, restored)
    layouts = { ...layouts, [workspaceId]: adopted }
    persist(adopted)
    return true
  }

  /**
   * The pruned version of one loaded workspace's layout against the live
   * catalog, or null when nothing changes (or the catalog is not ready).
   *
   * Used when a catalog that was loading at restore time becomes ready: the
   * first read could not drop vanished sessions, so the prune has to re-run
   * (spec §9). The caller owns reconciliation and emission.
   *
   * @param {string} workspaceId
   * @param {Set<string>|null} knownSessionIds
   * @returns {object|null}
   */
  function pruneCandidate(workspaceId, knownSessionIds) {
    if (knownSessionIds === null) return null
    const current = layouts[workspaceId]
    if (current === undefined) return null
    const pruned = pruneToKnownSessions(current, knownSessionIds)
    return pruned === current ? null : pruned
  }

  /** @param {string} paneId */
  function locatePane(paneId) {
    const pane = unscopedLayout.panes[paneId]
    if (pane !== undefined) return { workspaceId: null, pane }
    for (const [workspaceId, value] of Object.entries(layouts)) {
      const found = value.panes[paneId]
      if (found !== undefined) return { workspaceId, pane: found }
    }
    return null
  }

  /** @param {string} sessionId @returns {{workspaceId: string|null, paneId: string}|null} */
  function locatePaneIn(sessionId) {
    const unscoped = layoutTree.paneOfSession(unscopedLayout, sessionId)
    if (unscoped !== undefined) return { workspaceId: null, paneId: unscoped }
    for (const [workspaceId, value] of Object.entries(layouts)) {
      const paneId = layoutTree.paneOfSession(value, sessionId)
      if (paneId !== undefined) return { workspaceId, paneId }
    }
    return null
  }

  /**
   * @param {Record<string, object>} nextLayouts
   * @param {string} paneId
   * @returns {string}
   */
  function workspaceOfPane(nextLayouts, paneId) {
    for (const [workspaceId, value] of Object.entries(nextLayouts)) {
      if (value.panes[paneId] !== undefined) return workspaceId
    }
    return ''
  }

  /**
   * The focused pane of the active workspace in a proposed layout map.
   *
   * @param {Record<string, object>} nextLayouts
   * @returns {{paneId: string, sessionId: string, view: string}|null}
   */
  function focusedPaneOf(nextLayouts) {
    const value = nextLayouts[activeKey()]
    if (value === undefined || value.activePaneId === null) return null
    return value.panes[value.activePaneId] ?? null
  }

  /**
   * Make a workspace visible without touching any tree. Returns the previous
   * key so the caller can roll back when its reconciliation refuses the switch.
   *
   * @param {string} workspaceId
   * @param {Set<string>|null} knownSessionIds
   * @returns {{previous: string|null, changed: boolean}|null}
   */
  function switchTo(workspaceId, knownSessionIds) {
    if (!ensureWorkspace(workspaceId, knownSessionIds)) return null
    const previous = activeWorkspaceId
    if (workspaceId === previous) return { previous, changed: false }
    setActiveWorkspace(workspaceId)
    return { previous, changed: true }
  }

  function clear() {
    layouts = {}
    unscopedLayout = emptyLayout(null)
    // Only the in-memory view is dropped. The active-workspace hint stays in
    // storage: a plugin reload builds a new registry and uses it to restore the
    // tree it was showing.
    activeWorkspaceId = null
  }

  /**
   * Drop one workspace's loaded layout and its persisted key.
   *
   * Called when the workspace registration itself is deleted: the
   * key must not outlive its workspace, or the "enabled" inference would
   * resurrect a ghost workspace after a restart. Deleting a workspace that was
   * never loaded still clears the key and reports that there was no layout to
   * drop, so deleting an unused workspace has no visible layout side effect.
   *
   * The active workspace is *not* changed here; the controller owns the
   * neighbour choice.
   *
   * @param {string} workspaceId
   * @returns {boolean} whether a loaded layout was dropped
   */
  function forget(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    removeLayout(storage, workspaceId)
    if (layouts[workspaceId] === undefined) return false
    const next = { ...layouts }
    delete next[workspaceId]
    layouts = next
    return true
  }

  return {
    UNSCOPED_WORKSPACE,
    layoutOf,
    activeLayout,
    allLayouts,
    activeKey,
    layoutsMap,
    workspaceIds,
    hasWorkspace,
    getActiveWorkspaceId,
    setActiveWorkspace,
    store,
    ensureWorkspace,
    switchTo,
    pruneCandidate,
    locatePane,
    locatePaneIn,
    workspaceOfPane,
    focusedPaneOf,
    forget,
    clear,
  }
}

module.exports = { UNSCOPED_WORKSPACE, createPaneLayouts }
