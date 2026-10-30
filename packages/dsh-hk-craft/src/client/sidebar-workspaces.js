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
 * entry and the drag gesture to come.
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
 *   panes?: {
 *     isWorkspaceEnabled?: (workspaceId: string) => boolean,
 *     subscribe?: (listener: () => void) => () => void,
 *     getSnapshot?: () => unknown,
 *   },
 *   openWorkspace?: (workspaceId: string) => void,
 *   addWorkspace?: () => Promise<void>,
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
  const [error, setError] = React.useState(null)
  const [hovered, setHovered] = React.useState(null)

  const rows = sectionModel(workspaces, sessions, statuses, props?.panes)
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
    return h(
      'div',
      {
        key: row.workspaceId,
        'data-hkcraft-workspace-row': row.workspaceId,
        onMouseEnter: () => setHovered(row.workspaceId),
        onMouseLeave: () => setHovered(null),
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
      // Empty until ticket 03 fills it; the marker is the stable handle for
      // row gestures that must not start on a row action.
      h('span', { 'data-hkcraft-workspace-action': '', style: actionSlotStyle }),
    )
  })

  const errorLine =
    error === null
      ? null
      : h('div', { role: 'alert', style: errorStyle }, `${t('workspace.addFailed')} — ${error}`)

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
