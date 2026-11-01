'use strict'

/**
 * The sidebar workspace section: one four-state status light plus one name per
 * workspace, the inline delete entry and the one "Add workspace" entry.
 *
 * This component is deliberately dumb. It receives plain rows from
 * `dsh-workspaces.js` and renders them; nothing here knows what a dsh workspace
 * record looks like, so an upstream shape change never reaches this file. The one
 * extra input is the pane controller's narrow face (`panes`), needed to ask
 * "was this workspace ever opened in split" and to re-render as soon as that
 * changes.
 *
 * A row is a container holding the primary select button (light + name) and a
 * sibling inline action slot, which holds the delete entry. The slot is a
 * sibling — never a child — of the select button, so the two controls stay real
 * buttons instead of nesting. The row container is also the pointer
 * target for drag reordering: pressing in the action slot never starts a drag,
 * so a row action keeps its own click. The pointer plumbing itself lives in
 * `workspace-drag.js`.
 *
 * Written with `React.createElement` and a lazy `require('react')` for the same
 * reason as `react-and-translator.js`: the repository links client modules itself
 * and the unit tests run in Node, where the platform module graph does not exist.
 */

const { createTranslator, react } = require('./react-and-translator.js')
const { openCatalog } = require('./catalog.js')
const { sectionModel, workspaceRunningCount } = require('./dsh-workspaces.js')
const { WorkspaceDeleteDialog } = require('./workspace-delete-dialog.js')
const { absentHook, messageOf } = require('./shared.js')
const { T, paint, ink } = require('./visual-tokens.js')
const { LIGHT_COLORS } = require('./status-colors.js')
const { displayWorkspaceName } = require('./workspace-status.js')
const { deleteFocusTarget, workspaceOrderOf } = require('./workspace-order.js')
const { useWorkspaceDrag } = require('./workspace-drag.js')

/** Neutral fallback for an unexpected light value, so a bad row never renders blank. */
const LIGHT_FALLBACK = LIGHT_COLORS.gray

/** No-op store for the pane subscription when no controller is wired. */
const noSubscribe = () => () => {}
const noSnapshot = () => undefined

/**
 * Follow the pane controller's snapshot so a workspace opened in split changes
 * its row from gray immediately. The snapshot value itself is not read here —
 * the light projection asks the controller through `isWorkspaceEnabled` — it only
 * drives the re-render. This is deliberately separate from the pane view's
 * `usePaneSnapshot`: the workspace section needs only the wake-up, not the state.
 *
 * A stand-in React without `useSyncExternalStore` (the Node tests, an older
 * shell) renders the current state once instead of subscribing.
 *
 * @param {any} React the lazily resolved platform module
 * @param {{ subscribe?: () => (() => void), getSnapshot?: () => unknown } | undefined} panes
 * @returns {unknown}
 */
function useWorkspacePaneRevision(React, panes) {
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

/**
 * Fill only the free space above the shell footer.
 *
 * `sidebar.workspaces` is rendered inside the sidebar column, and that column
 * clips overflow. A flex item whose minimum size is its content grows the
 * column past the clip and pushes the footer — the settings trigger, and any
 * entry another plugin inserts there — below the visible edge. The box is
 * still in the layout, so it looks present to accessibility tools, but it is
 * neither painted nor clickable. `height: 0` plus `flex: 1 1 auto` makes this
 * section take the free space and nothing more; the list inside it scrolls.
 */
const rootStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  height: 0,
  minHeight: 0,
  overflow: 'hidden',
  padding: '0 0 4px',
}

const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  gap: 2,
  minHeight: 0,
  overflowY: 'auto',
  paddingBottom: 2,
}

/** A quiet section label, matching the native browser's header height. */
const sectionHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  height: 30,
  padding: '0 8px',
  color: T.textTertiary,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.03em',
}

const sectionCountStyle = {
  marginLeft: 'auto',
  color: T.textCaption,
  fontSize: 10,
  fontVariantNumeric: 'tabular-nums',
}

/**
 * The row container: one hover/current highlight and one pointer target for
 * drag reordering, without being the control itself. Keeping the
 * action slot a sibling rather than a child of the select button is what lets
 * the delete entry stay a real button (no nested buttons).
 */
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  minWidth: 0,
  height: 34,
  borderRadius: T.radiusMd,
  background: paint('row-bg'),
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
  color: T.text,
  font: 'inherit',
  fontSize: 14,
  lineHeight: '20px',
  textAlign: 'left',
  cursor: 'pointer',
  userSelect: 'none',
}

/**
 * The reserved inline action slot. The delete entry fills it; the attribute is
 * the stable marker pointer gestures use to ignore presses that belong to a row
 * action.
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
  boxShadow: `0 0 0 2px color-mix(in srgb, ${T.sidebar} 88%, transparent), 0 0 0 3px ${T.border2}`,
  transition: `background-color ${T.normal} ${T.ease}, box-shadow ${T.normal} ${T.ease}`,
}

/**
 * The add row keeps the select row's geometry but is a real button itself, so
 * it restores the chrome the row container no longer needs.
 */
const addRowStyle = {
  ...rowStyle,
  // The plus is a small disc centred over the rows' status-dot column; the
  // asymmetric padding keeps every workspace name on one vertical axis.
  gap: 4,
  padding: '0 8px 0 3px',
  border: 'none',
  color: ink('button-fg', T.textTertiary),
  font: 'inherit',
  fontSize: 14,
  lineHeight: '20px',
  textAlign: 'left',
  cursor: 'pointer',
}

/** The add row keeps the light's 8px column so names stay on one axis. */
const addGlyphStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 18,
  height: 18,
  borderRadius: 999,
  background: T.module,
  color: T.textSecondary,
  fontSize: 13,
  lineHeight: 1,
}

const addRailGlyphStyle = {
  fontSize: 17,
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
  borderRadius: T.radiusXs,
  background: paint('icon-bg'),
  color: ink('icon-fg', T.textSecondary),
  font: 'inherit',
  fontSize: 15,
  lineHeight: 1,
  cursor: 'pointer',
  transition: `background-color ${T.fast} ${T.ease}, color ${T.fast} ${T.ease}, opacity ${T.fast} ${T.ease}`,
}

/**
 * The delete entry lives inside the reserved action slot. It keeps its own
 * width so rows with and without the action stay aligned, and its own spacing
 * so it never touches the workspace name or the row edge.
 */
const deleteEntryStyle = {
  ...iconButtonStyle,
  width: 20,
  height: 20,
  marginRight: 6,
  fontSize: 14,
}

const railStyle = {
  display: 'flex',
  justifyContent: 'center',
  padding: '2px 0',
}

const railButtonStyle = {
  ...iconButtonStyle,
  width: 36,
  height: 34,
  borderRadius: T.radiusMd,
  fontSize: 17,
}

const errorStyle = {
  flex: 'none',
  margin: '4px 2px 0',
  padding: '6px 8px',
  borderRadius: T.radiusSm,
  background: `color-mix(in srgb, ${T.error} 10%, transparent)`,
  color: T.error,
  fontSize: 11,
  lineHeight: 1.45,
  wordBreak: 'break-word',
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
 *   deleteWorkspace?: (workspaceId: string) => Promise<void>,
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
  useWorkspacePaneRevision(React, props?.panes)

  // One read model for the three snapshots: the rows, the order and the running
  // count below all ask it instead of walking dsh's shapes. `openCatalog`
  // memoises on the triple, so this is a stable value across re-renders.
  const catalog = openCatalog({ sessions, workspaces, statuses })

  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState(null)
  const [hovered, setHovered] = React.useState(null)
  const [focusedRow, setFocusedRow] = React.useState(null)
  const [pendingDelete, setPendingDelete] = React.useState(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState(null)
  const [focusTarget, setFocusTarget] = React.useState(null)
  const focusTargets = React.useRef({})

  const rows = sectionModel(catalog, props?.panes)
  const order = workspaceOrderOf(catalog)
  const defaultName = t('workspace.defaultName')

  // Pointer plumbing lives in its own hook; the section only owns the rows, the
  // failure line and the focus target.
  const dragGesture = useWorkspaceDrag(React, {
    order,
    reorderWorkspace: props?.reorderWorkspace,
    onReorderStart: () => setFailure(null),
    onReorderError: (reason) => {
      setFailure({ key: 'workspace.reorderFailed', message: messageOf(reason) })
    },
  })
  const { drag, reordering } = dragGesture

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

  /**
   * Open the confirmation. The name and the running count are captured now, so
   * the dialog keeps reading the truth even if the host snapshot changes while it
   * is open; the focus target is computed from the host order captured here, so a
   * row that disappears with the delete cannot drag focus along with it.
   */
  const openDelete = (row) => {
    setPendingDelete({
      workspaceId: row.workspaceId,
      name: displayWorkspaceName(row.title, defaultName),
      runningCount: workspaceRunningCount(catalog, row.workspaceId),
      focusTarget: deleteFocusTarget(order, row.workspaceId),
    })
    setDeleteBusy(false)
    setDeleteError(null)
  }

  /** Submit the delete; the dialog stays open (with the reason) on a rejection. */
  const confirmDelete = () => {
    if (pendingDelete === null || deleteBusy) return
    const target = pendingDelete
    setDeleteBusy(true)
    setDeleteError(null)
    Promise.resolve()
      .then(() => props?.deleteWorkspace?.(target.workspaceId))
      .then(() => {
        setPendingDelete(null)
        setDeleteBusy(false)
        setFocusTarget(target.focusTarget)
      })
      .catch((reason) => {
        setDeleteBusy(false)
        setDeleteError(messageOf(reason))
      })
  }

  /** Dismiss without writing and put the focus back on the row that owned it. */
  const cancelDelete = () => {
    if (pendingDelete === null || deleteBusy) return
    setFocusTarget({ kind: 'workspace', workspaceId: pendingDelete.workspaceId })
    setPendingDelete(null)
    setDeleteError(null)
  }

  // Focus restoration waits for the post-delete rows, so a host that publishes
  // the new order asynchronously still lands on the right control. If the
  // preferred row is gone, fall back to the add entry instead of dropping focus.
  React.useEffect(() => {
    if (focusTarget === null) return
    const node =
      focusTarget.kind === 'add'
        ? focusTargets.current.add
        : focusTargets.current[focusTarget.workspaceId]
    if (node === undefined && focusTarget.kind === 'workspace') {
      setFocusTarget({ kind: 'add' })
      return
    }
    setFocusTarget(null)
    if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
  }, [focusTarget, rows])

  const openRow = (row) => {
    if (dragGesture.consumeSuppressedClick()) return
    props?.openWorkspace?.(row.workspaceId)
  }

  const addButton = h(
    'button',
    {
      type: 'button',
      ref: (node) => {
        focusTargets.current.add = node
      },
      'data-hkcraft-workspace-add': '',
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
    // Visible on row hover or while focus is anywhere inside the row, but always
    // present in the DOM so a screen reader can find the delete entry.
    const actionShown = hovered === row.workspaceId || focusedRow === row.workspaceId
    const source = drag !== null && drag.sourceId === row.workspaceId
    const dropSide = drag !== null && drag.targetId === row.workspaceId ? drag.side : null
    return h(
      'div',
      {
        key: row.workspaceId,
        'data-hkcraft-workspace-row': row.workspaceId,
        'data-hkcraft-workspace-current': row.current ? 'true' : 'false',
        'data-hkcraft-workspace-drop': dropSide ?? undefined,
        title: t('workspace.dragHint'),
        onMouseEnter: () => setHovered(row.workspaceId),
        onMouseLeave: () => setHovered(null),
        onFocus: () => setFocusedRow(row.workspaceId),
        onBlur: (event) => {
          const next = event?.relatedTarget
          if (next !== null && next !== undefined && event?.currentTarget?.contains?.(next) === true) {
            return
          }
          setFocusedRow(null)
        },
        onPointerDown: dragGesture.onRowPointerDown(row),
        onPointerMove: dragGesture.onRowPointerMove,
        onPointerUp: dragGesture.onRowPointerUp,
        onPointerCancel: dragGesture.onRowPointerCancel,
        style: {
          ...rowStyle,
          opacity: source ? 0.55 : 1,
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
          ref: (node) => {
            focusTargets.current[row.workspaceId] = node
          },
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
      // Sibling of the select button: a real delete button, never nested. The
      // stable marker is the handle row gestures use to ignore a press that
      // belongs to a row action.
      h(
        'span',
        { 'data-hkcraft-workspace-action': '', style: actionSlotStyle },
        h(
          'button',
          {
            type: 'button',
            'data-hkcraft-workspace-delete': row.workspaceId,
            'aria-label': `${t('workspace.delete')}: ${name}`,
            title: `${t('workspace.delete')}: ${name}`,
            onClick: (event) => {
              event?.stopPropagation?.()
              openDelete(row)
            },
            style: {
              ...deleteEntryStyle,
              opacity: actionShown ? 1 : 0,
              pointerEvents: actionShown ? 'auto' : 'none',
            },
          },
          '×',
        ),
      ),
    )
  })

  const errorLine =
    failure === null
      ? null
      : h('div', { role: 'alert', style: errorStyle }, `${t(failure.key)} — ${failure.message}`)

  const deleteDialog =
    pendingDelete === null
      ? null
      : h(WorkspaceDeleteDialog, {
          workspaceId: pendingDelete.workspaceId,
          workspaceName: pendingDelete.name,
          runningCount: pendingDelete.runningCount,
          busy: deleteBusy,
          error: deleteError,
          onCancel: cancelDelete,
          onConfirm: confirmDelete,
        })

  if (!wide) {
    return h(
      'div',
      { style: rootStyle, 'data-hkcraft': 'workspaces' },
      h('div', { style: railStyle }, addButton),
      errorLine,
      deleteDialog,
    )
  }

  // Rows first, then the one add entry at the bottom (spec §7 sketch). The
  // label names the region the slim sidebar replaced, so the rows never read as
  // an unlabelled continuation of the shell's global panel list.
  return h(
    'div',
    { style: rootStyle, 'data-hkcraft': 'workspaces', role: 'group', 'aria-label': t('workspace.section') },
    h(
      'div',
      { style: sectionHeaderStyle, 'data-hkcraft-workspaces-header': '' },
      h('span', null, t('workspace.section')),
      h('span', { style: sectionCountStyle }, String(rows.length)),
    ),
    h('div', { style: listStyle }, [...list, addButton]),
    errorLine,
    deleteDialog,
  )
}

module.exports = { WorkspaceSection }
