'use strict'

/**
 * The pane host: which workspace trees stay mounted, and the session-scoped
 * body that renders `conversation.content`.
 *
 * The pieces that change for their own reasons live beside this file:
 * the strip (`pane-strip-view.js`), one pane (`pane-frame.js`), the divider
 * (`pane-separator.js`), the empty workspace (`pane-empty-state.js`) and the
 * interrupt dialog (`pane-close-confirm.js`). Shared view helpers are in
 * `pane-view-support.js`. dsh assumptions stay in `dsh-pane-host.js`.
 *
 * Layout rendering keeps every pane mounted: the pure geometry projection
 * (`layout-geometry.js`) turns the tree into flat, fractional rectangles, and
 * each pane is an absolutely positioned sibling keyed by `paneId`. A split or a
 * close therefore changes inline styles only — React never re-parents a pane,
 * so streaming output, scroll position and the composer draft survive.
 *
 * `react` is resolved on every call (`react-and-translator.js`) because unit
 * tests load this module in Node and swap the platform module per file.
 */

const { createTranslator, react } = require('./react-and-translator.js')
const { openCatalog } = require('./catalog.js')
const {
  CONTENT_FACTORY,
  PANE_SLOT,
  UNSCOPED_WORKSPACE,
  derivePanePhase,
} = require('./dsh-pane-host.js')
const { CHAT_VIEW, TRAJECTORY_VIEW, effectiveView } = require('./dsh-view-switch.js')
const { computeLayout } = require('./layout-geometry.js')
const { paneShortcutAction } = require('./pane-shortcuts.js')
const { messageOf } = require('./shared.js')
const { shownWorkspaceId } = require('./workspace-status.js')
const { DEFAULT_MAX_PANES } = require('./pane-budget.js')
const {
  buttonStyle,
  fallbackStyle,
  hiddenWorkspaceStyle,
  hostStyle,
  layoutStyle,
  workspaceStyle,
} = require('./pane-styles.js')
const {
  PaneFallback,
  errorBoundaryClass,
  runAttempt,
  usePaneSnapshot,
  useTrajectoryAvailable,
} = require('./pane-view-support.js')
const { PaneEmptyState } = require('./pane-empty-state.js')
const { PaneSeparator } = require('./pane-separator.js')
const { PaneStrip } = require('./pane-strip-view.js')
const { PaneFrame, PaneViewToggle } = require('./pane-frame.js')
const { PaneCloseConfirm } = require('./pane-close-confirm.js')

/**
 * The `conversation.content` occurrence a pane mounts.
 *
 * ui-conversation ships two occurrences of that Factory. The `main` one is
 * rendered inside `main.conversation`, whose `.root[data-phase]` element pins
 * the composer (`position: sticky; bottom: 0`), centres the hero and lets the
 * transcript own the scrollport. The `embedded` one is the supported non-root
 * occurrence: the same rules hang off its own `[data-content-phase]` body
 * (`ConversationRoot.module.css` in `@deepseek-ai/dsh-client-ui-conversation`
 * 0.2.2-rc.1). A pane has no `.root`, so `main` left the composer seat in normal
 * flow at the end of the transcript — the split view showed the messages and no
 * input box.
 */
const PANE_CONTENT_OCCURRENCE = 'embedded'

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
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (action.kind === 'focus') {
        event.preventDefault()
        controller.layout.focusPaneAt(action.index)
        return
      }
      if (action.kind === 'new') {
        event.preventDefault()
        event.stopPropagation()
        runAttempt(controller.budget.newInFocused(workspaceId ?? undefined))
        return
      }
      const pane = controller.layout.focusedPane()
      if (pane === null) return
      event.preventDefault()
      event.stopPropagation()
      if (action.kind === 'split') runAttempt(controller.budget.split(pane.paneId, action.dir))
      else if (action.kind === 'close') controller.close.request(pane.paneId)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [controller, workspaceId])
  return null
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
  const visibleWorkspaceId = shownWorkspaceId(state)
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
 * `docs/upstream-contracts.md#embedded-views-local-slot-and-view-selection`). The
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
      if (pane !== null) controller.view.setView(pane.paneId, view)
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
      controller.view.restoreViewFor(sessionId)
    }, [sessionId, sessionReady])
    const boundary = errorBoundaryClass()
    const close = () => controller.close.bySession(sessionId)

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
            detail: `${t('pane.fallback.error')} (${messageOf(error)})`,
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
