'use strict'

/**
 * Thin React shell around the pane controller. All dsh assumptions live in
 * `dsh-pane-host.js`; this file only turns controller state into elements.
 *
 * `react` is resolved lazily because unit tests load this module in Node,
 * where the platform module graph does not exist.
 */

const { createTranslator } = require('./diagnostics.js')
const { CONTENT_FACTORY, PANE_SLOT, derivePanePhase } = require('./dsh-pane-host.js')

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

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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

/** @param {{ t: (key: string) => string, text: string, detail?: string, onBack: () => void }} props */
function PaneFallback({ t, text, detail, onBack }) {
  const React = react()
  const h = React.createElement
  return h(
    'div',
    { style: fallbackStyle, role: 'status' },
    h('div', { style: { fontWeight: 600, marginBottom: 6 } }, text),
    detail === undefined ? null : h('div', { style: { opacity: 0.75, marginBottom: 12 } }, detail),
    h(
      'button',
      { type: 'button', style: buttonStyle, onClick: onBack },
      t('pane.back'),
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
    const sessionTitle =
      typeof props.useSessions === 'function'
        ? props.useSessions((snapshot) =>
            state.sessionId === null ? undefined : snapshot.byId[state.sessionId]?.title,
          )
        : undefined

    React.useEffect(() => {
      // Probe at mount, after the shell has finished loading sibling plugins.
      controller.refreshProbe()
    }, [])

    if (!state.active) return null

    const back = () => controller.deactivate()
    if (state.sessionId === null) {
      return h(
        'div',
        { style: paneStyle },
        h(PaneFallback, {
          t,
          text: t('pane.empty.title'),
          detail: t('pane.empty.body'),
          onBack: back,
        }),
      )
    }

    const reference = controller.currentReference()
    if (reference === undefined) {
      return h(
        'div',
        { style: paneStyle },
        h(PaneFallback, { t, text: t('pane.empty.title'), detail: t('pane.empty.body'), onBack: back }),
      )
    }

    if (typeof props.SessionProvider !== 'function' || typeof props.renderSlot !== 'function') {
      return h(
        'div',
        { style: paneStyle },
        h(PaneFallback, {
          t,
          text: t('pane.fallback.title'),
          detail: t('pane.fallback.error'),
          onBack: back,
        }),
      )
    }

    const boundary = errorBoundaryClass()
    return h(
      boundary,
      {
        key: state.sessionId,
        fallback: (error) =>
          h(
            'div',
            { style: paneStyle },
            h(PaneFallback, {
              t,
              text: t('pane.fallback.title'),
              detail: `${t('pane.fallback.error')} (${error instanceof Error ? error.message : String(error)})`,
              onBack: back,
            }),
          ),
      },
      h(
        'div',
        { style: paneStyle, 'data-hkcraft-pane': state.sessionId },
        h(
          'div',
          { style: headerStyle },
          h('span', { style: titleStyle }, sessionTitle ?? t('pane.title')),
          h('button', { type: 'button', style: buttonStyle, title: t('pane.back'), onClick: back }, t('pane.back')),
        ),
        h(
          'div',
          { style: bodyStyle },
          h(props.SessionProvider, { session: reference }, props.renderSlot(PANE_SLOT, {})),
        ),
      ),
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
    const back = () => controller.deactivate()

    const backToNative = () =>
      h('button', { type: 'button', style: buttonStyle, onClick: back }, t('pane.back'))

    const missing = () =>
      h(PaneFallback, {
        t,
        text: t('pane.fallback.title'),
        detail: `${t('pane.fallback.missing')} (${state.probe.message ?? CONTENT_FACTORY})`,
        onBack: back,
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
        backToNative(),
      )
    }

    if (typeof props.renderFactorySlot !== 'function') {
      return h(
        'div',
        { style: fallbackStyle },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('pane.fallback.title')),
        h('div', { style: { opacity: 0.75, marginBottom: 12 } }, t('pane.fallback.error')),
        backToNative(),
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
            onBack: back,
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
  createPaneHost,
  createPaneBody,
  createPaneToggle,
  usePaneSnapshot,
  errorBoundaryClass,
}
