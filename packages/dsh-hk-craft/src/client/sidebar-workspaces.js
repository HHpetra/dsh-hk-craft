'use strict'

/**
 * The sidebar workspace section: one four-state status light plus one name per
 * workspace, and the one "Add workspace" entry (spec §1, tickets 01/02).
 *
 * This component is deliberately dumb. It receives plain rows from
 * `dsh-workspaces.js` and renders them; nothing here knows what a dsh workspace
 * record looks like, so an upstream shape change never reaches this file. The one
 * extra input is the pane controller's narrow face (`panes`), needed to ask
 * "was this workspace ever opened in split" and to re-render as soon as that
 * changes.
 *
 * A row is a container holding the primary select button (light + name) and a
 * sibling inline action slot, which ticket 01 reserves empty for the delete
 * entry. The row container is also the pointer target for drag reordering:
 * pressing in the action slot never starts a drag, so a row action keeps its
 * own click.
 *
 * Written with `React.createElement` and a lazy `require('react')` for the same
 * reason as `diagnostics.js`: the repository links client modules itself and the
 * unit tests run in Node, where the platform module graph does not exist.
 */

const { createTranslator, react } = require('./diagnostics.js')
const { sectionModel } = require('./dsh-workspaces.js')
const { absentHook, messageOf } = require('./shared.js')
const { LIGHT_COLORS } = require('./status-colors.js')
const { displayWorkspaceName } = require('./workspace-status.js')
const { crossedDragThreshold, dropAnchor, dropSideFor } = require('./workspace-reorder.js')

/** Neutral fallback for an unexpected light value, so a bad row never renders blank. */
const LIGHT_FALLBACK = LIGHT_COLORS.gray

/** No-op store for the pane subscription when no controller is wired. */
const noSubscribe = () => () => {}
const noSnapshot = () => undefined

/**
 * Follow the pane controller's snapshot so a workspace opened in split changes
 * its row from gray immediately (spec §1: "进入某个工作区的分屏后灯色立即可变").
 * The snapshot value itself is not read here — the light projection asks the
 * controller through `isWorkspaceEnabled` — it only drives the re-render.
 *
 * A stand-in React without `useSyncExternalStore` (the Node tests, an older
 * shell) renders the current state once instead of subscribing.
 *
 * @param {any} React the lazily resolved platform module
 * @param {{ subscribe?: () => (() => void), getSnapshot?: () => unknown } | undefined} panes
 * @returns {unknown}
 */
function usePaneSnapshot(React, panes) {
  const useSyncExternalStore = React?.useSyncExternalStore
  if (typeof useSyncExternalStore !== 'function') return undefined
  return useSyncExternalStore(
    typeof panes?.subscribe === 'function' ? panes.subscribe : noSubscribe,
    typeof panes?.getSnapshot === 'function' ? panes.getSnapshot : noSnapshot,
    noSnapshot,
  )
}

/** The insertion line's colour: the shell's business accent, themed per palette. */
const DROP_LINE_COLOR = 'var(--dsw-alias-state-business-primary, Highlight)'

const rootStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  padding: '0 0 4px',
}

const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minHeight: 0,
  overflowY: 'auto',
  paddingBottom: 2,
}

/**
 * The row container: one hover/current highlight and one pointer target for
 * drag reordering (ticket 04), without being the control itself. Keeping the
 * action slot a sibling rather than a child of the select button is what lets
 * the delete entry stay a real button (no nested buttons).
 */
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  minWidth: 0,
  height: 30,
  borderRadius: 'var(--dsw-radius-md, 6px)',
  background: 'transparent',
  userSelect: 'none',
  // Pointer dragging (not HTML5 DnD): the browser must not claim the gesture.
  touchAction: 'none',
}

/** The primary select control: the whole row except the inline action slot. */
const selectStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: '1 1 auto',
  minWidth: 0,
  height: '100%',
  padding: '0 8px',
  border: 'none',
  borderRadius: 'inherit',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, inherit)',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
  userSelect: 'none',
}

/**
 * The reserved inline action slot. Empty in ticket 01; ticket 03 fills it with
 * the delete entry. The attribute is the stable marker later pointer gestures
 * use to ignore presses that belong to a row action.
 */
const actionSlotStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
}

const dotStyle = {
  flex: 'none',
  width: 8,
  height: 8,
  borderRadius: '50%',
  boxShadow: '0 0 0 1px color-mix(in srgb, CanvasText 12%, transparent)',
}

/**
 * The add row keeps the select row's geometry but is a real button itself, so
 * it restores the chrome the row container no longer needs (ticket 01).
 */
const addRowStyle = {
  ...rowStyle,
  // The row container no longer owns the light-to-name gap; the add row is a
  // real button, so it restores the 8px gap it had before ticket 01.
  gap: 8,
  padding: '0 8px',
  border: 'none',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
}

/** The add row keeps the light's 8px column so names stay on one axis. */
const addGlyphStyle = {
  flex: 'none',
  width: 8,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  lineHeight: 1,
}

const addRailGlyphStyle = {
  fontSize: 16,
  lineHeight: 1,
}

const nameStyle = {
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

const iconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 22,
  height: 22,
  padding: 0,
  border: 'none',
  borderRadius: 'var(--dsw-radius-md, 6px)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, currentColor)',
  font: 'inherit',
  fontSize: 15,
  lineHeight: 1,
  cursor: 'pointer',
}

const railStyle = {
  display: 'flex',
  justifyContent: 'center',
  padding: '2px 0',
}

const railButtonStyle = {
  ...iconButtonStyle,
  width: 36,
  height: 32,
  fontSize: 16,
}

const errorStyle = {
  flex: 'none',
  margin: '2px 2px 0',
  padding: '4px 6px',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  background: 'color-mix(in srgb, #e5484d 12%, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 11,
  lineHeight: 1.4,
  wordBreak: 'break-word',
}

/**
 * True when the press belongs to a row action. The action slot is where ticket
 * 03 puts the delete entry; pressing anywhere in it must neither begin a drag
 * nor swallow the action's own click.
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
 * @param {{
 *   wide?: boolean,
 *   expandSidebar?: () => void,
 *   useSessions?: (selector: (state: any) => any) => any,
 *   useSessionStatus?: (selector: (state: any) => any) => any,
 *   useWorkspaces?: (selector: (state: any) => any) => any,
 *   panes?: {
 *     isWorkspaceEnabled?: (workspaceId: string) => boolean,
 *     subscribe?: (listener: () => void) => () => void,
 *     getSnapshot?: () => unknown,
 *   },
 *   openWorkspace?: (workspaceId: string) => void,
 *   addWorkspace?: () => Promise<void>,
 *   reorderWorkspace?: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>,
 *   t?: (key: string) => string,
 * }} props
 */
function WorkspaceSection(props) {
  const React = react()
  const h = React.createElement
  const t = createTranslator(props)
  const wide = props?.wide !== false
  const useSessions = props?.useSessions ?? absentHook
  const useSessionStatus = props?.useSessionStatus ?? absentHook
  const useWorkspaces = props?.useWorkspaces ?? absentHook

  const sessions = useSessions((state) => state)
  const statuses = useSessionStatus((state) => state)
  const workspaces = useWorkspaces((state) => state)
  usePaneSnapshot(React, props?.panes)

  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState(null)
  const [hovered, setHovered] = React.useState(null)
  const [drag, setDrag] = React.useState(null)
  const [reordering, setReordering] = React.useState(false)
  /** The in-flight press; `drag` state above only drives the visible feedback. */
  const dragRef = React.useRef(null)
  /** A drag's pointerup is followed by a click; that click must not open a row. */
  const suppressClick = React.useRef(false)
  /** One reorder request at a time (spec §3); the ref is the synchronous guard. */
  const reorderBusy = React.useRef(false)

  const rows = sectionModel(workspaces, sessions, statuses, props?.panes)
  const order = rows.map((row) => row.workspaceId)
  const defaultName = t('workspace.defaultName')

  const add = () => {
    if (busy) return
    if (!wide) props?.expandSidebar?.()
    setBusy(true)
    setFailure(null)
    Promise.resolve()
      .then(() => props?.addWorkspace?.())
      .catch((reason) => {
        setFailure({ key: 'workspace.addFailed', message: messageOf(reason) })
      })
      .then(() => {
        setBusy(false)
      })
  }

  const clearDrag = () => {
    dragRef.current = null
    setDrag(null)
  }

  /**
   * The row under `(clientX, clientY)` that a drop from `sourceId` would move
   * the source onto, or null when the drop is not a position change.
   */
  const dropTargetFor = (sourceId, clientX, clientY) => {
    const over = workspaceRowAt(clientX, clientY)
    if (over === null || over.workspaceId === sourceId) return null
    const side = dropSideFor(over.rect, clientY)
    if (side === null) return null
    if (dropAnchor(order, sourceId, over.workspaceId, side) === null) return null
    return { targetId: over.workspaceId, side }
  }

  /**
   * Send one reorder to the host. The host persists the order and reinstalls
   * its committed order if the write fails; this component keeps no local
   * order, so a failure only has to be shown.
   */
  const submitReorder = (sourceId, beforeId) => {
    if (reorderBusy.current) return
    if (typeof props?.reorderWorkspace !== 'function') return
    reorderBusy.current = true
    setReordering(true)
    setFailure(null)
    let pending
    try {
      // Start the write on drop, not a microtask later: the busy guard must
      // already be visible to the next pointerdown.
      pending = Promise.resolve(props.reorderWorkspace(sourceId, beforeId))
    } catch (reason) {
      pending = Promise.reject(reason)
    }
    pending
      .catch((reason) => {
        setFailure({ key: 'workspace.reorderFailed', message: messageOf(reason) })
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
    dragRef.current = {
      sourceId: row.workspaceId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetId: null,
      side: null,
    }
    event.currentTarget?.setPointerCapture?.(event.pointerId)
  }

  const onRowPointerMove = (event) => {
    const current = dragRef.current
    if (current === null) return
    if (!current.active && !crossedDragThreshold(current.startX, current.startY, event.clientX, event.clientY)) {
      return
    }
    const target = dropTargetFor(current.sourceId, event.clientX, event.clientY)
    const targetId = target === null ? null : target.targetId
    const side = target === null ? null : target.side
    // Entering drag mode is itself a change: the source row must dim even when
    // the pointer is not over another row yet.
    const changed = !current.active || targetId !== current.targetId || side !== current.side
    current.active = true
    current.targetId = targetId
    current.side = side
    if (changed) setDrag({ sourceId: current.sourceId, targetId, side })
    event.preventDefault()
  }

  const onRowPointerUp = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
    event.currentTarget?.releasePointerCapture?.(event.pointerId)
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
    if (dragRef.current === null) return
    clearDrag()
    event.currentTarget?.releasePointerCapture?.(event.pointerId)
  }

  const openRow = (row) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    props?.openWorkspace?.(row.workspaceId)
  }

  const addButton = h(
    'button',
    {
      type: 'button',
      onClick: add,
      disabled: busy,
      title: t('workspace.add'),
      'aria-label': t('workspace.add'),
      style: wide
        ? {
            ...addRowStyle,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.55 : 1,
          }
        : railButtonStyle,
    },
    wide
      ? h('span', { 'aria-hidden': 'true', style: addGlyphStyle }, '＋')
      : h('span', { 'aria-hidden': 'true', style: addRailGlyphStyle }, '＋'),
    wide ? h('span', { style: nameStyle }, t('workspace.add')) : null,
  )

  const list = rows.map((row) => {
    const name = displayWorkspaceName(row.title, defaultName)
    const lightLabel = t(`workspace.light.${row.light}`)
    const highlighted = row.current || hovered === row.workspaceId
    const source = drag !== null && drag.sourceId === row.workspaceId
    const dropSide = drag !== null && drag.targetId === row.workspaceId ? drag.side : null
    return h(
      'div',
      {
        key: row.workspaceId,
        'data-hkcraft-workspace-row': row.workspaceId,
        'data-hkcraft-workspace-drop': dropSide ?? undefined,
        title: t('workspace.dragHint'),
        onMouseEnter: () => setHovered(row.workspaceId),
        onMouseLeave: () => setHovered(null),
        onPointerDown: onRowPointerDown(row),
        onPointerMove: onRowPointerMove,
        onPointerUp: onRowPointerUp,
        onPointerCancel: onRowPointerCancel,
        style: {
          ...rowStyle,
          opacity: source ? 0.55 : 1,
          background: highlighted
            ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
            : 'transparent',
          // The insertion line sits on the target row's edge, so it never takes
          // part in layout and the rows never jump under the pointer.
          boxShadow:
            dropSide === 'before'
              ? `inset 0 2px 0 ${DROP_LINE_COLOR}`
              : dropSide === 'after'
                ? `inset 0 -2px 0 ${DROP_LINE_COLOR}`
                : undefined,
          cursor: drag !== null ? 'grabbing' : reordering ? 'progress' : undefined,
        },
      },
      h(
        'button',
        {
          type: 'button',
          'aria-current': row.current ? 'true' : undefined,
          'aria-label': `${name} — ${lightLabel}`,
          title: `${name} — ${lightLabel}`,
          onClick: () => openRow(row),
          style: {
            ...selectStyle,
            fontWeight: row.current ? 600 : 400,
          },
        },
        h('span', {
          'aria-hidden': 'true',
          style: { ...dotStyle, background: LIGHT_COLORS[row.light] ?? LIGHT_FALLBACK },
        }),
        h('span', { style: nameStyle }, name),
      ),
      // Empty until ticket 03 fills it; the marker is the stable handle for
      // row gestures that must not start on a row action.
      h('span', { 'data-hkcraft-workspace-action': '', style: actionSlotStyle }),
    )
  })

  const errorLine =
    failure === null
      ? null
      : h('div', { role: 'alert', style: errorStyle }, `${t(failure.key)} — ${failure.message}`)

  if (!wide) {
    return h(
      'div',
      { style: rootStyle, 'data-hkcraft': 'workspaces' },
      h('div', { style: railStyle }, addButton),
      errorLine,
    )
  }

  // Rows first, then the one add entry at the bottom (spec §7 sketch).
  return h(
    'div',
    { style: rootStyle, 'data-hkcraft': 'workspaces', role: 'group', 'aria-label': t('workspace.section') },
    h('div', { style: listStyle }, [...list, addButton]),
    errorLine,
  )
}

module.exports = { WorkspaceSection }
