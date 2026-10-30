'use strict'

/**
 * The pane layout tree: pure data and pure transitions.
 *
 * One `WorkspaceLayout` per workspace (spec §4.1):
 *
 *   LayoutNode = { kind: 'leaf', paneId }
 *              | { kind: 'split', dir: 'row'|'col', ratio, a, b }
 *   Pane       = { paneId, sessionId, view }
 *   Layout     = { version: 1, workspaceId, root, panes, activePaneId }
 *
 * Invariants every function here preserves:
 * - `layout.panes` keys equal the leaf `paneId`s in `layout.root` (or both are
 *   empty when `root` is null);
 * - `layout.activePaneId` is a live panes key whenever panes exist;
 * - every split `ratio` stays inside `[MIN_RATIO, 1 - MIN_RATIO]`, so a dragged
 *   separator can never collapse a pane to zero;
 * - nothing mutates its input: an unchanged transition returns the same object,
 *   a changed one returns a structurally new layout.
 *
 * This module has no React, no DOM and no dsh imports.
 */

const LAYOUT_VERSION = 1

/**
 * The structural floor for a split ratio. Geometry also clamps against a pixel
 * minimum (`minRatioFor`); this constant is the size-independent backstop.
 */
const MIN_RATIO = 0.1

/** The smallest useful pane, in CSS pixels, for the pixel-aware clamp. */
const MIN_PANE_PX = 120

/** Panes start on the conversation view; the view toggle (ticket 07) owns changes. */
const DEFAULT_VIEW = 'chat'

/** @param {string} paneId @returns {{kind: 'leaf', paneId: string}} */
function leafNode(paneId) {
  return { kind: 'leaf', paneId }
}

/** @param {'row'|'col'} dir @param {number} ratio @param {object} a @param {object} b */
function splitNode(dir, ratio, a, b) {
  return { kind: 'split', dir, ratio, a, b }
}

/**
 * @param {string|null} workspaceId
 * @returns {{version: number, workspaceId: string|null, root: null, panes: Record<string, object>, activePaneId: null}}
 */
function createLayout(workspaceId = null) {
  return {
    version: LAYOUT_VERSION,
    workspaceId,
    root: null,
    panes: {},
    activePaneId: null,
  }
}

/**
 * Leaves in render order: depth-first, left→right for a row split, top→bottom
 * for a column split (spec §4.1 — the same order the tab strip uses).
 *
 * @param {object|null} root
 * @returns {string[]}
 */
function leaves(root) {
  /** @type {string[]} */
  const ordered = []
  if (root === null || root === undefined) return ordered
  const walk = (node) => {
    if (node.kind === 'leaf') {
      ordered.push(node.paneId)
      return
    }
    walk(node.a)
    walk(node.b)
  }
  walk(root)
  return ordered
}

/**
 * The a/b steps from the root to a leaf, or null when the pane is absent.
 *
 * @param {object|null} root
 * @param {string} paneId
 * @returns {string[]|null}
 */
function findLeafPath(root, paneId) {
  if (root === null || root === undefined) return null
  const walk = (node, path) => {
    if (node.kind === 'leaf') return node.paneId === paneId ? path : null
    return walk(node.a, [...path, 'a']) ?? walk(node.b, [...path, 'b'])
  }
  return walk(root, [])
}

/**
 * Replace the leaf at `path` with `replacement`, copying only that spine.
 *
 * @param {object} root
 * @param {string[]} path a/b steps
 * @param {object|null} replacement
 * @returns {object|null}
 */
function replaceAtPath(root, path, replacement) {
  if (path.length === 0) return replacement
  const [step, ...rest] = path
  if (root.kind === 'leaf') return root
  const child = replaceAtPath(step === 'a' ? root.a : root.b, rest, replacement)
  return step === 'a' ? { ...root, a: child } : { ...root, b: child }
}

/**
 * Open the first pane of an empty layout. With panes already open this is a
 * no-op: adding a pane to a live tree is `split`'s job.
 *
 * @param {object} layout
 * @param {{paneId: string, sessionId: string, view?: string}} pane
 * @returns {object}
 */
function openPane(layout, pane) {
  if (layout.root !== null) return layout
  return {
    ...layout,
    root: leafNode(pane.paneId),
    panes: { [pane.paneId]: normalizePane(pane) },
    activePaneId: pane.paneId,
  }
}

/**
 * Split `paneId` beside itself: the original leaf keeps its place as `a`, the
 * new pane becomes `b` (right / bottom) and takes the focus. The new pane is
 * passed in whole because creating its session is the host's job, not this
 * module's.
 *
 * @param {object} layout
 * @param {string} paneId
 * @param {'row'|'col'} dir
 * @param {{paneId: string, sessionId: string, view?: string}} pane
 * @returns {object}
 */
function split(layout, paneId, dir, pane) {
  if (dir !== 'row' && dir !== 'col') return layout
  if (layout.panes[paneId] === undefined) return layout
  if (pane === null || typeof pane !== 'object') return layout
  if (typeof pane.paneId !== 'string' || pane.paneId === '') return layout
  if (layout.panes[pane.paneId] !== undefined) return layout
  const path = findLeafPath(layout.root, paneId)
  if (path === null) return layout
  return {
    ...layout,
    root: replaceAtPath(
      layout.root,
      path,
      splitNode(dir, 0.5, leafNode(paneId), leafNode(pane.paneId)),
    ),
    panes: { ...layout.panes, [pane.paneId]: normalizePane(pane) },
    activePaneId: pane.paneId,
  }
}

/**
 * Close a pane. Its sibling subtree takes the parent's place — recursively, so
 * a nested close never leaves a blank cell — and the focus moves to the leaf
 * that ended up where the closed pane was. Closing the last pane empties the
 * layout (the workspace renders its empty state).
 *
 * The tree is re-normalised afterwards, which is also what prunes a leaf whose
 * pane record has gone. Session shutdown is the host's job (ticket 09): this is
 * a pure structural transition.
 *
 * @param {object} layout
 * @param {string} paneId
 * @returns {object}
 */
function close(layout, paneId) {
  if (layout.panes[paneId] === undefined) return layout
  const path = findLeafPath(layout.root, paneId)
  if (path === null) return layout

  const panes = { ...layout.panes }
  delete panes[paneId]

  // The promoted sibling is the geometric neighbour: the first leaf of the
  // subtree below (when the closed leaf was on top / on the left) or its last
  // leaf (when it was at the bottom / on the right).
  let neighbour = null
  if (path.length > 0) {
    const parent = nodeAtPath(layout.root, path.slice(0, -1))
    if (parent !== null && parent.kind === 'split') {
      const sibling = path[path.length - 1] === 'a' ? parent.b : parent.a
      neighbour = path[path.length - 1] === 'a' ? firstLeaf(sibling) : lastLeaf(sibling)
    }
  }

  const root = normalizeNode(layout.root, panes)
  const ordered = leaves(root)
  const activePaneId =
    layout.activePaneId === paneId || !ordered.includes(layout.activePaneId)
      ? neighbour !== null && ordered.includes(neighbour)
        ? neighbour
        : (ordered[0] ?? null)
      : layout.activePaneId

  return { ...layout, root, panes, activePaneId }
}

/**
 * Clamp a split ratio into the usable band. Degenerate input (NaN, ±Infinity,
 * a string, an out-of-range number) becomes the neutral 0.5 before clamping,
 * so a corrupted persisted ratio can never hide a pane.
 *
 * @param {unknown} ratio
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {number}
 */
function clampRatio(ratio, bounds = {}) {
  const min = typeof bounds.min === 'number' ? bounds.min : MIN_RATIO
  const max = typeof bounds.max === 'number' ? bounds.max : 1 - MIN_RATIO
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 0.5
  return Math.min(max, Math.max(min, ratio))
}

/**
 * The smallest ratio a split of `sizePx` may have while both sides still clear
 * the pixel minimum. A split smaller than `minPanePx` collapses to a 50/50
 * band, which is the best a pixel floor can do at that size.
 *
 * @param {number} sizePx
 * @param {number} [minPanePx]
 * @returns {number}
 */
function minRatioFor(sizePx, minPanePx = MIN_PANE_PX) {
  if (typeof sizePx !== 'number' || !Number.isFinite(sizePx) || sizePx <= 0) return MIN_RATIO
  return clampRatio(minPanePx / sizePx, { min: MIN_RATIO, max: 0.5 })
}

/**
 * The ratio a separator drag lands on: the starting ratio plus the pointer
 * delta over the split's own size, clamped by the pixel minimum.
 *
 * @param {{startRatio: number, deltaPx: number, sizePx: number, minPanePx?: number}} input
 * @returns {number}
 */
function ratioFromDrag({ startRatio, deltaPx, sizePx, minPanePx = MIN_PANE_PX }) {
  const start = clampRatio(startRatio)
  if (typeof sizePx !== 'number' || !Number.isFinite(sizePx) || sizePx <= 0) return start
  const delta = typeof deltaPx === 'number' && Number.isFinite(deltaPx) ? deltaPx : 0
  const min = minRatioFor(sizePx, minPanePx)
  return clampRatio(start + delta / sizePx, { min, max: 1 - min })
}

/**
 * Resize one split. `path` addresses the split node with a/b steps from the
 * root (the same paths the renderer walks); the ratio is clamped, and an
 * unchanged ratio returns the same object so subscribers can skip a render.
 *
 * @param {object} layout
 * @param {string[]} path
 * @param {number} ratio
 * @returns {object}
 */
function resize(layout, path, ratio) {
  if (!Array.isArray(path)) return layout
  const node = nodeAtPath(layout.root, path)
  if (node === null || node.kind !== 'split') return layout
  const next = clampRatio(ratio)
  if (next === node.ratio) return layout
  return { ...layout, root: replaceAtPath(layout.root, path, { ...node, ratio: next }) }
}

/**
 * Re-validate a layout that came from storage or from a caller: clamp every
 * ratio, drop leaves whose pane record is gone (the sibling promotes), drop
 * orphan pane records, and repair the focus. This is the decode seam for the
 * per-workspace store (ticket 08).
 *
 * @param {object} layout
 * @returns {object}
 */
function normalizeLayout(layout) {
  const panes = layout !== null && typeof layout.panes === 'object' && layout.panes !== null ? layout.panes : {}
  const root = normalizeNode(layout?.root ?? null, panes)
  const ordered = leaves(root)
  const kept = {}
  for (const paneId of ordered) kept[paneId] = normalizePane(panes[paneId])
  const activePaneId = ordered.includes(layout?.activePaneId) ? layout.activePaneId : (ordered[0] ?? null)
  return {
    version: LAYOUT_VERSION,
    workspaceId: typeof layout?.workspaceId === 'string' ? layout.workspaceId : null,
    root,
    panes: kept,
    activePaneId,
  }
}

/**
 * @param {object|null} node
 * @param {Record<string, object>} panes
 * @returns {object|null}
 */
function normalizeNode(node, panes) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.kind === 'leaf') {
    return panes[node.paneId] === undefined ? null : { kind: 'leaf', paneId: node.paneId }
  }
  if (node.kind !== 'split') return null
  const a = normalizeNode(node.a, panes)
  const b = normalizeNode(node.b, panes)
  if (a === null) return b
  if (b === null) return a
  return {
    kind: 'split',
    dir: node.dir === 'col' ? 'col' : 'row',
    ratio: clampRatio(node.ratio),
    a,
    b,
  }
}

/**
 * @param {object|null} root
 * @param {string[]} path
 * @returns {object|null}
 */
function nodeAtPath(root, path) {
  let node = root
  for (const step of path) {
    if (node === null || node === undefined || node.kind !== 'split') return null
    node = step === 'a' ? node.a : node.b
  }
  return node ?? null
}

/** @param {object} node @returns {string|null} */
function firstLeaf(node) {
  let current = node
  while (current !== null && current !== undefined) {
    if (current.kind === 'leaf') return current.paneId
    current = current.a
  }
  return null
}

/** @param {object} node @returns {string|null} */
function lastLeaf(node) {
  let current = node
  while (current !== null && current !== undefined) {
    if (current.kind === 'leaf') return current.paneId
    current = current.b
  }
  return null
}

/**
 * Move the focus to an existing pane. `activePaneId` is what the renderer draws
 * a focus ring on and what the host retains as `mainView`.
 *
 * @param {object} layout
 * @param {string} paneId
 * @returns {object}
 */
function focus(layout, paneId) {
  if (layout.panes[paneId] === undefined) return layout
  if (layout.activePaneId === paneId) return layout
  return { ...layout, activePaneId: paneId }
}

/**
 * Replace one pane's session in place. The pane id — and therefore the tree
 * shape, the focus and the mounted React element — is unchanged; this is the
 * pane-aware `/resume` and `/clear` transition.
 *
 * @param {object} layout
 * @param {string} paneId
 * @param {string} sessionId
 * @returns {object}
 */
function replaceSession(layout, paneId, sessionId) {
  const pane = layout.panes[paneId]
  if (pane === undefined) return layout
  if (typeof sessionId !== 'string' || sessionId === '') return layout
  if (pane.sessionId === sessionId) return layout
  return { ...layout, panes: { ...layout.panes, [paneId]: { ...pane, sessionId } } }
}

/**
 * Remember which conversation view a pane shows (ticket 07 drives this; the
 * state lives here so it is per pane and persists with the layout).
 *
 * @param {object} layout
 * @param {string} paneId
 * @param {'chat'|'trajectory'} view
 * @returns {object}
 */
function setView(layout, paneId, view) {
  const pane = layout.panes[paneId]
  if (pane === undefined) return layout
  if (view !== 'chat' && view !== 'trajectory') return layout
  if (pane.view === view) return layout
  return { ...layout, panes: { ...layout.panes, [paneId]: { ...pane, view } } }
}

/**
 * The pane currently showing `sessionId`, if any. A session is mounted in at
 * most one pane (spec §4.4), so a second open request focuses the holder
 * instead of mounting the same conversation twice.
 *
 * @param {object} layout
 * @param {string} sessionId
 * @returns {string|undefined}
 */
function paneOfSession(layout, sessionId) {
  for (const pane of Object.values(layout.panes)) {
    if (pane.sessionId === sessionId) return pane.paneId
  }
  return undefined
}

/** @param {{paneId: string, sessionId: string, view?: string}} pane */
function normalizePane(pane) {
  return {
    paneId: pane.paneId,
    sessionId: pane.sessionId,
    view: pane.view === 'trajectory' ? 'trajectory' : DEFAULT_VIEW,
  }
}

module.exports = {
  LAYOUT_VERSION,
  MIN_RATIO,
  MIN_PANE_PX,
  DEFAULT_VIEW,
  leafNode,
  splitNode,
  createLayout,
  leaves,
  findLeafPath,
  openPane,
  split,
  close,
  focus,
  resize,
  clampRatio,
  minRatioFor,
  ratioFromDrag,
  normalizeLayout,
  replaceSession,
  setView,
  paneOfSession,
}
