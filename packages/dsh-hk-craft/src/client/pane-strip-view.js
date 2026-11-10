'use strict'

/**
 * The pane strip: the open conversations of the visible workspace, the `+`
 * that splits the focused pane, and the native right-bar tool icons.
 *
 * The projection lives in `pane-strip.js` and the pointer gesture in
 * `pane-strip-drag.js`. This file only paints them. It changes when the
 * index or the right-bar icons change, not when a pane header or the host does.
 */

const { react } = require('./react-and-translator.js')
const { openCatalog } = require('./catalog.js')
const { usePaneStripDrag } = require('./pane-strip-drag.js')
const { paneShortcutHint } = require('./pane-shortcuts.js')
const { absentHook } = require('./shared.js')
const { STRIP_STATUS_COLORS } = require('./status-colors.js')
const { STRIP_STATUS_IDLE, projectStrip } = require('./pane-strip.js')
const { DEFAULT_MAX_PANES, paneBudgetBlocked } = require('./pane-budget.js')
const {
  paneStripStyle,
  stripActionGroupStyle,
  stripCloseStyle,
  stripDotStyle,
  stripItemStyle,
  stripNewStyle,
  stripRightbarStyle,
  stripTablistStyle,
  stripTitleStyle,
  stripViewportStyle,
} = require('./pane-styles.js')

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
  if (typeof controller?.budget?.splitBlock === 'function') {
    return controller.budget.splitBlock(workspaceId) === 'budget'
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
  // Pointer capture, hit testing and click suppression live in their own hook;
  // the strip only paints the entries and forwards the drag state.
  const stripDrag = usePaneStripDrag(React, {
    onSwap: (sourcePaneId, targetPaneId) => controller.layout.swapPanes(sourcePaneId, targetPaneId),
  })
  const drag = stripDrag.drag

  const entries = projectStrip(state, catalog, t('session.untitled'))
  const budgetBlocked = splitBlocked(controller, state, workspaceId, maxPanes)
  const budgetHint = budgetBlocked ? t('strip.budget', { n: maxPanes }) : null

  const closeEntry = (entry) => {
    // Closing a pane is `controller.close.request`: idle panes close immediately,
    // a running one stages `pendingClose`, which the shared `PaneCloseConfirm`
    // dialog (ticket 09) interrupts and closes after confirmation. The strip
    // does not own a second confirmation UI.
    controller.close.request(entry.paneId)
  }

  const createEntry = () => {
    if (creating || splitBlocked(controller, state, workspaceId, maxPanes)) return
    setCreating(true)
    Promise.resolve(controller.budget.newPane())
      .catch(() => {})
      .then(() => setCreating(false))
  }

  const focusEntry = (entry) => {
    if (stripDrag.consumeSuppressedClick()) return
    controller.layout.focusPane(entry.paneId)
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
          // An active drop target keeps its accent fill through the same
          // custom property the stylesheet uses for hover/active state, so the
          // inline and stylesheet layers never overwrite each other.
          '--hk-tab-bg': target
            ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 16%, transparent)'
            : undefined,
          outline: target
            ? '2px dashed var(--dsw-alias-state-business-primary, Highlight)'
            : undefined,
          outlineOffset: target ? '-3px' : undefined,
          cursor: drag === null ? 'pointer' : 'grabbing',
        },
        onClick: () => focusEntry(entry),
        onFocus: () => {
          if (!entry.focused) controller.layout.focusPane(entry.paneId)
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          focusEntry(entry)
        },
        onPointerDown: stripDrag.onEntryPointerDown(entry),
        onPointerMove: stripDrag.onEntryPointerMove,
        onPointerUp: stripDrag.onEntryPointerUp,
        onPointerCancel: stripDrag.onEntryPointerCancel,
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
            '--hk-icon-bg':
              hovered === entry.paneId
                ? 'color-mix(in srgb, currentColor 12%, transparent)'
                : undefined,
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
                  onClick: () => {
                    // An explicit tool click must land on the pane the user is
                    // looking at, even when the shell current still names the
                    // workspace left a moment ago.
                    controller.revealFocusedSession?.()
                    const focused = state.activePaneId == null ? undefined : state.panes?.[state.activePaneId]
                    controller.panel.openTool(tool.kind, focused?.sessionId)
                  },
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
                    onClick: () => controller.panel.toggle(),
                  },
                  RightbarExpandIcon(),
                ),
          ]
        : null,
    ),
  )
}

module.exports = { PaneStrip }
