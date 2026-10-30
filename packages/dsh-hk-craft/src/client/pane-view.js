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
const { computeLayout, SEPARATOR_HIT_PX, SEPARATOR_LINE_PX } = require('./layout-geometry.js')
const { ratioFromDrag } = require('./layout-tree.js')

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

/** The workspace box every pane rect is a fraction of. */
const layoutStyle = {
  position: 'relative',
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  width: '100%',
  overflow: 'hidden',
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
  PaneCloseConfirm,
  createPaneHost,
  createPaneBody,
  createPaneToggle,
  usePaneSnapshot,
  errorBoundaryClass,
}
