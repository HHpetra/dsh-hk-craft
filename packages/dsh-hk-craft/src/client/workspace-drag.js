'use strict'

/**
 * The workspace row drag gesture: pointer capture, hit testing, the insertion
 * indicator and click suppression after a drop.
 *
 * This is the one part of `sidebar-workspaces.js` that changes for pointer
 * reasons rather than rendering reasons, so it lives in its own hook. The math
 * it applies (threshold, which half of a row, the host anchor) is pure and lives
 * in `workspace-reorder.js`; the host is the only order writer, so nothing here
 * stores an order.
 *
 * The hook is deliberately dumb about failure: it calls `onReorderStart` before a
 * write and `onReorderError(reason)` if the host rejects, leaving the copy and
 * the error line to the section.
 */

const { crossedDragThreshold, dropAnchor, dropSideFor } = require('./workspace-reorder.js')

/**
 * True when the press belongs to a row action. The action slot holds the delete
 * entry; pressing anywhere in it must neither begin a drag nor swallow the
 * action's own click.
 *
 * @param {any} target pointer event target
 * @returns {boolean}
 */
function insideWorkspaceAction(target) {
  return typeof target?.closest === 'function' && target.closest('[data-hkcraft-workspace-action]') !== null
}

/**
 * The workspace row under the pointer and its box, or null. Pointer capture
 * keeps the move events on the dragged row, so the drop target has to be
 * hit-tested from the pointer coordinates (same approach as the pane strip).
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ workspaceId: string, rect: { top: number, height: number } | null } | null}
 */
function workspaceRowAt(clientX, clientY) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null
  const element = document.elementFromPoint(clientX, clientY)
  if (typeof element?.closest !== 'function') return null
  const row = element.closest('[data-hkcraft-workspace-row]')
  const workspaceId = row?.getAttribute?.('data-hkcraft-workspace-row')
  if (typeof workspaceId !== 'string' || workspaceId === '') return null
  const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null
  return { workspaceId, rect }
}

/**
 * The row-under-pointer drop for one drag, or null when it is not a position
 * change.
 *
 * @param {ReadonlyArray<string>} order host order
 * @param {string} sourceId dragged workspace
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ targetId: string, side: 'before'|'after' } | null}
 */
function dropTargetFor(order, sourceId, clientX, clientY) {
  const over = workspaceRowAt(clientX, clientY)
  if (over === null || over.workspaceId === sourceId) return null
  const side = dropSideFor(over.rect, clientY)
  if (side === null) return null
  if (dropAnchor(order, sourceId, over.workspaceId, side) === null) return null
  return { targetId: over.workspaceId, side }
}

/**
 * The drag gesture for one workspace section.
 *
 * @param {any} React the lazily resolved platform module
 * @param {{
 *   order: ReadonlyArray<string>,
 *   reorderWorkspace?: (workspaceId: string, beforeWorkspaceId?: string) => unknown,
 *   onReorderStart?: () => void,
 *   onReorderError?: (reason: unknown) => void,
 * }} options
 * @returns {{
 *   drag: { sourceId: string, targetId: string|null, side: 'before'|'after'|null } | null,
 *   reordering: boolean,
 *   consumeSuppressedClick: () => boolean,
 *   onRowPointerDown: (row: { workspaceId: string }) => (event: any) => void,
 *   onRowPointerMove: (event: any) => void,
 *   onRowPointerUp: (event: any) => void,
 *   onRowPointerCancel: (event: any) => void,
 * }}
 */
function useWorkspaceDrag(React, options) {
  const order = Array.isArray(options?.order) ? options.order : []
  const reorderWorkspace = options?.reorderWorkspace
  const [drag, setDrag] = React.useState(null)
  const [reordering, setReordering] = React.useState(false)
  /** The in-flight press; `drag` state above only drives the visible feedback. */
  const dragRef = React.useRef(null)
  /** A drag's pointerup is followed by a click; that click must not open a row. */
  const suppressClick = React.useRef(false)
  /** One reorder request at a time; the ref is the synchronous guard. */
  const reorderBusy = React.useRef(false)

  const clearDrag = () => {
    dragRef.current = null
    setDrag(null)
  }

  /**
   * Send one reorder to the host. The host persists the order and reinstalls its
   * committed order if the write fails; this component keeps no local order, so
   * a failure only has to be shown.
   */
  const submitReorder = (sourceId, beforeId) => {
    if (reorderBusy.current) return
    if (typeof reorderWorkspace !== 'function') return
    reorderBusy.current = true
    setReordering(true)
    options?.onReorderStart?.()
    let pending
    try {
      // Start the write on drop, not a microtask later: the busy guard must
      // already be visible to the next pointerdown.
      pending = Promise.resolve(reorderWorkspace(sourceId, beforeId))
    } catch (reason) {
      pending = Promise.reject(reason)
    }
    pending
      .catch((reason) => {
        options?.onReorderError?.(reason)
      })
      .then(() => {
        reorderBusy.current = false
        setReordering(false)
      })
  }

  const onRowPointerDown = (row) => (event) => {
    if (event.button !== undefined && event.button !== 0) return
    if (insideWorkspaceAction(event.target)) return
    if (reorderBusy.current) return
    // Do NOT capture the pointer here. The select control is a child of the
    // row, and pointer capture retargets the compatibility click to the capture
    // element: capturing the row on pointerdown made a normal click land on the
    // row (which has no onClick) instead of the select button, so clicking a
    // workspace never reached `openWorkspace`. Capture only once the press has
    // actually become a drag; a click below the threshold stays a plain click.
    dragRef.current = {
      sourceId: row.workspaceId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      captured: false,
      targetId: null,
      side: null,
    }
  }

  const onRowPointerMove = (event) => {
    const current = dragRef.current
    if (current === null) return
    if (!current.active && !crossedDragThreshold(current.startX, current.startY, event.clientX, event.clientY)) {
      return
    }
    const entering = !current.active
    if (entering) {
      current.active = true
      // Pointer capture keeps the move events on the source row while it is
      // being dragged. Doing it at drag start (not at pointerdown) preserves
      // the click target for a press that never becomes a drag.
      try {
        event.currentTarget?.setPointerCapture?.(current.pointerId)
        current.captured = typeof event.currentTarget?.setPointerCapture === 'function'
      } catch (_error) {
        // A pointer that already ended cannot be captured; the drag simply
        // falls back to the events that still reach the row.
        current.captured = false
      }
    }
    const target = dropTargetFor(order, current.sourceId, event.clientX, event.clientY)
    const targetId = target === null ? null : target.targetId
    const side = target === null ? null : target.side
    // Entering drag mode is itself a change: the source row must dim even when
    // the pointer is not over another row yet.
    const changed = entering || targetId !== current.targetId || side !== current.side
    current.targetId = targetId
    current.side = side
    if (changed) setDrag({ sourceId: current.sourceId, targetId, side })
    event.preventDefault()
  }

  const onRowPointerUp = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
    if (current.captured) {
      try {
        event.currentTarget?.releasePointerCapture?.(current.pointerId)
      } catch (_error) {
        // Capture may already be gone (pointerup/cancel ordering); nothing to do.
      }
    }
    if (!current.active) return
    // Dropping ends with a click on the source row; consume that one click.
    suppressClick.current = true
    if (typeof globalThis.setTimeout === 'function') {
      globalThis.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    if (current.targetId === null) return
    const anchor = dropAnchor(order, current.sourceId, current.targetId, current.side)
    if (anchor === null) return
    submitReorder(current.sourceId, anchor.beforeId)
  }

  const onRowPointerCancel = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
    if (!current.captured) return
    try {
      event.currentTarget?.releasePointerCapture?.(current.pointerId)
    } catch (_error) {
      // Capture may already be gone; the drag was discarded above either way.
    }
  }

  const consumeSuppressedClick = () => {
    if (!suppressClick.current) return false
    suppressClick.current = false
    return true
  }

  return {
    drag,
    reordering,
    consumeSuppressedClick,
    onRowPointerDown,
    onRowPointerMove,
    onRowPointerUp,
    onRowPointerCancel,
  }
}

module.exports = {
  useWorkspaceDrag,
  insideWorkspaceAction,
  workspaceRowAt,
  dropTargetFor,
}
