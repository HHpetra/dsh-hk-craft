'use strict'

/**
 * Helpers the pane views share: the snapshot subscription, the trajectory
 * gate, the factory error boundary and the fallback face.
 *
 * `react` comes from `react-and-translator.js` and is resolved on every call.
 * Memoizing it here would pin the first Node test stand-in for the rest of
 * the process (`--test-isolation=none`). The boundary class is minted once
 * per React identity, so a swapped stand-in gets its own class and a stable
 * production React does not remount panes on every render.
 */

const { react } = require('./react-and-translator.js')
const { buttonStyle, fallbackStyle } = require('./pane-styles.js')

/** Subscribe a component to the controller's frozen snapshot. */
function usePaneSnapshot(React, controller) {
  return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

/**
 * Follow the developer-tools gate that decides whether the trajectory View
 * exists. Shared by the header toggle and the pane's `views` override so both
 * read the same source and fall back to chat together.
 */
function useTrajectoryAvailable(React, controller) {
  return React.useSyncExternalStore(
    controller.view.subscribeViewAvailability,
    controller.view.isTrajectoryAvailable,
    controller.view.isTrajectoryAvailable,
  )
}

/** @type {typeof import('react').Component|null} */
let boundaryClass = null
/** @type {object|null} the React instance `boundaryClass` extends */
let boundaryReact = null

/**
 * Error boundary around the foreign Conversation factory. React needs a class;
 * the class is minted on first render so loading this module in Node stays
 * react-free.
 */
function errorBoundaryClass() {
  const React = react()
  if (boundaryClass !== null && boundaryReact === React) return boundaryClass
  boundaryReact = React
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
    h('button', { type: 'button', className: 'hk-button hk-button--quiet', style: buttonStyle, onClick: onBack }, label ?? t('pane.close')),
  )
}

/** Swallow a controller promise the view does not await (errors surface in state). */
function runAttempt(attempt) {
  if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
    attempt.catch(() => {})
  }
}

module.exports = {
  usePaneSnapshot,
  useTrajectoryAvailable,
  errorBoundaryClass,
  PaneFallback,
  runAttempt,
}
