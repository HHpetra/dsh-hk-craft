'use strict'

/**
 * One pane: title, current mode, subagent viewer, view toggle and close,
 * above the session-scoped slot.
 *
 * Split out of `pane-view.js` because the header changes with those seats,
 * not with the strip, the empty state or the host.
 */

const { react } = require('./react-and-translator.js')
const { openCatalog } = require('./catalog.js')
const { PANE_SLOT } = require('./dsh-pane-host.js')
const {
  CHAT_VIEW,
  TRAJECTORY_VIEW,
  effectiveView,
  viewOptions,
} = require('./dsh-view-switch.js')
const { shortcutLabel, withShortcut } = require('./pane-shortcuts.js')
const { absentHook, messageOf } = require('./shared.js')
const { T } = require('./visual-tokens.js')
const { errorBoundaryClass, PaneFallback, useTrajectoryAvailable } = require('./pane-view-support.js')
const {
  bodyStyle,
  headerActionStyle,
  headerSeatStyle,
  headerStyle,
  titleStyle,
  viewToggleActiveStyle,
  viewToggleStyle,
} = require('./pane-styles.js')

/**
 * The pane's own `对话 ⇄ 轨迹` toggle (ADR-0006).
 *
 * dsh's native View switcher lives in `conversation.session.header`, which is a
 * child slot of the `main.conversation` root — the pane renders only the
 * `conversation.content` factory, so that header is never mounted here. This
 * one button replaces it per pane: its label names the view it switches *to*,
 * so the header stays down to two actions even in a narrow column.
 *
 * When developer tools are off, dsh does not offer the trajectory View at all.
 * The control is therefore absent rather than disabled (native dsh's rule), and
 * the header keeps only the close button.
 *
 * @param {{ controller: any, pane: object, t: (key: string, params?: object) => string }} props
 */
function PaneViewToggle({ controller, pane, t }) {
  const React = react()
  const h = React.createElement
  const trajectoryAvailable = useTrajectoryAvailable(React, controller)
  if (viewOptions(trajectoryAvailable).length < 2) return null
  const selected = effectiveView(pane.view, trajectoryAvailable)
  const target = selected === CHAT_VIEW ? TRAJECTORY_VIEW : CHAT_VIEW
  const labels = {
    [CHAT_VIEW]: t('pane.view.chat'),
    [TRAJECTORY_VIEW]: t('pane.view.trajectory'),
  }
  return h(
    'button',
    {
      type: 'button',
      title: t('pane.view.title'),
      // The label names the View this click switches *to*, so a pressed state
      // would describe the opposite selection; the aria-label carries both.
      'aria-label': `${t('pane.view.title')}: ${labels[selected]} → ${labels[target]}`,
      'data-hkcraft-view-toggle': selected,
      style: {
        ...viewToggleStyle,
        ...(selected === TRAJECTORY_VIEW ? viewToggleActiveStyle : {}),
      },
      onClick: () => controller.view.setView(pane.paneId, target),
    },
    labels[target],
  )
}

/**
 * One pane: `标题 + 当前模式 + 子代理 + 视图切换 + 关闭`.
 *
 * Every pane shows its own conversation's mode badge and subagent viewer; the
 * controls read that pane's session id, not the focused pane's. They disappear
 * individually when the session records no preset or has no direct subagents, so
 * the header keeps its title and two actions in the common case. Splitting lives
 * on the keyboard (`Ctrl+Shift+E`, `pane-shortcuts.js`). The element type is
 * module-level and the key is the pane id, so the pane is never remounted by a
 * layout change. Only a session replacement resets the conversation subtree (the
 * boundary below is keyed by session id).
 *
 * @param {{ controller: any, pane: object, rect: object, focused: boolean, kit: any, t: (key: string) => string, seats?: Record<string, Function>|null }} props
 */
function PaneFrame({ controller, pane, rect, focused, bodyAllowed = true, kit, t, seats }) {
  const React = react()
  const h = React.createElement
  const reference = controller.layout.paneReference(pane.paneId)
  const useSessions = typeof kit?.useSessions === 'function' ? kit.useSessions : absentHook
  const useSessionStatus =
    typeof kit?.useSessionStatus === 'function' ? kit.useSessionStatus : absentHook
  const sessions = useSessions((snapshot) => snapshot)
  const statuses = useSessionStatus((snapshot) => snapshot)
  const catalog = openCatalog({ sessions, statuses })
  const title = catalog.session(pane.sessionId)?.title

  const close = () => controller.close.request(pane.paneId)
  const focus = () => {
    if (!focused) controller.layout.focusPane(pane.paneId)
    // Pointer and keyboard focus both land here before the card's click opens
    // the review. Revealing now lets the right bar adopt this pane's session
    // before that click reads it. Already-focused panes still reveal: the
    // shell current can name another session without a layout change.
    controller.revealFocusedSession?.()
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
    // the document, so this pair resolves on both the light and the dark theme.
    // `box-shadow` replaces `outline` so the ring never paints outside the
    // workspace box or collides with a neighbouring pane's ring.
    boxShadow: focused
      ? 'inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight))'
      : `inset 0 0 0 1px ${T.border2}`,
    zIndex: focused ? 1 : 0,
    background: T.surface,
    color: T.text,
  }

  const closeHint = withShortcut(t('pane.close'), shortcutLabel('close-pane'))

  const header = h(
    'div',
    { style: headerStyle, 'data-hkcraft-pane-header': '' },
    h('span', { style: titleStyle }, title ?? t('pane.title')),
    seats?.mode
      ? h(seats.mode, {
          key: 'mode',
          controller,
          sessionId: pane.sessionId,
          catalog,
          t,
          seatStyle: { ...headerSeatStyle, maxWidth: 140 },
        })
      : null,
    seats?.subagents
      ? h(seats.subagents, {
          key: 'subagents',
          controller,
          sessionId: pane.sessionId,
          catalog,
          t,
          seatStyle: { ...headerSeatStyle, maxWidth: 160 },
        })
      : null,
    h(PaneViewToggle, { key: 'view', controller, pane, t }),
    h(
      'button',
      {
        type: 'button',
        style: { ...headerActionStyle, marginLeft: 'auto' },
        title: closeHint,
        'aria-label': t('pane.close'),
        'data-hkcraft-pane-close': pane.paneId,
        onClick: close,
      },
      '×',
    ),
  )

  // The conversation body is memoised on its own inputs, not on the store
  // snapshots the header subscribes to. A session-list or status tick
  // re-renders this frame (the title and the seats follow it), but the element
  // below keeps its identity, so React bails out of the conversation subtree.
  // `t`, `kit`, `reference` and `controller` only change when the shell or the
  // layout really changes.
  //
  // `bodyAllowed` is the cold-start ordering seam (#13): the focused pane's
  // conversation mounts in the first frame, every other pane in the next one.
  // A disallowed pane keeps its header and an empty body; it is never unmounted.
  const body = React.useMemo(() => {
    if (!bodyAllowed) return null
    if (reference === undefined) {
      return h(PaneFallback, {
        t,
        text: t('pane.empty.title'),
        detail: t('pane.empty.body'),
        label: t('pane.close'),
        onBack: close,
      })
    }
    if (typeof kit.SessionProvider !== 'function' || typeof kit.renderSlot !== 'function') {
      return h(PaneFallback, {
        t,
        text: t('pane.fallback.title'),
        detail: t('pane.fallback.error'),
        label: t('pane.close'),
        onBack: close,
      })
    }
    const boundary = errorBoundaryClass()
    return h(
      boundary,
      {
        key: pane.sessionId,
        fallback: (error) =>
          h(PaneFallback, {
            t,
            text: t('pane.fallback.title'),
            detail: `${t('pane.fallback.error')} (${messageOf(error)})`,
            label: t('pane.close'),
            onBack: close,
          }),
      },
      h(kit.SessionProvider, { session: reference }, kit.renderSlot(PANE_SLOT, {})),
    )
  }, [reference, pane.sessionId, kit, t, controller, bodyAllowed])

  return h(
    'div',
    {
      style: frameStyle,
      'data-hkcraft-pane': pane.paneId,
      'data-hkcraft-pane-active': focused ? 'true' : 'false',
      onPointerDownCapture: focus,
      onFocusCapture: focus,
    },
    header,
    h('div', { style: bodyStyle }, body),
  )
}

module.exports = { PaneFrame, PaneViewToggle }
