'use strict'

/**
 * Thin React shell around the pane controller. All dsh assumptions live in
 * `dsh-pane-host.js`; this file only turns controller state into elements.
 *
 * Layout rendering keeps every pane mounted: the pure geometry projection
 * (`layout-geometry.js`) turns the tree into flat, fractional rectangles, and
 * each pane is an absolutely positioned sibling keyed by `paneId`. A split or a
 * close therefore changes inline styles only — React never re-parents a pane,
 * so streaming output, scroll position and the composer draft survive.
 *
 * `react` is resolved lazily because unit tests load this module in Node,
 * where the platform module graph does not exist.
 */

const { createTranslator } = require('./diagnostics.js')
const { CONTENT_FACTORY, PANE_SLOT, derivePanePhase } = require('./dsh-pane-host.js')
const { effectiveView, viewSegments } = require('./dsh-view-switch.js')
const { computeLayout, SEPARATOR_HIT_PX, SEPARATOR_LINE_PX } = require('./layout-geometry.js')
const { ratioFromDrag } = require('./layout-tree.js')
const {
  TAB_STATUS_ERROR,
  TAB_STATUS_IDLE,
  TAB_STATUS_RUNNING,
  TAB_STATUS_WAITING,
  projectTabs,
  tabShortcutIndex,
} = require('./tab-strip.js')

let reactModule = null

/** @returns {any} the platform React instance */
function react() {
  if (reactModule === null) reactModule = require('react')
  return reactModule
}

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  padding: '2px 8px',
}

const paneStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

/** The workspace box: the tab strip on top, the pane area filling the rest. */
const workspaceStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

/** The pane area the fractional rectangles are drawn in. */
const layoutStyle = {
  position: 'relative',
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  width: '100%',
  overflow: 'hidden',
}

/** Tab strip height (spec §5: 36px, the Agent10 density). */
const TAB_STRIP_HEIGHT = 36

const tabStripStyle = {
  display: 'flex',
  alignItems: 'stretch',
  flex: 'none',
  height: TAB_STRIP_HEIGHT,
  minHeight: TAB_STRIP_HEIGHT,
  minWidth: 0,
  borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  background: 'var(--dsw-alias-bg-base, Canvas)',
}

/** Only this inner box scrolls; `+` stays pinned at the right. */
const tabViewportStyle = {
  display: 'flex',
  alignItems: 'stretch',
  flex: '1 1 auto',
  minWidth: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  whiteSpace: 'nowrap',
  scrollbarWidth: 'thin',
}

const tabStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  maxWidth: 200,
  minWidth: 0,
  height: '100%',
  padding: '0 8px',
  border: 'none',
  borderTop: '2px solid transparent',
  borderRight: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  userSelect: 'none',
}

/** Titles truncate instead of squeezing their neighbours (spec §5). */
const tabTitleStyle = {
  maxWidth: 128,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const tabDotStyle = {
  flex: 'none',
  width: 7,
  height: 7,
  borderRadius: '50%',
  boxShadow: '0 0 0 1px color-mix(in srgb, CanvasText 12%, transparent)',
}

const tabCloseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
}

const tabNewStyle = {
  ...buttonStyle,
  flex: 'none',
  border: 'none',
  borderLeft: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  borderRadius: 0,
  padding: '0 10px',
}

/** Dot colours per tab status; waiting / error stay distinguishable (red vs orange). */
const TAB_STATUS_COLORS = {
  [TAB_STATUS_RUNNING]: '#d9a400',
  [TAB_STATUS_WAITING]: '#e5484d',
  [TAB_STATUS_ERROR]: '#f76b15',
  [TAB_STATUS_IDLE]: '#30a46c',
}

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  minHeight: 36,
  padding: '0 10px',
  borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  fontSize: 12,
}

const titleStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 600,
}

const bodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  position: 'relative',
}

const fallbackStyle = {
  margin: 'auto',
  maxWidth: 560,
  padding: 24,
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1.6,
  opacity: 0.9,
}

/** The 对话 | 轨迹 control is a segmented switch, not a tab strip (spec §6). */
const segmentedStyle = {
  display: 'inline-flex',
  alignItems: 'stretch',
  flex: 'none',
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 6,
  overflow: 'hidden',
}

const segmentStyle = {
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  lineHeight: '18px',
  padding: '1px 7px',
}

const segmentActiveStyle = {
  background: 'color-mix(in srgb, currentColor 16%, transparent)',
  fontWeight: 600,
}

const segmentDisabledStyle = { opacity: 0.45, cursor: 'not-allowed' }

const closeOverlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: 'rgba(0, 0, 0, 0.35)',
}

const closeDialogStyle = {
  width: 440,
  maxWidth: 'calc(100vw - 32px)',
  padding: '18px 20px',
  borderRadius: 12,
  border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 16px 40px rgba(0, 0, 0, 0.24)',
  fontSize: 13,
  lineHeight: 1.6,
}

const closeTitleStyle = {
  fontSize: 12,
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginBottom: 6,
}

const closeActionsStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 16,
}

const closeErrorStyle = {
  marginTop: 10,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'color-mix(in srgb, tomato 16%, transparent)',
  wordBreak: 'break-word',
}

/** Subscribe a component to the controller's frozen snapshot. */
function usePaneSnapshot(React, controller) {
  return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

/**
 * Error boundary around the foreign Conversation factory. React needs a class;
 * the class is minted on first render so loading this module in Node stays
 * react-free.
 */
let boundaryClass = null

function errorBoundaryClass() {
  if (boundaryClass !== null) return boundaryClass
  const React = react()
  boundaryClass = class PaneErrorBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
      return { error }
    }

    componentDidCatch(error, info) {
      console.error('[dsh-hk-craft] conversation.content crashed', error, info)
    }

    render() {
      if (this.state.error !== null) return this.props.fallback(this.state.error)
      return this.props.children
    }
  }
  return boundaryClass
}

/** @param {{ t: (key: string) => string, text: string, detail?: string, label: string, onBack: () => void }} props */
function PaneFallback({ t, text, detail, label, onBack }) {
  const React = react()
  const h = React.createElement
  return h(
    'div',
    { style: fallbackStyle, role: 'status' },
    h('div', { style: { fontWeight: 600, marginBottom: 6 } }, text),
    detail === undefined ? null : h('div', { style: { opacity: 0.75, marginBottom: 12 } }, detail),
    h('button', { type: 'button', style: buttonStyle, onClick: onBack }, label ?? t('pane.back')),
  )
}

/**
 * The empty state: the workspace has no panes at all. It offers the one action
 * that can create a first pane (`/clear`'s host-side path, `newInFocused`).
 *
 * @param {{ t: (key: string) => string, onNew: () => void }} props
 */
function PaneEmptyState({ t, onNew }) {
  const React = react()
  const h = React.createElement
  return h(
    'div',
    { style: paneStyle, 'data-hkcraft-empty': '' },
    h(
      'div',
      { style: fallbackStyle, role: 'status' },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('pane.empty.workspace.title')),
      h('div', { style: { opacity: 0.75, marginBottom: 12 } }, t('pane.empty.workspace.body')),
      h('button', { type: 'button', style: buttonStyle, onClick: onNew }, t('pane.empty.new')),
    ),
  )
}

/**
 * The pane's own `对话 | 轨迹` segmented switch (ticket 07, spec D1 + §6).
 *
 * dsh's native tab row lives in `conversation.session.header`, which is a child
 * slot of the `main.conversation` root — the pane renders only the
 * `conversation.content` factory, so that header (and its `role="tablist"`) is
 * never mounted here. This control replaces it per pane.
 *
 * The trajectory segment is disabled with a tooltip while developer tools are
 * off, mirroring dsh's own filter instead of silently doing nothing.
 *
 * @param {{ controller: any, pane: object, t: (key: string) => string }} props
 */
function PaneViewSwitch({ controller, pane, t }) {
  const React = react()
  const h = React.createElement
  const trajectoryAvailable = React.useSyncExternalStore(
    controller.subscribeViewAvailability,
    controller.isTrajectoryAvailable,
    controller.isTrajectoryAvailable,
  )
  const selected = effectiveView(pane.view, trajectoryAvailable)
  const labels = {
    chat: t('pane.view.chat'),
    trajectory: t('pane.view.trajectory'),
  }
  return h(
    'div',
    {
      role: 'group',
      'aria-label': t('pane.view.title'),
      'data-hkcraft-view-switch': pane.view,
      style: segmentedStyle,
    },
    viewSegments(trajectoryAvailable).map((segment) =>
      h(
        'button',
        {
          key: segment.id,
          type: 'button',
          role: 'radio',
          'aria-checked': segment.id === selected,
          disabled: segment.disabled,
          title: segment.disabled ? t('pane.view.trajectoryDisabled') : t('pane.view.title'),
          style: {
            ...segmentStyle,
            ...(segment.id === selected ? segmentActiveStyle : {}),
            ...(segment.disabled ? segmentDisabledStyle : {}),
          },
          onClick: () => {
            if (segment.disabled) return
            controller.setView(pane.paneId, segment.id)
          },
        },
        labels[segment.id] ?? segment.id,
      ),
    ),
  )
}

/**
 * One pane: header actions plus the session-scoped child slot.
 *
 * The element type is module-level and the key is the pane id, so the pane is
 * never remounted by a layout change. Only a session replacement resets the
 * conversation subtree (the boundary below is keyed by session id).
 *
 * @param {{ controller: any, pane: object, rect: object, focused: boolean, kit: any, t: (key: string) => string }} props
 */
function PaneFrame({ controller, pane, rect, focused, kit, t }) {
  const React = react()
  const h = React.createElement
  const reference = controller.paneReference(pane.paneId)
  const title =
    typeof kit.useSessions === 'function'
      ? kit.useSessions((snapshot) => snapshot.byId[pane.sessionId]?.title)
      : undefined

  const close = () => controller.closePane(pane.paneId)
  const focus = () => {
    if (!focused) controller.focusPane(pane.paneId)
  }

  const frameStyle = {
    position: 'absolute',
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    boxSizing: 'border-box',
    // A visible focus ring is the only reliable "this pane receives input"
    // signal in a split view (issue 05; Agent10's flat strip lost it).
    outline: focused
      ? '2px solid var(--dsw-alias-border-accent, Highlight)'
      : '2px solid transparent',
    outlineOffset: '-2px',
    zIndex: focused ? 1 : 0,
    background: 'var(--dsw-alias-bg-base, Canvas)',
    color: 'var(--dsw-alias-label-primary, CanvasText)',
  }

  const header = h(
    'div',
    { style: headerStyle },
    h('span', { style: titleStyle }, title ?? t('pane.title')),
    h(PaneViewSwitch, { key: 'view', controller, pane, t }),
    h(
      'button',
      {
        type: 'button',
        style: buttonStyle,
        title: t('pane.splitRight'),
        'aria-label': t('pane.splitRight'),
        onClick: () => {
          controller.split(pane.paneId, 'row')
        },
      },
      '⫽',
    ),
    h(
      'button',
      {
        type: 'button',
        style: buttonStyle,
        title: t('pane.splitDown'),
        'aria-label': t('pane.splitDown'),
        onClick: () => {
          controller.split(pane.paneId, 'col')
        },
      },
      '⫙',
    ),
    h(
      'button',
      {
        type: 'button',
        style: buttonStyle,
        title: t('pane.close'),
        'aria-label': t('pane.close'),
        onClick: close,
      },
      '×',
    ),
  )

  let body
  if (reference === undefined) {
    body = h(PaneFallback, {
      t,
      text: t('pane.empty.title'),
      detail: t('pane.empty.body'),
      label: t('pane.close'),
      onBack: close,
    })
  } else if (typeof kit.SessionProvider !== 'function' || typeof kit.renderSlot !== 'function') {
    body = h(PaneFallback, {
      t,
      text: t('pane.fallback.title'),
      detail: t('pane.fallback.error'),
      label: t('pane.close'),
      onBack: close,
    })
  } else {
    const boundary = errorBoundaryClass()
    body = h(
      boundary,
      {
        key: pane.sessionId,
        fallback: (error) =>
          h(PaneFallback, {
            t,
            text: t('pane.fallback.title'),
            detail: `${t('pane.fallback.error')} (${error instanceof Error ? error.message : String(error)})`,
            label: t('pane.close'),
            onBack: close,
          }),
      },
      h(kit.SessionProvider, { session: reference }, kit.renderSlot(PANE_SLOT, {})),
    )
  }

  return h(
    'div',
    {
      style: frameStyle,
      'data-hkcraft-pane': pane.paneId,
      'data-hkcraft-pane-active': focused ? 'true' : 'false',
      onPointerDownCapture: focus,
    },
    header,
    h('div', { style: bodyStyle }, body),
  )
}

/**
 * One draggable separator. Its own size is read from the layout box at drag
 * start, so the clamp uses real pixels (`ratioFromDrag`) rather than the
 * fraction alone: a pane can never be dragged below the minimum width/height.
 *
 * @param {{ controller: any, separator: object, t: (key: string) => string }} props
 */
function PaneSeparator({ controller, separator }) {
  const React = react()
  const h = React.createElement
  const drag = React.useRef(null)
  const row = separator.dir === 'row'

  const hitStyle = row
    ? {
        position: 'absolute',
        left: `${separator.x * 100}%`,
        top: `${separator.y * 100}%`,
        height: `${separator.height * 100}%`,
        width: SEPARATOR_HIT_PX,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        cursor: 'col-resize',
        touchAction: 'none',
        zIndex: 2,
      }
    : {
        position: 'absolute',
        left: `${separator.x * 100}%`,
        top: `${separator.y * 100}%`,
        width: `${separator.width * 100}%`,
        height: SEPARATOR_HIT_PX,
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'center',
        cursor: 'row-resize',
        touchAction: 'none',
        zIndex: 2,
      }

  const lineStyle = row
    ? { width: SEPARATOR_LINE_PX, background: 'color-mix(in srgb, currentColor 22%, transparent)' }
    : { height: SEPARATOR_LINE_PX, width: '100%', background: 'color-mix(in srgb, currentColor 22%, transparent)' }

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    const box = event.currentTarget.parentElement?.getBoundingClientRect?.()
    if (box === undefined) return
    drag.current = {
      // The split's own size, not the workspace: a nested split is smaller than
      // the box, and the pixel minimum must be clamped against it.
      size: (row ? box.width : box.height) * (separator.extent ?? 1),
      start: row ? event.clientX : event.clientY,
      ratio: separator.ratio,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event) => {
    const state = drag.current
    if (state === null) return
    const current = row ? event.clientX : event.clientY
    controller.resize(
      separator.path,
      ratioFromDrag({
        startRatio: state.ratio,
        deltaPx: current - state.start,
        sizePx: state.size,
      }),
    )
    event.preventDefault()
  }

  const endDrag = (event) => {
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  return h(
    'div',
    {
      role: 'separator',
      'aria-orientation': row ? 'vertical' : 'horizontal',
      'data-hkcraft-separator': separator.path.length === 0 ? 'root' : separator.path.join('/'),
      style: hitStyle,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    h('div', { style: lineStyle }),
  )
}

/** Stable stand-in so a missing hook never changes the hook call count. */
function absentHook() {
  return undefined
}

/**
 * The tab strip: the current workspace's open conversations, in `leaves()`
 * order (ticket 06, spec §5).
 *
 * Every tab is a pane — clicking it focuses that pane, its × closes the pane
 * (after a confirmation when the session is live), and `+` creates a new
 * conversation in a new pane beside the focused one. Status dots come from the
 * live session status map; nothing here reorders tabs by status.
 *
 * The title and status read the shell's root standard hooks (`useSessions`,
 * `useSessionStatus`); ui-session provides them as `sessions` and
 * `sessionStatus` (dsh-client-ui-session/lib/client.js:1104-1113), which is the
 * same pair the shipped sidebar consumes.
 *
 * @param {{ controller: any, state: any, kit: any, t: (key: string, params?: object) => string }} props
 */
function TabStrip({ controller, state, kit, t }) {
  const React = react()
  const h = React.createElement
  const useSessions = typeof kit?.useSessions === 'function' ? kit.useSessions : absentHook
  const useSessionStatus = typeof kit?.useSessionStatus === 'function' ? kit.useSessionStatus : absentHook
  const sessions = useSessions((snapshot) => snapshot)
  const statuses = useSessionStatus((snapshot) => snapshot)
  const [hovered, setHovered] = React.useState(null)
  const [creating, setCreating] = React.useState(false)

  // Ctrl+1..4 focuses the Nth tab. Document-level so the chord works from the
  // composer too; the tab strip only exists while the pane workspace is shown.
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onKeyDown = (event) => {
      const index = tabShortcutIndex(event)
      if (index === null) return
      event.preventDefault()
      controller.focusTab(index)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [controller])

  const tabs = projectTabs(state, sessions, statuses, t('session.untitled'))

  const closeTab = (tab) => {
    // Closing a pane is `controller.closePane`: idle panes close immediately,
    // a running one stages `pendingClose`, which the shared `PaneCloseConfirm`
    // dialog (ticket 09) interrupts and closes after confirmation. The strip
    // does not own a second confirmation UI.
    controller.closePane(tab.paneId)
  }

  const createTab = () => {
    if (creating) return
    setCreating(true)
    Promise.resolve(controller.newTab())
      .catch(() => {})
      .then(() => setCreating(false))
  }

  const tabElements = tabs.map((tab) => {
    const statusLabel = t(`tab.status.${tab.status}`)
    const label = tab.shortcut === undefined ? tab.title : `${tab.title} (${tab.shortcut})`
    return h(
      'div',
      {
        key: tab.paneId,
        role: 'tab',
        tabIndex: 0,
        'aria-selected': tab.focused ? 'true' : 'false',
        'aria-label': `${label} — ${statusLabel}`,
        title: `${label} — ${statusLabel}`,
        'data-hkcraft-tab': tab.paneId,
        'data-hkcraft-tab-active': tab.focused ? 'true' : 'false',
        style: {
          ...tabStyle,
          borderTopColor: tab.focused ? 'var(--dsw-alias-border-accent, Highlight)' : 'transparent',
          background: tab.focused
            ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
            : hovered === tab.paneId
              ? 'color-mix(in srgb, currentColor 6%, transparent)'
              : 'transparent',
          fontWeight: tab.focused ? 600 : 400,
        },
        onClick: () => controller.focusPane(tab.paneId),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          controller.focusPane(tab.paneId)
        },
        onMouseEnter: () => setHovered(tab.paneId),
        onMouseLeave: () => setHovered((current) => (current === tab.paneId ? null : current)),
      },
      h('span', {
        'aria-hidden': 'true',
        'data-hkcraft-tab-status': tab.status,
        style: { ...tabDotStyle, background: TAB_STATUS_COLORS[tab.status] ?? TAB_STATUS_COLORS[TAB_STATUS_IDLE] },
      }),
      h('span', { style: tabTitleStyle }, tab.title),
      h(
        'button',
        {
          type: 'button',
          title: t('tab.close'),
          'aria-label': t('tab.close'),
          'data-hkcraft-tab-close': tab.paneId,
          style: { ...tabCloseStyle, visibility: hovered === tab.paneId ? 'visible' : 'hidden' },
          onClick: (event) => {
            event.stopPropagation()
            closeTab(tab)
          },
          onKeyDown: (event) => event.stopPropagation(),
        },
        '×',
      ),
    )
  })

  return h(
    'div',
    {
      role: 'tablist',
      'aria-label': t('tab.aria'),
      'data-hkcraft-tabstrip': '',
      style: tabStripStyle,
    },
    h('div', { style: tabViewportStyle }, tabElements),
    h(
      'button',
      {
        type: 'button',
        title: t('tab.new'),
        'aria-label': t('tab.new'),
        'data-hkcraft-tab-new': '',
        disabled: creating,
        style: { ...tabNewStyle, opacity: creating ? 0.55 : 1, cursor: creating ? 'default' : 'pointer' },
        onClick: createTab,
      },
      '＋',
    ),
  )
}

/**
 * The interrupt confirmation for closing a running pane (spec D4). It is
 * rendered by the pane host itself, so it exists only while the pane panel is
 * selected; cancelling dismisses it without touching the session.
 *
 * @param {{ controller: any, t: (key: string) => string }} props
 */
function PaneCloseConfirm({ controller, t }) {
  const React = react()
  const h = React.createElement
  const state = usePaneSnapshot(React, controller)
  const pending = state.pendingClose
  if (pending === null || pending === undefined) return null

  const confirm = () => {
    const attempt = controller.confirmClose()
    if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
      attempt.catch(() => {})
    }
  }

  return h(
    'div',
    { style: closeOverlayStyle },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('pane.close.confirm.title'),
        style: closeDialogStyle,
      },
      pending.title === undefined ? null : h('div', { style: closeTitleStyle }, pending.title),
      h(
        'div',
        { style: { fontWeight: 600, marginBottom: 6 } },
        t('pane.close.confirm.title'),
      ),
      h('div', { style: { opacity: 0.78 } }, t('pane.close.confirm.body')),
      state.closeError === null
        ? null
        : h(
            'div',
            { role: 'alert', style: closeErrorStyle },
            `${t('pane.close.confirm.error')}: ${state.closeError}`,
          ),
      h(
        'div',
        { style: closeActionsStyle },
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            disabled: state.closeBusy,
            onClick: () => controller.cancelClose(),
          },
          t('pane.close.confirm.cancel'),
        ),
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            disabled: state.closeBusy,
            onClick: confirm,
          },
          state.closeBusy ? t('pane.close.confirm.busy') : t('pane.close.confirm.action'),
        ),
      ),
    ),
  )
}

/**
 * The `main` keyed-slot entry. dsh hands it `SessionProvider` and the
 * authorized `renderSlot` for a session-scoped child because the registration
 * declares one non-root child.
 */
function createPaneHost(controller) {
  return function PaneHost(props) {
    const React = react()
    const h = React.createElement
    const t = createTranslator(props)
    const state = usePaneSnapshot(React, controller)

    React.useEffect(() => {
      // Probe at mount, after the shell has finished loading sibling plugins.
      controller.refreshProbe()
    }, [])

    if (!state.active) return null

    const dialog = h(PaneCloseConfirm, { controller, t })

    if (state.root === null) {
      return h(
        React.Fragment,
        null,
        h(PaneEmptyState, {
          t,
          onNew: () => {
            const attempt = controller.newInFocused()
            if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
              attempt.catch(() => {})
            }
          },
        }),
        dialog,
      )
    }

    const geometry = computeLayout(state.root)
    return h(
      React.Fragment,
      null,
      h(
        'div',
        { style: workspaceStyle, 'data-hkcraft-workspace': '' },
        h(TabStrip, { controller, state, kit: props, t }),
        h(
          'div',
          { style: layoutStyle, 'data-hkcraft-layout': '' },
          geometry.panes.map((paneRect) => {
            const pane = state.panes[paneRect.paneId]
            if (pane === undefined) return null
            return h(PaneFrame, {
              key: paneRect.paneId,
              controller,
              pane,
              rect: paneRect,
              focused: paneRect.paneId === state.activePaneId,
              kit: props,
              t,
            })
          }),
          geometry.separators.map((separator) =>
            h(PaneSeparator, {
              key: separator.path.length === 0 ? 'root' : separator.path.join('/'),
              controller,
              separator,
            }),
          ),
        ),
      ),
      dialog,
    )
  }
}

/**
 * The session-scoped child entry. It owns the `conversation.content` render and
 * the fallback faces for a missing / crashing factory.
 */
function createPaneBody(controller) {
  return function PaneBody(props) {
    const React = react()
    const h = React.createElement
    const t = createTranslator(props)
    const state = usePaneSnapshot(React, controller)
    const sessionId = props.sessionId
    const session =
      typeof props.useSession === 'function' ? props.useSession((snapshot) => snapshot) : undefined
    const summaryBlank =
      typeof props.useSessions === 'function'
        ? props.useSessions((snapshot) =>
            sessionId === undefined ? undefined : snapshot.byId[sessionId]?.blank,
          )
        : undefined
    const { phase, hero } = derivePanePhase({ sessionId, session, summaryBlank })
    const sessionReady = session !== undefined
    React.useEffect(() => {
      if (sessionId === undefined || !sessionReady) return
      // The pane's own memory wins over dsh's per-session View preference.
      // `activate` is the same call the native tab row makes, so this swaps the
      // resident view instead of rebuilding the session.
      controller.restoreViewFor(sessionId)
    }, [sessionId, sessionReady])
    const boundary = errorBoundaryClass()
    const close = () => controller.closePaneBySession(sessionId)

    const closeButton = () =>
      h('button', { type: 'button', style: buttonStyle, onClick: close }, t('pane.close'))

    const missing = () =>
      h(PaneFallback, {
        t,
        text: t('pane.fallback.title'),
        detail: `${t('pane.fallback.missing')} (${state.probe.message ?? CONTENT_FACTORY})`,
        label: t('pane.close'),
        onBack: close,
      })

    // A missing Factory is left to the FactoryOutlet fallback: the outlet
    // subscribes to factory registrations, so a conversation plugin that loads
    // after us still recovers. A probe/render *error* is a hard fallback.
    if (state.probe.status === 'error') {
      return h(
        'div',
        { style: fallbackStyle },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('pane.fallback.title')),
        h(
          'div',
          { style: { opacity: 0.75, marginBottom: 12 } },
          `${t('pane.fallback.error')} (${state.probe.message ?? CONTENT_FACTORY})`,
        ),
        closeButton(),
      )
    }

    if (typeof props.renderFactorySlot !== 'function') {
      return h(
        'div',
        { style: fallbackStyle },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('pane.fallback.title')),
        h('div', { style: { opacity: 0.75, marginBottom: 12 } }, t('pane.fallback.error')),
        closeButton(),
      )
    }

    return h(
      boundary,
      {
        key: sessionId,
        fallback: (error) =>
          h(PaneFallback, {
            t,
            text: t('pane.fallback.title'),
            detail: `${t('pane.fallback.error')} (${error instanceof Error ? error.message : String(error)})`,
            label: t('pane.close'),
            onBack: close,
          }),
      },
      props.renderFactorySlot(
        CONTENT_FACTORY,
        { variant: 'main', phase, hero },
        { fallback: missing() },
      ),
    )
  }
}

/** Footer action: the visible native ↔ plugin pane toggle. */
function createPaneToggle(controller) {
  return function PaneToggle(props) {
    const React = react()
    const h = React.createElement
    const t = createTranslator(props)
    const state = usePaneSnapshot(React, controller)
    const label = state.active ? t('toggle.native') : t('toggle.pane')
    return h(
      'button',
      {
        type: 'button',
        title: state.error ?? t('toggle.title'),
        style: buttonStyle,
        'aria-pressed': state.active,
        onClick: () => (state.active ? controller.deactivate() : controller.activate()),
      },
      label,
    )
  }
}

module.exports = {
  PaneFrame,
  PaneSeparator,
  PaneEmptyState,
  PaneViewSwitch,
  PaneCloseConfirm,
  TabStrip,
  createPaneHost,
  createPaneBody,
  createPaneToggle,
  usePaneSnapshot,
  errorBoundaryClass,
}
