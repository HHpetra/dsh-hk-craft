'use strict'

/**
 * The sidebar workspace section: one status light plus one name per workspace,
 * the inline delete entry and the one "Add workspace" entry (spec §7, tickets
 * 02/03).
 *
 * This component is deliberately dumb. It receives plain rows from
 * `dsh-workspaces.js` and renders them; nothing here knows what a dsh workspace
 * record looks like, so an upstream shape change never reaches this file.
 *
 * A row is a container holding the primary select button (light + name) and a
 * sibling inline action slot, which holds the delete entry. The slot is a
 * sibling — never a child — of the select button, so the two controls stay real
 * buttons instead of nesting (ticket 01). Ticket 04's drag gesture ignores
 * pointer-down on the slot so a press on delete never starts a reorder.
 *
 * Written with `React.createElement` and a lazy `require('react')` for the same
 * reason as `diagnostics.js`: the repository links client modules itself and the
 * unit tests run in Node, where the platform module graph does not exist.
 */

const { createTranslator, react } = require('./diagnostics.js')
const { sectionModel, workspaceRunningCount } = require('./dsh-workspaces.js')
const { WorkspaceDeleteDialog } = require('./workspace-delete-dialog.js')
const { absentHook, messageOf } = require('./shared.js')
const { LIGHT_COLORS } = require('./status-colors.js')
const { displayWorkspaceName } = require('./workspace-status.js')

/** Neutral fallback for an unexpected light value, so a bad row never renders blank. */
const LIGHT_FALLBACK = LIGHT_COLORS.green

/** Focus-restoration sentinel for the "Add workspace" entry (not a workspace id). */
const ADD_FOCUS = '\u0000add'

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
 * The row container: one hover/current highlight and one pointer target for the
 * drag handle later (ticket 04), without being the control itself. Keeping the
 * action slot a sibling rather than a child of the select button is what lets a
 * future delete entry stay a real button (no nested buttons).
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
  transition: 'opacity 120ms ease',
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
 * @param {{
 *   wide?: boolean,
 *   expandSidebar?: () => void,
 *   useSessions?: (selector: (state: any) => any) => any,
 *   useSessionStatus?: (selector: (state: any) => any) => any,
 *   useWorkspaces?: (selector: (state: any) => any) => any,
 *   openWorkspace?: (workspaceId: string) => void,
 *   addWorkspace?: () => Promise<void>,
 *   deleteWorkspace?: (workspaceId: string) => Promise<void>,
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

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [hovered, setHovered] = React.useState(null)
  const [focusedRow, setFocusedRow] = React.useState(null)
  const [pendingDelete, setPendingDelete] = React.useState(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState(null)
  const [focusTarget, setFocusTarget] = React.useState(null)
  const focusTargets = React.useRef({})

  const rows = sectionModel(workspaces, sessions, statuses)
  const defaultName = t('workspace.defaultName')

  const add = () => {
    if (busy) return
    if (!wide) props?.expandSidebar?.()
    setBusy(true)
    setError(null)
    Promise.resolve()
      .then(() => props?.addWorkspace?.())
      .catch((reason) => {
        setError(messageOf(reason))
      })
      .then(() => {
        setBusy(false)
      })
  }

  /**
   * Open the confirmation. The name and the running count are captured now, so
   * the dialog keeps reading the truth even if the host snapshot changes while it
   * is open; the focus fallback is the next row, else the previous one, else the
   * add entry (spec §2, user story 25).
   */
  const openDelete = (row) => {
    const index = rows.findIndex((candidate) => candidate.workspaceId === row.workspaceId)
    const neighbour =
      index === -1 ? null : (rows[index + 1]?.workspaceId ?? rows[index - 1]?.workspaceId ?? null)
    setPendingDelete({
      workspaceId: row.workspaceId,
      name: displayWorkspaceName(row.title, defaultName),
      runningCount: workspaceRunningCount(workspaces, sessions, statuses, row.workspaceId),
      focusFallback: neighbour,
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
        setFocusTarget(target.focusFallback ?? ADD_FOCUS)
      })
      .catch((reason) => {
        setDeleteBusy(false)
        setDeleteError(messageOf(reason))
      })
  }

  /** Dismiss without writing and put the focus back on the row that owned it. */
  const cancelDelete = () => {
    if (pendingDelete === null || deleteBusy) return
    setFocusTarget(pendingDelete.workspaceId)
    setPendingDelete(null)
    setDeleteError(null)
  }

  // Focus restoration waits for the post-delete rows, so a host that publishes
  // the new order asynchronously still lands on the right control. If the
  // preferred row is gone, fall back to the add entry instead of dropping focus.
  React.useEffect(() => {
    if (focusTarget === null) return
    const node =
      focusTarget === ADD_FOCUS ? focusTargets.current.add : focusTargets.current[focusTarget]
    if (node === undefined && focusTarget !== ADD_FOCUS) {
      setFocusTarget(ADD_FOCUS)
      return
    }
    setFocusTarget(null)
    if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
  }, [focusTarget, rows])

  const addButton = h(
    'button',
    {
      type: 'button',
      ref: (node) => {
        focusTargets.current.add = node
      },
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
    // Visible on row hover or while focus is anywhere inside the row, but always
    // present in the DOM so a screen reader can find the delete entry.
    const actionShown = hovered === row.workspaceId || focusedRow === row.workspaceId
    return h(
      'div',
      {
        key: row.workspaceId,
        'data-hkcraft-workspace-row': row.workspaceId,
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
        style: {
          ...rowStyle,
          background: highlighted
            ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
            : 'transparent',
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
          onClick: () => props?.openWorkspace?.(row.workspaceId),
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
      // belongs to a row action (ticket 04).
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
    error === null
      ? null
      : h('div', { role: 'alert', style: errorStyle }, `${t('workspace.addFailed')} — ${error}`)

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

  // Rows first, then the one add entry at the bottom (spec §7 sketch).
  return h(
    'div',
    { style: rootStyle, 'data-hkcraft': 'workspaces', role: 'group', 'aria-label': t('workspace.section') },
    h('div', { style: listStyle }, [...list, addButton]),
    errorLine,
    deleteDialog,
  )
}

module.exports = { WorkspaceSection }
