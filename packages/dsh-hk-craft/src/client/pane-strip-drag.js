'use strict'

/**
 * The pane strip's drag gesture: pointer capture, hit testing and click
 * suppression after a drop.
 *
 * This is the part of `PaneStrip` that changes for pointer reasons rather than
 * rendering reasons, so it lives in its own hook — the same split
 * `workspace-drag.js` makes for the sidebar rows. Both gestures share one rule,
 * "past the threshold" (`drag-threshold.js`), and nothing else: a strip drop is a
 * swap between two entries with no ordering anchor, a workspace drop resolves the
 * host's `insertBefore` anchor.
 *
 * Two details are deliberately different from the sidebar gesture:
 *
 * - **Capture happens on pointerdown, not on drag start.** The strip entry owns
 *   the click itself (`role="tab"` with `onClick`), so a click retargeted to the
 *   capture element still lands on the tab that was pressed. The sidebar row's
 *   click belongs to a child button, which is why that gesture waits.
 * - **The drop has no sides.** Dropping on another entry swaps the two panes'
 *   contents; dropping anywhere else is a complete no-op: no swap, no focus
 *   change, no layout write.
 */

const { crossedDragThreshold } = require('./drag-threshold.js')

/** The entry attribute the hit test reads; `PaneStrip` paints it. */
const STRIP_ITEM_ATTR = 'data-hkcraft-strip-item'
/** The close button's attribute: a press there is never a drag. */
const STRIP_CLOSE_ATTR = 'data-hkcraft-strip-close'

/**
 * True when the press belongs to an entry's close button, which keeps its own
 * click: a drag must never steal it.
 *
 * @param {any} target pointer event target
 * @returns {boolean}
 */
function insideStripClose(target) {
  return (
    typeof target?.closest === 'function' &&
    target.closest(`[${STRIP_CLOSE_ATTR}]`) !== null
  )
}

/**
 * The pane whose strip entry is under the pointer, or null.
 *
 * Pointer capture keeps the move events on the source entry, so the drop target
 * has to be hit-tested from the pointer coordinates.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string|null}
 */
function stripPaneIdAt(clientX, clientY) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null
  const element = document.elementFromPoint(clientX, clientY)
  const entry = typeof element?.closest === 'function' ? element.closest(`[${STRIP_ITEM_ATTR}]`) : null
  const paneId = entry?.getAttribute?.(STRIP_ITEM_ATTR)
  return typeof paneId === 'string' && paneId !== '' ? paneId : null
}

/**
 * The pane a release at this point would swap with, or null when the drop is a
 * no-op (nothing under the pointer, or the source entry itself).
 *
 * @param {string} sourcePaneId the dragged entry
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string|null}
 */
function swapTargetFor(sourcePaneId, clientX, clientY) {
  const targetPaneId = stripPaneIdAt(clientX, clientY)
  if (targetPaneId === null || targetPaneId === sourcePaneId) return null
  return targetPaneId
}

/**
 * The drag gesture for one strip.
 *
 * @param {any} React the lazily resolved platform module
 * @param {{ onSwap?: (sourcePaneId: string, targetPaneId: string) => void }} [options]
 *   `onSwap` runs once per completed drop; without it the gesture still tracks
 *   and suppresses, which is what a controller-less test render needs
 * @returns {{
 *   drag: { sourcePaneId: string, targetPaneId: string|null } | null,
 *   consumeSuppressedClick: () => boolean,
 *   onEntryPointerDown: (entry: { paneId: string }) => (event: any) => void,
 *   onEntryPointerMove: (event: any) => void,
 *   onEntryPointerUp: (event: any) => void,
 *   onEntryPointerCancel: (event: any) => void,
 * }}
 */
function usePaneStripDrag(React, options = {}) {
  const onSwap = typeof options?.onSwap === 'function' ? options.onSwap : null
  const [drag, setDrag] = React.useState(null)
  /** The in-flight press; `drag` state above only drives the visible feedback. */
  const dragRef = React.useRef(null)
  /** A drag's pointerup is followed by a click; that click must not re-focus. */
  const suppressClick = React.useRef(false)

  const clearDrag = () => {
    dragRef.current = null
    setDrag(null)
  }

  const onEntryPointerDown = (entry) => (event) => {
    if (event.button !== undefined && event.button !== 0) return
    if (insideStripClose(event.target)) return
    dragRef.current = {
      sourcePaneId: entry.paneId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetPaneId: null,
    }
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId)
    } catch (_error) {
      // A pointer that already ended cannot be captured; the drag simply falls
      // back to the move events that still reach the entry.
    }
  }

  const onEntryPointerMove = (event) => {
    const current = dragRef.current
    if (current === null) return
    if (!current.active) {
      if (!crossedDragThreshold(current.startX, current.startY, event.clientX, event.clientY)) {
        return
      }
      current.active = true
      // Entering drag mode is itself feedback: the source entry dims even
      // before the pointer reaches another entry.
      setDrag({ sourcePaneId: current.sourcePaneId, targetPaneId: null })
    }
    const targetPaneId = swapTargetFor(current.sourcePaneId, event.clientX, event.clientY)
    if (targetPaneId !== current.targetPaneId) {
      current.targetPaneId = targetPaneId
      setDrag({ sourcePaneId: current.sourcePaneId, targetPaneId })
    }
    event.preventDefault()
  }

  const onEntryPointerUp = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
    try {
      event.currentTarget?.releasePointerCapture?.(current.pointerId)
    } catch (_error) {
      // Capture may already be gone (pointerup/cancel ordering); nothing to do.
    }
    if (!current.active) return
    // The drop ends with a click on the source entry; consume that one click.
    suppressClick.current = true
    if (typeof globalThis.setTimeout === 'function') {
      globalThis.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    if (current.targetPaneId !== null && onSwap !== null) {
      onSwap(current.sourcePaneId, current.targetPaneId)
    }
  }

  const onEntryPointerCancel = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
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
    consumeSuppressedClick,
    onEntryPointerDown,
    onEntryPointerMove,
    onEntryPointerUp,
    onEntryPointerCancel,
  }
}

module.exports = {
  STRIP_ITEM_ATTR,
  STRIP_CLOSE_ATTR,
  usePaneStripDrag,
  insideStripClose,
  stripPaneIdAt,
  swapTargetFor,
}