'use strict'

/**
 * The one document listener that routes a file drag to the pane under the pointer.
 *
 * Installed with the pane host and removed with it. Capture phase runs before
 * the bubble listeners each mounted composer registered
 * (`installDocumentDropEvents`), so `stopImmediatePropagation` keeps a single
 * drop from being accepted once per composer — including composers that belong
 * to a workspace which is loaded but not on screen.
 *
 * With one loaded pane the listener stays out of the event: dsh's own listeners
 * keep their native behaviour. See
 * `docs/upstream-contracts.md#document-file-drop-and-per-pane-routing`.
 */

const {
  isFileDrag,
  takeoverFileDrag,
  paneElementFrom,
  paneIdFromTarget,
  sessionIdForPane,
  droppedDirectories,
  filesOf,
  willAcceptDrop,
  deliverPaneFiles,
} = require('./pane-file-drop.js')

const FILE_EVENTS = ['dragenter', 'dragover', 'dragleave', 'drop']

const FALLBACK_LABELS = {
  'pane.drop.accept': '松开以添加文件',
  'pane.drop.reject': '当前无法添加文件',
}

/**
 * Install the file-drop router.
 *
 * @param {{
 *   document?: any,
 *   view?: any,
 *   getSnapshot?: () => any,
 *   getSessions?: () => any,
 *   sessions?: any,
 *   label?: (key: string) => string,
 *   hostPaths?: unknown,
 *   placeFiles?: (input: any, files: readonly any[]) => boolean,
 * }} [options]
 * @returns {() => void} remove every listener this call added
 */
function installPaneFileDrop(options = {}) {
  const documentRef = options.document ?? globalThis.document
  if (documentRef == null || typeof documentRef.addEventListener !== 'function') {
    return () => {}
  }
  const view = options.view ?? globalThis.window

  /** @type {{pane: any, overlay: any, accept: boolean|null}|null} */
  let current = null
  let dragging = false
  let suppressed = false

  function text(key) {
    try {
      const value = options.label?.(key)
      if (typeof value === 'string' && value !== '' && value !== key) return value
    } catch (_error) {
      // The locale binder can throw while a shell is tearing down; the
      // overlay still has the copy the issue specifies.
    }
    return FALLBACK_LABELS[key] ?? ''
  }

  function clearFeedback() {
    const painted = current
    current = null
    if (painted == null) return
    try {
      painted.pane.removeAttribute?.('data-hkcraft-drop')
    } catch (_error) {
      // The pane may already have been removed with its workspace.
    }
    try {
      painted.overlay?.remove?.()
    } catch (_error) {
      // Same as above: clearing is best-effort.
    }
  }

  /**
   * @param {any} pane
   * @param {boolean} accept
   */
  function showFeedback(pane, accept) {
    if (current != null && current.pane !== pane) clearFeedback()
    if (current == null) {
      let overlay = null
      try {
        overlay = documentRef.createElement('div')
        overlay.setAttribute('data-hkcraft-drop-overlay', '')
        overlay.setAttribute('aria-hidden', 'true')
        pane.appendChild(overlay)
      } catch (_error) {
        overlay = null
      }
      current = { pane, overlay, accept: null }
    }
    if (current.accept === accept) return
    const mode = accept ? 'copy' : 'none'
    try {
      pane.setAttribute('data-hkcraft-drop', mode)
    } catch (_error) {
      // The attribute is the cursor hook; the drop still routes without it.
    }
    if (current.overlay != null) {
      try {
        current.overlay.setAttribute('data-hkcraft-drop-accept', accept ? 'true' : 'false')
        current.overlay.textContent = text(accept ? 'pane.drop.accept' : 'pane.drop.reject')
      } catch (_error) {
        // The highlight attribute above still tells the stylesheet which state it is.
      }
    }
    current.accept = accept
  }

  function readSnapshot() {
    try {
      return options.getSnapshot?.() ?? {}
    } catch (_error) {
      return {}
    }
  }

  function sessionsNow() {
    try {
      if (typeof options.getSessions === 'function') return options.getSessions()
      return options.sessions
    } catch (_error) {
      return undefined
    }
  }

  /**
   * @param {any} dataTransfer
   * @param {string} effect
   */
  function setDropEffect(dataTransfer, effect) {
    if (dataTransfer == null) return
    try {
      dataTransfer.dropEffect = effect
    } catch (_error) {
      // A read-only transfer still drops; the cursor is the only thing lost.
    }
  }

  /**
   * @param {any} event
   * @returns {boolean} whether this listener took the event
   */
  function beginTakeover(event) {
    if (!takeoverFileDrag(event, readSnapshot())) {
      // A drag that started while several panes were open can outlive that
      // layout. Drop the highlight and let the native listeners have the event.
      if (dragging && isFileDrag(event)) {
        dragging = false
        suppressed = false
        clearFeedback()
      }
      return false
    }
    dragging = true
    event.preventDefault?.()
    event.stopImmediatePropagation?.()
    return true
  }

  /**
   * @param {any} event
   * @param {unknown} target the element the pointer is over now
   */
  function paint(event, target) {
    if (!beginTakeover(event)) return
    if (suppressed) {
      setDropEffect(event.dataTransfer, 'none')
      clearFeedback()
      return
    }
    const pane = paneElementFrom(target)
    const paneId = paneIdFromTarget(target)
    if (pane == null || paneId == null) {
      setDropEffect(event.dataTransfer, 'none')
      clearFeedback()
      return
    }
    const sessionId = sessionIdForPane(readSnapshot(), paneId)
    const accept = willAcceptDrop(
      sessionsNow(),
      sessionId,
      pane,
      event.dataTransfer,
      options.hostPaths,
    )
    setDropEffect(event.dataTransfer, accept ? 'copy' : 'none')
    showFeedback(pane, accept)
  }

  const onDragEnter = (event) => {
    paint(event, event?.target)
  }

  const onDragOver = (event) => {
    paint(event, event?.target)
  }

  const onDragLeave = (event) => {
    // `dragleave` reports the element being left. The pointer's new element is
    // `relatedTarget`; a null one means the drag left the window.
    if (takeoverFileDrag(event, readSnapshot())) {
      paint(event, event?.relatedTarget)
      return
    }
    if (dragging && event?.relatedTarget == null) clearFeedback()
  }

  const onDrop = (event) => {
    const snapshot = readSnapshot()
    if (!takeoverFileDrag(event, snapshot)) return
    event.preventDefault?.()
    event.stopImmediatePropagation?.()
    const cancelled = suppressed
    dragging = false
    suppressed = false
    const paneId = paneIdFromTarget(event?.target)
    const sessionId = paneId == null ? null : sessionIdForPane(snapshot, paneId)
    const pane = paneElementFrom(event?.target)
    clearFeedback()
    if (cancelled || paneId == null || sessionId == null) return
    const files = filesOf(event?.dataTransfer)
    if (files.length === 0) return
    try {
      deliverPaneFiles({
        sessions: sessionsNow(),
        sessionId,
        files,
        directories: droppedDirectories(event.dataTransfer, files),
        paneRoot: pane,
        hostPaths: options.hostPaths,
        placeFiles: options.placeFiles,
      })
    } catch (_error) {
      // deliverPaneFiles already degrades to the file input or a silent discard.
    }
  }

  const onDragEnd = () => {
    dragging = false
    suppressed = false
    clearFeedback()
  }

  const onKeyDown = (event) => {
    if (event?.key !== 'Escape' || !dragging) return
    suppressed = true
    clearFeedback()
  }

  for (const type of FILE_EVENTS) {
    const handler =
      type === 'dragenter' ? onDragEnter : type === 'dragover' ? onDragOver : type === 'dragleave' ? onDragLeave : onDrop
    documentRef.addEventListener(type, handler, true)
  }
  documentRef.addEventListener('keydown', onKeyDown, true)
  if (view != null && typeof view.addEventListener === 'function') {
    view.addEventListener('dragend', onDragEnd)
  }

  return function disposePaneFileDrop() {
    documentRef.removeEventListener('dragenter', onDragEnter, true)
    documentRef.removeEventListener('dragover', onDragOver, true)
    documentRef.removeEventListener('dragleave', onDragLeave, true)
    documentRef.removeEventListener('drop', onDrop, true)
    documentRef.removeEventListener('keydown', onKeyDown, true)
    if (view != null && typeof view.removeEventListener === 'function') {
      view.removeEventListener('dragend', onDragEnd)
    }
    dragging = false
    suppressed = false
    clearFeedback()
  }
}

module.exports = { installPaneFileDrop, FILE_EVENTS }
