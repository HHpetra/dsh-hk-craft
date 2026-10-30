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
  paneShortcutAction,
  paneShortcutHint,
  shortcutLabel,
  withShortcut,
} = require('./pane-shortcuts.js')
const { buildResumeRows } = require('./resume-list.js')
const {
  TAB_STATUS_ERROR,
  TAB_STATUS_IDLE,
  TAB_STATUS_RUNNING,
  TAB_STATUS_WAITING,
  projectTabs,
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

/**
 * The host box every workspace layer lives in. It is positioned so hidden
 * workspaces can be absolutely covered by `display: none` without unmounting.
 */
const hostStyle = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  width: '100%',
  overflow: 'hidden',
}

/** A workspace that stays mounted but is not the visible one (spec D5). */
const hiddenWorkspaceStyle = {
  position: 'absolute',
  inset: 0,
  display: 'none',
  minWidth: 0,
  minHeight: 0,
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
  // Always reserved, so focusing a tab never changes its width or the row's
  // geometry (ticket 10: status/focus must not shift the strip).
  borderTop: '2px solid transparent',
  borderRight: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  userSelect: 'none',
  // Pointer dragging (not HTML5 DnD) needs the browser not to claim the gesture.
  touchAction: 'none',
}

/** Titles truncate instead of squeezing their neighbours (spec §5). */
const tabTitleStyle = {
  maxWidth: 128,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * A fixed-size dot whose two rings (the tab background and a `currentColor`
 * halo) keep it legible on both the light and the dark palette. Neither ring
 * takes part in layout, and the dot is always rendered — running/waiting/idle
 * changes only its colour, never the row's geometry.
 */
const tabDotStyle = {
  flex: 'none',
  width: 7,
  height: 7,
  borderRadius: '50%',
  boxShadow:
    '0 0 0 1px var(--dsw-alias-bg-base, Canvas), 0 0 0 2px color-mix(in srgb, currentColor 32%, transparent)',
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
  borderLeft: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: 0,
  padding: '0 10px',
}

/**
 * Dot colours per tab status. Running and waiting use the shell's state tokens
 * so they follow the active palette; idle green and the error orange have no
 * matching token today and stay explicit mid-tones, which read on both the
 * light and the dark background once the adaptive ring above is applied.
 */
const TAB_STATUS_COLORS = {
  [TAB_STATUS_RUNNING]: 'var(--dsw-alias-state-warn-primary, #d9a400)',
  [TAB_STATUS_WAITING]: 'var(--dsw-alias-state-error-primary, #e5484d)',
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
  borderBottom: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
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

/** How many recent conversations the empty state offers. */
const EMPTY_RECENT_LIMIT = 5

/** The empty state's hero plus its recent list, centred in the workspace box. */
const emptyStackStyle = {
  margin: 'auto',
  width: '100%',
  maxWidth: 520,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1.6,
  boxSizing: 'border-box',
}

const emptyActionStyle = { ...buttonStyle, alignSelf: 'center' }

const recentHeadingStyle = {
  marginTop: 6,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  opacity: 0.6,
  textAlign: 'left',
}

const recentListStyle = { display: 'flex', flexDirection: 'column', gap: 4 }

const recentRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
  borderRadius: 6,
  background: 'color-mix(in srgb, currentColor 4%, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '20px',
  cursor: 'pointer',
  padding: '4px 8px',
  textAlign: 'left',
}

const recentLabelStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const recentDetailStyle = { flex: 'none', opacity: 0.6, fontSize: 11 }

const recentBadgeStyle = {
  flex: 'none',
  fontSize: 10,
  lineHeight: '16px',
  padding: '0 5px',
  borderRadius: 999,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  opacity: 0.8,
}

const hintStyle = {
  marginTop: 6,
  fontSize: 11,
  lineHeight: 1.5,
  opacity: 0.62,
  textAlign: 'center',
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

/** Swallow a controller promise the view does not await (errors surface in state). */
function runAttempt(attempt) {
  if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
    attempt.catch(() => {})
  }
}

/**
 * The document-level pane shortcuts (ticket 10).
 *
 * Only the visible workspace mounts this, so a hidden tree cannot answer a
 * chord. The bindings come from `pane-shortcuts.js`, which is also the source
 * of every tooltip/hint, so the UI can never advertise a different chord.
 * Shell modal layers own the keyboard while they are open — the shell's own
 * shortcut service blocks background commands the same way.
 *
 * @param {{ controller: any, workspaceId: string|null }} props
 * @returns {null}
 */
function PaneShortcuts({ controller, workspaceId }) {
  const React = react()
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onKeyDown = (event) => {
      const action = paneShortcutAction(event)
      if (action === null) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return

      if (action.kind === 'focus') {
        event.preventDefault()
        controller.focusTab(action.index)
        return
      }
      if (action.kind === 'new') {
        event.preventDefault()
        event.stopPropagation()
        runAttempt(controller.newInFocused(workspaceId ?? undefined))
        return
      }
      const pane = controller.focusedPane()
      if (pane === null) return
      event.preventDefault()
      event.stopPropagation()
      if (action.kind === 'split') runAttempt(controller.split(pane.paneId, action.dir))
      else if (action.kind === 'close') controller.closePane(pane.paneId)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [controller, workspaceId])
  return null
}

/**
 * The empty state: the workspace has no panes at all (ticket 10).
 *
 * It offers the two ways back in — a new conversation in the first pane
 * (`/clear`'s host-side path, `newInFocused`) and one of the workspace's recent
 * conversations. The recent rows are built by the same `/resume` pipeline
 * (`controller.recentConversations` → `buildResumeRows`): same workspace
 * scoping, same blank/archived filtering, same newest-first order, same
 * title → first-prompt fallback.
 *
 * @param {{ controller: any, workspaceId: string|null, visible: boolean, t: (key: string) => string }} props
 */
function PaneEmptyState({ controller, workspaceId, visible, t }) {
  const React = react()
  const h = React.createElement
  const [recent, setRecent] = React.useState(null)
  const tRef = React.useRef(t)
  tRef.current = t

  React.useEffect(() => {
    if (!visible) return undefined
    let cancelled = false
    // The empty state has no session to anchor `/resume` to, so the controller
    // projects the workspace directly through the same adapter.
    Promise.resolve(controller.recentConversations(workspaceId ?? undefined))
      .then((rows) => {
        if (cancelled) return
        const projected = buildResumeRows(rows, {
          now: Date.now(),
          t: tRef.current,
          limits: { title: 48, prompt: 32, label: 96 },
        })
        setRecent(projected.slice(0, EMPTY_RECENT_LIMIT))
      })
      .catch(() => {
        if (!cancelled) setRecent([])
      })
    return () => {
      cancelled = true
    }
  }, [controller, workspaceId, visible])

  const startNew = () => {
    runAttempt(controller.newInFocused(workspaceId ?? undefined))
  }

  return h(
    'div',
    { style: paneStyle, 'data-hkcraft-empty': '' },
    h(
      'div',
      { style: emptyStackStyle },
      h(
        'div',
        { style: { fontWeight: 600, fontSize: 15, marginBottom: 2 } },
        t('pane.empty.workspace.title'),
      ),
      h('div', { style: { opacity: 0.75 } }, t('pane.empty.workspace.body')),
      h(
        'button',
        {
          type: 'button',
          style: emptyActionStyle,
          title: withShortcut(t('pane.empty.new'), shortcutLabel('new-conversation')),
          onClick: startNew,
        },
        t('pane.empty.new'),
      ),
      recent === null
        ? null
        : recent.length === 0
          ? h('div', { style: { opacity: 0.62, fontSize: 12 } }, t('command.resume.search.empty'))
          : h(
              'div',
              { style: recentListStyle, 'data-hkcraft-empty-recent': '' },
              h('div', { style: recentHeadingStyle }, t('pane.empty.recent')),
              recent.map((row) =>
                h(
                  'button',
                  {
                    key: row.sessionId,
                    type: 'button',
                    style: recentRowStyle,
                    title:
                      row.detail === undefined ? row.label : `${row.label} — ${row.detail}`,
                    'data-hkcraft-empty-session': row.sessionId,
                    onClick: () => controller.activate(row.sessionId),
                  },
                  h('span', { style: recentLabelStyle }, row.label),
                  row.badge === undefined
                    ? null
                    : h('span', { style: recentBadgeStyle }, row.badge),
                  row.detail === undefined
                    ? null
                    : h('span', { style: recentDetailStyle }, row.detail),
                ),
              ),
            ),
      h('div', { style: hintStyle }, paneShortcutHint(t)),
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
    // signal in a split view (issue 05; Agent10's flat strip lost it). The
    // shell's theme presenter writes `color-scheme` plus its palette tokens on
    // the document, so this pair resolves on both the light and the dark theme
    // (the fallbacks cover a shell without those tokens).
    outline: focused
      ? '2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight))'
      : '2px solid transparent',
    outlineOffset: '-2px',
    zIndex: focused ? 1 : 0,
    background: 'var(--dsw-alias-bg-base, Canvas)',
    color: 'var(--dsw-alias-label-primary, CanvasText)',
  }

  const splitRightHint = withShortcut(t('pane.splitRight'), shortcutLabel('split-right'))
  const splitDownHint = withShortcut(t('pane.splitDown'), shortcutLabel('split-down'))
  const closeHint = withShortcut(t('pane.close'), shortcutLabel('close-pane'))

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
        title: splitRightHint,
        'aria-label': splitRightHint,
        onClick: () => {
          runAttempt(controller.split(pane.paneId, 'row'))
        },
      },
      '⫽',
    ),
    h(
      'button',
      {
        type: 'button',
        style: buttonStyle,
        title: splitDownHint,
        'aria-label': splitDownHint,
        onClick: () => {
          runAttempt(controller.split(pane.paneId, 'col'))
        },
      },
      '⫙',
    ),
    h(
      'button',
      {
        type: 'button',
        style: buttonStyle,
        title: closeHint,
        'aria-label': closeHint,
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
  const [hot, setHot] = React.useState(false)
  const row = separator.dir === 'row'

  const lineColor = hot
    ? 'color-mix(in srgb, currentColor 55%, transparent)'
    : 'color-mix(in srgb, currentColor 30%, transparent)'

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
    ? { width: SEPARATOR_LINE_PX, background: lineColor }
    : { height: SEPARATOR_LINE_PX, width: '100%', background: lineColor }

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
      onPointerEnter: () => setHot(true),
      onPointerLeave: () => setHot(false),
    },
    h('div', { style: lineStyle }),
  )
}

/** Stable stand-in so a missing hook never changes the hook call count. */
function absentHook() {
  return undefined
}

/** Drags shorter than this stay clicks (spec §5's 6px threshold). */
const TAB_DRAG_THRESHOLD_PX = 6

/** @param {any} target event target @returns {boolean} */
function insideTabClose(target) {
  return typeof target?.closest === 'function' && target.closest('[data-hkcraft-tab-close]') !== null
}

/**
 * The pane whose tab is under the pointer, or null. Pointer capture keeps the
 * move events on the source tab, so the drop target has to be hit-tested.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string|null}
 */
function tabPaneIdAt(clientX, clientY) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null
  const element = document.elementFromPoint(clientX, clientY)
  const tab = typeof element?.closest === 'function' ? element.closest('[data-hkcraft-tab]') : null
  const paneId = tab?.getAttribute?.('data-hkcraft-tab')
  return typeof paneId === 'string' && paneId !== '' ? paneId : null
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
  const [drag, setDrag] = React.useState(null)
  /** The in-flight pointer drag; state above only drives the visible feedback. */
  const dragRef = React.useRef(null)
  /** A drag's pointerup is followed by a click; that click must not re-focus. */
  const suppressClick = React.useRef(false)

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

  const clearDrag = () => {
    dragRef.current = null
    setDrag(null)
  }

  /**
   * Start a pointer drag. The close button keeps its own click; a drag must
   * never steal it.
   */
  const onTabPointerDown = (tab) => (event) => {
    if (event.button !== undefined && event.button !== 0) return
    if (insideTabClose(event.target)) return
    dragRef.current = {
      sourcePaneId: tab.paneId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetPaneId: null,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onTabPointerMove = (event) => {
    const current = dragRef.current
    if (current === null) return
    if (!current.active) {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY)
      if (distance < TAB_DRAG_THRESHOLD_PX) return
      current.active = true
      setDrag({ sourcePaneId: current.sourcePaneId, targetPaneId: null })
    }
    const over = tabPaneIdAt(event.clientX, event.clientY)
    const targetPaneId = over === null || over === current.sourcePaneId ? null : over
    if (targetPaneId !== current.targetPaneId) {
      current.targetPaneId = targetPaneId
      setDrag({ sourcePaneId: current.sourcePaneId, targetPaneId })
    }
    event.preventDefault()
  }

  const onTabPointerUp = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!current.active) return
    // Dropping anywhere but another tab is a complete no-op: no swap, no focus
    // change, no layout write. The following click is swallowed once.
    suppressClick.current = true
    if (current.targetPaneId !== null) {
      controller.swapPanes(current.sourcePaneId, current.targetPaneId)
    }
    if (typeof globalThis.setTimeout === 'function') {
      globalThis.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
  }

  const onTabPointerCancel = (event) => {
    clearDrag()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const focusTab = (tab) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    controller.focusPane(tab.paneId)
  }

  const hint = paneShortcutHint(t)

  const tabElements = tabs.map((tab) => {
    const statusLabel = t(`tab.status.${tab.status}`)
    const label = tab.shortcut === undefined ? tab.title : `${tab.title} (${tab.shortcut})`
    const source = drag !== null && drag.sourcePaneId === tab.paneId
    const target = drag !== null && drag.targetPaneId === tab.paneId
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
        'data-hkcraft-tab-drop-target': target ? 'true' : 'false',
        style: {
          ...tabStyle,
          opacity: source ? 0.55 : 1,
          // Both a highlighted tab and a drop target use the shell's business
          // accent token, which the theme presenter rewrites per palette.
          borderTopColor: tab.focused
            ? 'var(--dsw-alias-state-business-primary, Highlight)'
            : 'transparent',
          background: target
            ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 18%, transparent)'
            : tab.focused
              ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
              : hovered === tab.paneId
                ? 'color-mix(in srgb, currentColor 6%, transparent)'
                : 'transparent',
          outline: target
            ? '2px dashed var(--dsw-alias-state-business-primary, Highlight)'
            : '2px solid transparent',
          outlineOffset: target ? '-3px' : 0,
          cursor: drag === null ? 'pointer' : 'grabbing',
        },
        onClick: () => focusTab(tab),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          focusTab(tab)
        },
        onPointerDown: onTabPointerDown(tab),
        onPointerMove: onTabPointerMove,
        onPointerUp: onTabPointerUp,
        onPointerCancel: onTabPointerCancel,
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
          style: {
            ...tabCloseStyle,
            // `visibility` (not `display`) keeps the space reserved, so hovering
            // a tab can never resize it or shift its neighbours.
            visibility: hovered === tab.paneId ? 'visible' : 'hidden',
            background:
              hovered === tab.paneId
                ? 'color-mix(in srgb, currentColor 16%, transparent)'
                : 'transparent',
          },
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
      // The full key table lives here and in the empty state, built from the
      // same labels the listener accepts.
      title: hint,
      style: tabStripStyle,
    },
    h('div', { style: tabViewportStyle }, tabElements),
    h(
      'button',
      {
        type: 'button',
        title: withShortcut(t('tab.new'), shortcutLabel('new-conversation')),
        'aria-label': withShortcut(t('tab.new'), shortcutLabel('new-conversation')),
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
 * One workspace's tree. Every loaded workspace gets one of these and stays
 * mounted; `visible` only flips `display` (ticket 08, spec D5).
 *
 * @param {{ controller: any, workspaceId: string|null, layout: object, visible: boolean, kit: any, t: (key: string) => string }} props
 */
function PaneWorkspace({ controller, workspaceId, layout, visible, kit, t }) {
  const React = react()
  const h = React.createElement
  const attributes = {
    style: visible ? workspaceStyle : hiddenWorkspaceStyle,
    'data-hkcraft-workspace': workspaceId ?? '',
    'data-hkcraft-workspace-active': visible ? 'true' : 'false',
    'aria-hidden': visible ? undefined : 'true',
  }
  // Only the visible workspace owns the document-level shortcut listener, so a
  // hidden tree can never answer a chord for the user.
  const shortcuts = visible
    ? h(PaneShortcuts, { key: 'pane-shortcuts', controller, workspaceId })
    : null

  if (layout.root === null) {
    return h(
      'div',
      attributes,
      shortcuts,
      h(PaneEmptyState, { controller, workspaceId, visible, t }),
    )
  }

  const geometry = computeLayout(layout.root)
  return h(
    'div',
    attributes,
    shortcuts,
    // Only the visible workspace owns a tab strip: hidden strips would render a
    // second row over an invisible tree. The pane bodies below stay mounted
    // regardless, which is what D5 actually protects.
    visible ? h(TabStrip, { controller, state: layout, kit, t }) : null,
    h(
      'div',
      { style: layoutStyle, 'data-hkcraft-layout': '' },
      geometry.panes.map((paneRect) => {
        const pane = layout.panes[paneRect.paneId]
        if (pane === undefined) return null
        return h(PaneFrame, {
          key: paneRect.paneId,
          controller,
          pane,
          rect: paneRect,
          focused: visible && paneRect.paneId === layout.activePaneId,
          kit,
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
  )
}

/**
 * The workspace trees to render. `layouts` is the authoritative map; the
 * unscoped layout (a shell with no workspaces service, or a unit-test fake) is
 * not in it and is appended by hand. Exactly one group is visible.
 *
 * @param {any} state controller snapshot
 * @returns {Array<{workspaceId: string|null, layout: object, visible: boolean}>}
 */
function workspaceGroups(state) {
  const entries = Object.entries(state.layouts ?? {})
  const visibleWorkspaceId =
    state.workspaceId !== null && state.layouts?.[state.workspaceId] !== undefined
      ? state.workspaceId
      : (entries[0]?.[0] ?? state.workspaceId)
  const groups = entries.map(([workspaceId, layout]) => ({
    workspaceId,
    layout,
    visible: workspaceId === visibleWorkspaceId,
  }))
  if (state.workspaceId === null && (state.root !== null || groups.length === 0)) {
    groups.push({
      workspaceId: null,
      layout: { root: state.root, panes: state.panes, activePaneId: state.activePaneId },
      visible: state.root !== null || groups.length === 0,
    })
  }
  return groups
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

    // One dialog for the whole pane host: a close is a single pending action
    // even though several workspace trees are mounted at once.
    const dialog = h(PaneCloseConfirm, { controller, t })

    return h(
      React.Fragment,
      null,
      h(
        'div',
        { style: hostStyle, 'data-hkcraft-layout-host': '' },
        workspaceGroups(state).map((group) =>
          h(PaneWorkspace, {
            key: group.workspaceId ?? '\u0000unscoped',
            controller,
            workspaceId: group.workspaceId,
            layout: group.layout,
            visible: group.visible,
            kit: props,
            t,
          }),
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
  PaneShortcuts,
  PaneWorkspace,
  workspaceGroups,
  PaneViewSwitch,
  PaneCloseConfirm,
  TabStrip,
  createPaneHost,
  createPaneBody,
  createPaneToggle,
  usePaneSnapshot,
  errorBoundaryClass,
}
