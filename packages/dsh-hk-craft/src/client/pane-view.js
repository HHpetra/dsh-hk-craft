'use strict'

/**
 * Thin React shell around the pane controller. All dsh assumptions live in
 * `dsh-pane-host.js` (and are recorded in `doc/upstream-contracts.md`); this
 * file only turns controller state into elements.
 *
 * Layout rendering keeps every pane mounted: the pure geometry projection
 * (`layout-geometry.js`) turns the tree into flat, fractional rectangles, and
 * each pane is an absolutely positioned sibling keyed by `paneId`. A split or a
 * close therefore changes inline styles only — React never re-parents a pane,
 * so streaming output, scroll position and the composer draft survive.
 *
 * Static styles live in `pane-styles.js`, shared helpers in `shared.js`.
 * `react` is resolved lazily because unit tests load this module in Node, where
 * the platform module graph does not exist.
 */

const { createTranslator } = require('./react-and-translator.js')
const { openCatalog } = require('./catalog.js')
const {
  CONTENT_FACTORY,
  PANE_SLOT,
  UNSCOPED_WORKSPACE,
  derivePanePhase,
} = require('./dsh-pane-host.js')
const {
  CHAT_VIEW,
  TRAJECTORY_VIEW,
  effectiveView,
  viewOptions,
} = require('./dsh-view-switch.js')
const { computeLayout, SEPARATOR_HIT_PX, SEPARATOR_LINE_PX } = require('./layout-geometry.js')
const { ratioFromDrag } = require('./layout-tree.js')
const {
  paneShortcutAction,
  paneShortcutHint,
  shortcutLabel,
  withShortcut,
} = require('./pane-shortcuts.js')
const { EMPTY_STATE_LIMITS, buildResumeRows } = require('./resume-list.js')
const { absentHook } = require('./shared.js')
const { STRIP_STATUS_COLORS } = require('./status-colors.js')
const { STRIP_STATUS_IDLE, projectStrip } = require('./pane-strip.js')
const { DEFAULT_MAX_PANES, paneBudgetBlocked } = require('./pane-budget.js')
const {
  buttonStyle,
  paneStyle,
  workspaceStyle,
  layoutStyle,
  hostStyle,
  hiddenWorkspaceStyle,
  paneStripStyle,
  stripActionGroupStyle,
  stripRightbarStyle,
  stripViewportStyle,
  stripTablistStyle,
  headerSeatStyle,
  stripItemStyle,
  stripTitleStyle,
  stripDotStyle,
  stripCloseStyle,
  stripNewStyle,
  headerStyle,
  titleStyle,
  bodyStyle,
  fallbackStyle,
  emptyStackStyle,
  emptyActionStyle,
  recentHeadingStyle,
  recentListStyle,
  recentRowStyle,
  recentLabelStyle,
  recentDetailStyle,
  recentBadgeStyle,
  hintStyle,
  viewToggleStyle,
  viewToggleActiveStyle,
  headerActionStyle,
  closeOverlayStyle,
  closeDialogStyle,
  closeTitleStyle,
  closeActionsStyle,
  closeErrorStyle,
} = require('./pane-styles.js')

let reactModule = null

/**
 * The `conversation.content` occurrence a pane mounts.
 *
 * ui-conversation ships two occurrences of that Factory. The `main` one is
 * rendered inside `main.conversation`, whose `.root[data-phase]` element pins
 * the composer (`position: sticky; bottom: 0`), centres the hero and lets the
 * transcript own the scrollport. The `embedded` one is the supported non-root
 * occurrence: the same rules hang off its own `[data-content-phase]` body
 * (`ConversationRoot.module.css` in `@deepseek-ai/dsh-client-ui-conversation`
 * 0.2.1-rc.5). A pane has no `.root`, so `main` left the composer seat in normal
 * flow at the end of the transcript — the split view showed the messages and no
 * input box.
 */
const PANE_CONTENT_OCCURRENCE = 'embedded'

/** @returns {any} the platform React instance */
function react() {
  if (reactModule === null) reactModule = require('react')
  return reactModule
}

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
    controller.subscribeViewAvailability,
    controller.isTrajectoryAvailable,
    controller.isTrajectoryAvailable,
  )
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
    h('button', { type: 'button', style: buttonStyle, onClick: onBack }, label ?? t('pane.close')),
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
 * `Mod+N` is not in this table: it is identical to `/clear` (spec D8) and is
 * bound by `commands.js` while split mode is active, so it also works when
 * the document focus is inside the conversation composer.
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
        controller.focusPaneAt(action.index)
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

/** How many recent conversations the empty state offers. */
const EMPTY_RECENT_LIMIT = 5

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
 * @param {{ controller: any, workspaceId: string|null, visible: boolean, error?: string|null, t: (key: string) => string }} props
 */
function PaneEmptyState({ controller, workspaceId, visible, error = null, t }) {
  const React = react()
  const h = React.createElement
  const [recent, setRecent] = React.useState(null)
  const tRef = React.useRef(t)
  tRef.current = t

  React.useEffect(() => {
    if (!visible) return undefined
    let cancelled = false
    const applyRows = (rows) => {
      if (cancelled) return
      const projected = buildResumeRows(rows, {
        now: Date.now(),
        t: tRef.current,
        limits: EMPTY_STATE_LIMITS,
      })
      setRecent(projected.slice(0, EMPTY_RECENT_LIMIT))
    }
    // The workspace catalog is ready before the session list. A single read
    // at mount records that gap as "no past conversations" and never retries.
    if (typeof controller.watchConversations === 'function') {
      const stop = controller.watchConversations(workspaceId ?? undefined, applyRows)
      return () => {
        cancelled = true
        if (typeof stop === 'function') stop()
      }
    }
    Promise.resolve(controller.recentConversations(workspaceId ?? undefined))
      .then(applyRows)
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
      typeof error === 'string' && error !== ''
        ? h(
            'div',
            { 'data-hkcraft-empty-error': '', style: { opacity: 0.8, fontSize: 12, marginTop: 8 } },
            error,
          )
        : null,
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
      onClick: () => controller.setView(pane.paneId, target),
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
function PaneFrame({ controller, pane, rect, focused, kit, t, seats }) {
  const React = react()
  const h = React.createElement
  const reference = controller.paneReference(pane.paneId)
  const useSessions = typeof kit?.useSessions === 'function' ? kit.useSessions : absentHook
  const useSessionStatus =
    typeof kit?.useSessionStatus === 'function' ? kit.useSessionStatus : absentHook
  const sessions = useSessions((snapshot) => snapshot)
  const statuses = useSessionStatus((snapshot) => snapshot)
  const catalog = openCatalog({ sessions, statuses })
  const title = catalog.session(pane.sessionId)?.title

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
    // the document, so this pair resolves on both the light and the dark theme.
    outline: focused
      ? '2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight))'
      : '2px solid transparent',
    outlineOffset: '-2px',
    zIndex: focused ? 1 : 0,
    background: 'var(--dsw-alias-bg-base, Canvas)',
    color: 'var(--dsw-alias-label-primary, CanvasText)',
  }

  const closeHint = withShortcut(t('pane.close'), shortcutLabel('close-pane'))

  const header = h(
    'div',
    { style: headerStyle },
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
 * @param {{ controller: any, separator: object }} props
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

/** Drags shorter than this stay clicks (spec §5's 6px threshold). */
const STRIP_DRAG_THRESHOLD_PX = 6

/** @param {any} target event target @returns {boolean} */
function insideStripClose(target) {
  return typeof target?.closest === 'function' && target.closest('[data-hkcraft-strip-close]') !== null
}

/**
 * The pane whose strip entry is under the pointer, or null. Pointer capture
 * keeps the move events on the source entry, so the drop target has to be
 * hit-tested.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string|null}
 */
function stripPaneIdAt(clientX, clientY) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null
  const element = document.elementFromPoint(clientX, clientY)
  const entry = typeof element?.closest === 'function' ? element.closest('[data-hkcraft-strip-item]') : null
  const paneId = entry?.getAttribute?.('data-hkcraft-strip-item')
  return typeof paneId === 'string' && paneId !== '' ? paneId : null
}

/**
 * Whether `+` should read as unavailable.
 *
 * The controller's `splitBlock` counts reservations that have passed the check
 * but are still waiting on `sessions.create`. The leaf count alone stays under
 * the cap until that call returns, which would leave `+` enabled for a slot
 * that is already taken. Callers without `splitBlock` fall back to the leaves.
 *
 * @param {any} controller
 * @param {object} state layout shown in the strip
 * @param {string|null|undefined} workspaceId workspace the strip is counting
 * @param {number} maxPanes fallback cap when the controller has no `splitBlock`
 * @returns {boolean}
 */
function splitBlocked(controller, state, workspaceId, maxPanes) {
  if (typeof controller?.splitBlock === 'function') {
    return controller.splitBlock(workspaceId) === 'budget'
  }
  return paneBudgetBlocked(state, maxPanes)
}

/**
 * The pane strip: the current workspace's open conversations, in `leaves()`
 * order, with `+` immediately after the last tab.
 *
 * Structure, outermost first: the bar and a horizontally scrolling viewport
 * holding the `tablist` followed by `+`. The current mode and subagent viewer live
 * in each pane header, not here; the strip is only the index of open
 * conversations.
 *
 * Every entry is a pane — clicking it focuses that pane, its × closes the pane
 * (after a confirmation when the session is live), and `+` splits the focused
 * pane with a new conversation. Status dots come from the live session status
 * map; nothing here reorders entries by status.
 *
 * `+` follows the sidebar's split control: it is disabled once the workspace
 * holds `maxPanes` panes (0 = unlimited) and explains the limit on hover/hold.
 * The strip never closes a pane to enforce a lowered cap.
 *
 * The title and status read the shell's root standard hooks (`useSessions`,
 * `useSessionStatus`); ui-session provides them as `sessions` and
 * `sessionStatus`, which is the same pair the shipped sidebar consumes.
 *
 * The ARIA roles stay `tablist`/`tab` because the strip is a list of selectable
 * views of the same main region; the domain vocabulary is not "tab".
 *
 * The native right-bar tool icons sit outside the scrolling viewport, one row
 * for the whole strip. Each icon opens that tool the way its guide card does.
 * The expand icon is the header corner button: it is shown only while the bar
 * is collapsed. The row is hidden when the shell has no `sidebarRight` service.
 *
 * @param {{ controller: any, state: any, workspaceId?: string|null, maxPanes?: number, rightbarAvailable?: boolean, rightbarExpanded?: boolean, rightbarTools?: Array<{kind: string, entryId: string, providerId: string, title: string, icon: Function|null}>, kit: any, t: (key: string, params?: object) => string }} props
 */
/** The native header corner glyph: a window with the pane on the right. */
function RightbarExpandIcon() {
  const h = react().createElement
  return h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 16,
      height: 16,
      'aria-hidden': 'true',
      fill: 'none',
    },
    h('rect', {
      x: 1.5,
      y: 2.5,
      width: 13,
      height: 11,
      rx: 1.5,
      stroke: 'currentColor',
      strokeWidth: 1.2,
    }),
    h('path', { d: 'M10.5 2.5v11', stroke: 'currentColor', strokeWidth: 1.2 }),
  )
}

function PaneStrip({
  controller,
  state,
  workspaceId,
  maxPanes = DEFAULT_MAX_PANES,
  rightbarAvailable = false,
  rightbarExpanded = false,
  rightbarTools = [],
  kit,
  t,
}) {
  const React = react()
  const h = React.createElement
  const useSessions = typeof kit?.useSessions === 'function' ? kit.useSessions : absentHook
  const useSessionStatus = typeof kit?.useSessionStatus === 'function' ? kit.useSessionStatus : absentHook
  const sessions = useSessions((snapshot) => snapshot)
  const statuses = useSessionStatus((snapshot) => snapshot)
  const catalog = openCatalog({ sessions, statuses })
  const [hovered, setHovered] = React.useState(null)
  const [creating, setCreating] = React.useState(false)
  const [drag, setDrag] = React.useState(null)
  /** The in-flight pointer drag; state above only drives the visible feedback. */
  const dragRef = React.useRef(null)
  /** A drag's pointerup is followed by a click; that click must not re-focus. */
  const suppressClick = React.useRef(false)

  const entries = projectStrip(state, catalog, t('session.untitled'))
  const budgetBlocked = splitBlocked(controller, state, workspaceId, maxPanes)
  const budgetHint = budgetBlocked ? t('strip.budget', { n: maxPanes }) : null

  const closeEntry = (entry) => {
    // Closing a pane is `controller.closePane`: idle panes close immediately,
    // a running one stages `pendingClose`, which the shared `PaneCloseConfirm`
    // dialog (ticket 09) interrupts and closes after confirmation. The strip
    // does not own a second confirmation UI.
    controller.closePane(entry.paneId)
  }

  const createEntry = () => {
    if (creating || splitBlocked(controller, state, workspaceId, maxPanes)) return
    setCreating(true)
    Promise.resolve(controller.newPane())
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
  const onEntryPointerDown = (entry) => (event) => {
    if (event.button !== undefined && event.button !== 0) return
    if (insideStripClose(event.target)) return
    dragRef.current = {
      sourcePaneId: entry.paneId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetPaneId: null,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onEntryPointerMove = (event) => {
    const current = dragRef.current
    if (current === null) return
    if (!current.active) {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY)
      if (distance < STRIP_DRAG_THRESHOLD_PX) return
      current.active = true
      setDrag({ sourcePaneId: current.sourcePaneId, targetPaneId: null })
    }
    const over = stripPaneIdAt(event.clientX, event.clientY)
    const targetPaneId = over === null || over === current.sourcePaneId ? null : over
    if (targetPaneId !== current.targetPaneId) {
      current.targetPaneId = targetPaneId
      setDrag({ sourcePaneId: current.sourcePaneId, targetPaneId })
    }
    event.preventDefault()
  }

  const onEntryPointerUp = (event) => {
    const current = dragRef.current
    if (current === null) return
    clearDrag()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!current.active) return
    // Dropping anywhere but another strip entry is a complete no-op: no swap,
    // no focus change, no layout write. The following click is swallowed once.
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

  const onEntryPointerCancel = (event) => {
    clearDrag()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const focusEntry = (entry) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    controller.focusPane(entry.paneId)
  }

  const hint = paneShortcutHint(t)

  const entryElements = entries.map((entry) => {
    const statusLabel = t(`strip.status.${entry.status}`)
    const label = entry.shortcut === undefined ? entry.title : `${entry.title} (${entry.shortcut})`
    const source = drag !== null && drag.sourcePaneId === entry.paneId
    const target = drag !== null && drag.targetPaneId === entry.paneId
    return h(
      'div',
      {
        key: entry.paneId,
        role: 'tab',
        tabIndex: 0,
        'aria-selected': entry.focused ? 'true' : 'false',
        'aria-label': `${label} — ${statusLabel}`,
        title: `${label} — ${statusLabel}`,
        'data-hkcraft-strip-item': entry.paneId,
        'data-hkcraft-strip-active': entry.focused ? 'true' : 'false',
        'data-hkcraft-strip-drop-target': target ? 'true' : 'false',
        style: {
          ...stripItemStyle,
          opacity: source ? 0.55 : 1,
          // Both a highlighted entry and a drop target use the shell's business
          // accent token, which the theme presenter rewrites per palette.
          borderTopColor: entry.focused
            ? 'var(--dsw-alias-state-business-primary, Highlight)'
            : 'transparent',
          background: target
            ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 18%, transparent)'
            : entry.focused
              ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
              : hovered === entry.paneId
                ? 'color-mix(in srgb, currentColor 6%, transparent)'
                : 'transparent',
          outline: target
            ? '2px dashed var(--dsw-alias-state-business-primary, Highlight)'
            : '2px solid transparent',
          outlineOffset: target ? '-3px' : 0,
          cursor: drag === null ? 'pointer' : 'grabbing',
        },
        onClick: () => focusEntry(entry),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          focusEntry(entry)
        },
        onPointerDown: onEntryPointerDown(entry),
        onPointerMove: onEntryPointerMove,
        onPointerUp: onEntryPointerUp,
        onPointerCancel: onEntryPointerCancel,
        onMouseEnter: () => setHovered(entry.paneId),
        onMouseLeave: () => setHovered((current) => (current === entry.paneId ? null : current)),
      },
      h('span', {
        'aria-hidden': 'true',
        'data-hkcraft-strip-status': entry.status,
        style: {
          ...stripDotStyle,
          background: STRIP_STATUS_COLORS[entry.status] ?? STRIP_STATUS_COLORS[STRIP_STATUS_IDLE],
        },
      }),
      h('span', { style: stripTitleStyle }, entry.title),
      h(
        'button',
        {
          type: 'button',
          title: t('strip.close'),
          'aria-label': t('strip.close'),
          'data-hkcraft-strip-close': entry.paneId,
          style: {
            ...stripCloseStyle,
            // `visibility` (not `display`) keeps the space reserved, so hovering
            // an entry can never resize it or shift its neighbours.
            visibility: hovered === entry.paneId ? 'visible' : 'hidden',
            background:
              hovered === entry.paneId
                ? 'color-mix(in srgb, currentColor 16%, transparent)'
                : 'transparent',
          },
          onClick: (event) => {
            event.stopPropagation()
            closeEntry(entry)
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
      'data-hkcraft-pane-strip': '',
      // The full key table lives here and in the empty state, built from the
      // same labels the listener accepts; a spent budget appends its reason.
      title: budgetHint === null ? hint : `${hint} · ${budgetHint}`,
      style: paneStripStyle,
    },
    h(
      'div',
      { style: stripViewportStyle, 'data-hkcraft-strip-viewport': '' },
      h(
        'div',
        {
          role: 'tablist',
          'aria-label': t('strip.aria'),
          style: stripTablistStyle,
        },
        entryElements,
      ),
      h(
        'button',
        {
          type: 'button',
          // `+` splits the focused pane; `Ctrl+Shift+N` creates a conversation in
          // that pane instead, so this button must not advertise that chord. At
          // the pane budget it stays visible and focusable (like the sidebar's
          // split control) with `aria-disabled` and a title that explains the
          // limit, instead of a native `disabled` that would hide the reason
          // from keyboard users.
          title: budgetHint ?? t('strip.new'),
          'aria-label': budgetHint ?? t('strip.new'),
          'aria-disabled': budgetBlocked ? 'true' : undefined,
          'data-hkcraft-strip-new': '',
          'data-hkcraft-strip-budget': budgetBlocked ? 'true' : undefined,
          // A native `disabled` would drop the button out of tab order, which
          // hides the budget reason. `creating` still uses it while another
          // slot remains, so a double-click cannot start a second split.
          disabled: budgetBlocked ? false : creating,
          style: {
            ...stripNewStyle,
            opacity: creating || budgetBlocked ? 0.55 : 1,
            cursor: creating || budgetBlocked ? 'default' : 'pointer',
          },
          onClick: createEntry,
        },
        '＋',
      ),
    ),
    h(
      'div',
      { style: stripActionGroupStyle, 'data-hkcraft-strip-actions': '' },
      rightbarAvailable === true
        ? [
            ...rightbarTools.map((tool) =>
              h(
                'button',
                {
                  key: `${tool.providerId}:${tool.entryId}`,
                  type: 'button',
                  title: tool.title,
                  'aria-label': tool.title,
                  'data-hkcraft-rightbar-tool': tool.kind,
                  style: stripRightbarStyle,
                  onClick: () => controller.openRightbarTool(tool.kind),
                },
                h(
                  'span',
                  {
                    'aria-hidden': 'true',
                    style: {
                      display: 'inline-flex',
                      width: 18,
                      height: 18,
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    },
                  },
                  tool.icon != null ? h(tool.icon) : tool.title.slice(0, 1),
                ),
              ),
            ),
            rightbarExpanded === true
              ? null
              : h(
                  'button',
                  {
                    key: 'rightbar-expand',
                    type: 'button',
                    title: t('strip.rightbar.open'),
                    'aria-label': t('strip.rightbar.open'),
                    'aria-pressed': 'false',
                    'data-hkcraft-rightbar-toggle': '',
                    style: stripRightbarStyle,
                    onClick: () => controller.toggleRightbar(),
                  },
                  RightbarExpandIcon(),
                ),
          ]
        : null,
    ),
  )
}

/**
 * The interrupt confirmation for closing a running pane (spec D4). It is
 * rendered by the pane host itself, so it exists only while split mode is
 * active; cancelling dismisses it without touching the session.
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
 * @param {{ controller: any, workspaceId: string|null, layout: object, visible: boolean, maxPanes?: number, kit: any, t: (key: string) => string, seats?: Record<string, Function>|null }} props
 */
function PaneWorkspace({
  controller,
  workspaceId,
  layout,
  visible,
  maxPanes = DEFAULT_MAX_PANES,
  rightbarAvailable = false,
  rightbarExpanded = false,
  rightbarTools = [],
  error = null,
  kit,
  t,
  seats,
}) {
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
      h(PaneEmptyState, { controller, workspaceId, visible, error: visible ? error : null, t }),
    )
  }

  const geometry = computeLayout(layout.root)
  return h(
    'div',
    attributes,
    shortcuts,
    // Only the visible workspace owns a strip: hidden strips would render a
    // second row over an invisible tree. The pane bodies below stay mounted
    // regardless, which is what D5 actually protects.
    visible
      ? h(PaneStrip, {
          controller,
          state: layout,
          workspaceId,
          maxPanes,
          rightbarAvailable,
          rightbarExpanded,
          rightbarTools,
          kit,
          t,
        })
      : null,
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
          seats,
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
 *
 * `options.headerSeats` is the pane header's native-control extension point:
 * `{ mode?: Component, subagents?: Component }`. The current-mode badge and the
 * subagent viewer fill one seat each in every pane header; both are optional, so
 * a pane works with no seats at all.
 *
 * @param {any} controller
 * @param {{ headerSeats?: Record<string, Function>|null }} [options]
 */
function createPaneHost(controller, options = {}) {
  const seats = options?.headerSeats ?? null
  return function PaneHost(props) {
    const React = react()
    const h = React.createElement
    const t = createTranslator(props)
    const state = usePaneSnapshot(React, controller)

    React.useEffect(() => {
      // Probe at mount, after the shell has finished loading sibling plugins.
      controller.refreshProbe()
    }, [])

    // The shadow occupies the conversation cell even before split mode is
    // active. Returning null here would leave the main area blank.
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
            key: group.workspaceId ?? UNSCOPED_WORKSPACE,
            controller,
            workspaceId: group.workspaceId,
            layout: group.layout,
            visible: group.visible,
            maxPanes: state.maxPanes,
            rightbarAvailable: state.rightbarAvailable === true,
            rightbarExpanded: state.rightbarExpanded === true,
            rightbarTools: Array.isArray(state.rightbarTools) ? state.rightbarTools : [],
            error: state.error,
            kit: props,
            t,
            seats,
          }),
        ),
      ),
      dialog,
    )
  }
}

/**
 * The pane currently holding `sessionId`, across every loaded workspace.
 *
 * @param {{layouts?: Record<string, object>, panes?: Record<string, object>}} state controller snapshot
 * @param {string|undefined} sessionId
 * @returns {object|null}
 */
function paneForSession(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const find = (panes) =>
    Object.values(panes ?? {}).find((pane) => pane?.sessionId === sessionId) ?? null
  let pane = find(state?.panes)
  if (pane === null) {
    for (const layout of Object.values(state?.layouts ?? {})) {
      pane = find(layout?.panes)
      if (pane !== null) break
    }
  }
  return pane
}

/**
 * The View a pane remembers for `sessionId`, across every loaded workspace.
 *
 * dsh's own per-session View store (`dsh.conversation`) belongs to ui-conversation
 * and is not writable from the pane's embedded occurrence. The layout record is
 * therefore the pane's single source of truth for which View it renders.
 *
 * @param {{layouts?: Record<string, object>, panes?: Record<string, object>}} state controller snapshot
 * @param {string|undefined} sessionId
 * @returns {'chat'|'trajectory'}
 */
function paneViewOfSession(state, sessionId) {
  const view = paneForSession(state, sessionId)?.view
  return view === TRAJECTORY_VIEW ? TRAJECTORY_VIEW : CHAT_VIEW
}

/**
 * The pane's replacement for the conversation factory's `views` local slot.
 *
 * `conversation.content` lets an embedded occurrence replace `views` (see
 * `doc/upstream-contracts.md#embedded-views-local-slot-and-view-selection`). The
 * default renders `conversation.session`, whose View comes from ui-conversation's
 * per-session store; the pane cannot write that store, so it would stay on chat
 * forever. Rendering `conversation.session` with the layout's View passed as the
 * `view` prop keeps dsh's transcript, draft persistence and composer intact while
 * making the pane's toggle authoritative.
 *
 * The forced `view` would otherwise swallow the shell's in-conversation
 * `openView` jumps (a tool-call row switching to the trajectory View). The owner
 * prop overrides the entry's injected `openView`, so those jumps are routed back
 * into this pane's layout instead of the shell store the pane does not render.
 *
 * @param {any} controller
 * @returns {(props: any) => any}
 */
function createPaneConversationViews(controller) {
  return function PaneConversationViews(props) {
    const React = react()
    // Only this pane's remembered View matters here; selecting the value keeps
    // unrelated layout changes (focus, resize) from re-rendering the transcript.
    const remembered = React.useSyncExternalStore(
      controller.subscribe,
      () => paneViewOfSession(controller.getSnapshot(), props.sessionId),
      () => paneViewOfSession(controller.getSnapshot(), props.sessionId),
    )
    const trajectoryAvailable = useTrajectoryAvailable(React, controller)
    const openView = (view) => {
      const pane = paneForSession(controller.getSnapshot(), props.sessionId)
      if (pane !== null) controller.setView(pane.paneId, view)
    }
    return props.renderSlot('conversation.session', {
      view: effectiveView(remembered, trajectoryAvailable),
      openView,
    })
  }
}

/**
 * The session-scoped child entry. It owns the `conversation.content` render and
 * the fallback faces for a missing / crashing factory.
 */
function createPaneBody(controller) {
  const PaneConversationViews = createPaneConversationViews(controller)
  return function PaneBody(props) {
    const React = react()
    const h = React.createElement
    const t = createTranslator(props)
    const state = usePaneSnapshot(React, controller)
    const sessionId = props.sessionId
    const session =
      typeof props.useSession === 'function' ? props.useSession((snapshot) => snapshot) : undefined
    // The hook runs whenever the shell supplies it — never conditionally, so the
    // call order cannot change with `sessionId`. The catalog then inverts the
    // row's `blank` bit once, and this reads it back for the factory's
    // hero/settling derivation, which wants the raw flag.
    const sessionsSnapshot =
      typeof props.useSessions === 'function' ? props.useSessions((snapshot) => snapshot) : undefined
    const summaryRow =
      sessionsSnapshot === undefined || sessionId === undefined
        ? undefined
        : openCatalog({ sessions: sessionsSnapshot }).session(sessionId)
    const summaryBlank = summaryRow === undefined ? undefined : summaryRow.started === false
    const { phase, hero } = derivePanePhase({ sessionId, session, summaryBlank })
    const sessionReady = session !== undefined
    React.useEffect(() => {
      if (sessionId === undefined || !sessionReady) return
      // The pane's own memory wins over dsh's per-session View preference.
      // `activate` is the same call the native switcher makes, so this swaps the
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
        { variant: PANE_CONTENT_OCCURRENCE, phase, hero },
        { fallback: missing(), slots: { views: PaneConversationViews } },
      ),
    )
  }
}

module.exports = {
  PANE_CONTENT_OCCURRENCE,
  PaneFrame,
  PaneSeparator,
  PaneEmptyState,
  PaneShortcuts,
  PaneWorkspace,
  workspaceGroups,
  PaneViewToggle,
  PaneCloseConfirm,
  PaneStrip,
  paneViewOfSession,
  createPaneConversationViews,
  createPaneHost,
  createPaneBody,
  usePaneSnapshot,
  errorBoundaryClass,
}
