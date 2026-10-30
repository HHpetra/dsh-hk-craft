'use strict'

/**
 * Project a layout tree onto flat, fractional rectangles.
 *
 * The renderer draws every pane as an absolutely positioned sibling, keyed by
 * `paneId`, and only their inline styles change when the tree changes. That is
 * the mechanism that keeps a conversation mounted across splits and closes:
 * React never re-parents a pane, so streaming output, scroll position and the
 * composer draft survive (spec §4.3, issue 05 "窗格内容在布局变化时不卸载").
 *
 * Rectangles use fractions of the workspace box (0..1), rounded to 1e-6 so a
 * percentage style and a test expectation agree. No DOM, no measurement here:
 * the pixel minimum is a drag-time concern (`ratioFromDrag`).
 */

const { clampRatio } = require('./layout-tree.js')

/** Hit area of a separator in CSS pixels; the visible line is thinner. */
const SEPARATOR_HIT_PX = 8

/** The visible separator line in CSS pixels. */
const SEPARATOR_LINE_PX = 2

/** Fractions are projected to percentages; 1e-6 is far below one pixel. */
function round(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 * @typedef {{paneId: string, x: number, y: number, width: number, height: number}} PaneRect
 * @typedef {{path: string[], dir: 'row'|'col', x: number, y: number, width: number, height: number, ratio: number, extent: number}} SeparatorRect
 */

/**
 * @param {object|null} root
 * @returns {{panes: PaneRect[], separators: SeparatorRect[]}}
 */
function computeLayout(root) {
  /** @type {PaneRect[]} */
  const panes = []
  /** @type {SeparatorRect[]} */
  const separators = []
  if (root === null || root === undefined || typeof root !== 'object') {
    return { panes, separators }
  }

  /**
   * @param {object} node
   * @param {{x: number, y: number, width: number, height: number}} rect
   * @param {string[]} path
   */
  const walk = (node, rect, path) => {
    if (node === null || typeof node !== 'object') return
    if (node.kind === 'leaf') {
      if (typeof node.paneId !== 'string' || node.paneId === '') return
      panes.push({
        paneId: node.paneId,
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      })
      return
    }
    if (node.kind !== 'split') return
    const ratio = clampRatio(node.ratio)
    if (node.dir === 'row') {
      const first = rect.width * ratio
      walk(node.a, { x: rect.x, y: rect.y, width: first, height: rect.height }, [...path, 'a'])
      walk(node.b, { x: rect.x + first, y: rect.y, width: rect.width - first, height: rect.height }, [
        ...path,
        'b',
      ])
      separators.push({
        path,
        dir: 'row',
        x: round(rect.x + first),
        y: round(rect.y),
        width: 0,
        height: round(rect.height),
        ratio,
        // The split's own size along the drag axis, as a workspace fraction:
        // the pixel minimum must be clamped against the split, not the box.
        extent: round(rect.width),
      })
      return
    }
    const first = rect.height * ratio
    walk(node.a, { x: rect.x, y: rect.y, width: rect.width, height: first }, [...path, 'a'])
    walk(node.b, { x: rect.x, y: rect.y + first, width: rect.width, height: rect.height - first }, [
      ...path,
      'b',
    ])
    separators.push({
      path,
      dir: 'col',
      x: round(rect.x),
      y: round(rect.y + first),
      width: round(rect.width),
      height: 0,
      ratio,
      extent: round(rect.height),
    })
  }

  walk(root, { x: 0, y: 0, width: 1, height: 1 }, [])
  return { panes, separators }
}

module.exports = { SEPARATOR_HIT_PX, SEPARATOR_LINE_PX, computeLayout }
