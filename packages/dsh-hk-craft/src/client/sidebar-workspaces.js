'use strict'

/**
 * The sidebar workspace section: one status light plus one name per workspace,
 * and the one "Add workspace" entry (spec §7, ticket 02).
 *
 * This component is deliberately dumb. It receives plain rows from
 * `dsh-workspaces.js` and renders them; nothing here knows what a dsh workspace
 * record looks like, so an upstream shape change never reaches this file.
 *
 * Written with `React.createElement` and a lazy `require('react')` for the same
 * reason as `diagnostics.js`: the repository links client modules itself and the
 * unit tests run in Node, where the platform module graph does not exist.
 */

const { createTranslator, react } = require('./diagnostics.js')
const { sectionModel } = require('./dsh-workspaces.js')
const { displayWorkspaceName } = require('./workspace-status.js')

/** Status-light fills; theme-neutral so both shells read the same three states. */
const LIGHT_COLORS = {
  red: '#e5484d',
  yellow: '#d9a400',
  green: '#30a46c',
}

/** Neutral fallback for an unexpected light value, so a bad row never renders blank. */
const LIGHT_FALLBACK = LIGHT_COLORS.green

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

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minWidth: 0,
  height: 30,
  padding: '0 8px',
  border: 'none',
  borderRadius: 'var(--dsw-radius-md, 6px)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, inherit)',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
  userSelect: 'none',
}

const dotStyle = {
  flex: 'none',
  width: 8,
  height: 8,
  borderRadius: '50%',
  boxShadow: '0 0 0 1px color-mix(in srgb, CanvasText 12%, transparent)',
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

/** Stable stand-in so a missing hook never changes the hook call count. */
function absentHook() {
  return undefined
}

/**
 * @param {unknown} reason thrown value from the add flow
 * @returns {string}
 */
function reasonMessage(reason) {
  if (reason instanceof Error && reason.message !== '') return reason.message
  return String(reason)
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
        setError(reasonMessage(reason))
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
            ...rowStyle,
            color: 'var(--dsw-alias-label-secondary, inherit)',
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
      'button',
      {
        type: 'button',
        key: row.workspaceId,
        'aria-current': row.current ? 'true' : undefined,
        'aria-label': `${name} — ${lightLabel}`,
        title: `${name} — ${lightLabel}`,
        onClick: () => props?.openWorkspace?.(row.workspaceId),
        onMouseEnter: () => setHovered(row.workspaceId),
        onMouseLeave: () => setHovered(null),
        style: {
          ...rowStyle,
          background: highlighted ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
          fontWeight: row.current ? 600 : 400,
        },
      },
      h('span', {
        'aria-hidden': 'true',
        style: { ...dotStyle, background: LIGHT_COLORS[row.light] ?? LIGHT_FALLBACK },
      }),
      h('span', { style: nameStyle }, name),
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

module.exports = { WorkspaceSection, LIGHT_COLORS }
