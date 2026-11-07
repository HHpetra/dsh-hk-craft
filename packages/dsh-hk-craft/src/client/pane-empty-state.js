'use strict'

/**
 * The empty workspace: no panes yet, so the tree offers a new conversation
 * and the workspace's recent ones.
 *
 * Split out of `pane-view.js` because this surface changes with the resume
 * list and the empty copy, not with the strip, the header or the host.
 */

const { react } = require('./react-and-translator.js')
const { EMPTY_STATE_LIMITS, buildResumeRows } = require('./resume-list.js')
const { paneShortcutHint, shortcutLabel, withShortcut } = require('./pane-shortcuts.js')
const { T } = require('./visual-tokens.js')
const { runAttempt } = require('./pane-view-support.js')
const {
  emptyActionStyle,
  emptyBodyStyle,
  emptyMarkStyle,
  emptyStackStyle,
  emptyTitleStyle,
  hintStyle,
  paneStyle,
  recentBadgeStyle,
  recentDetailStyle,
  recentHeadingStyle,
  recentLabelStyle,
  recentListStyle,
  recentRowStyle,
} = require('./pane-styles.js')

/** How many recent conversations the empty state offers. */
const EMPTY_RECENT_LIMIT = 5

/**
 * The empty state's hero glyph: four panes, drawn rather than shipped as an
 * asset so it follows `currentColor` in both palettes.
 */
function EmptyPanesIcon() {
  const h = react().createElement
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 26,
      height: 26,
      fill: 'none',
      'aria-hidden': 'true',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    },
    h('rect', { x: 3, y: 4, width: 7.5, height: 6.5, rx: 1.6 }),
    h('rect', { x: 13.5, y: 4, width: 7.5, height: 6.5, rx: 1.6 }),
    h('rect', { x: 3, y: 13.5, width: 18, height: 6.5, rx: 1.6 }),
    h('path', { d: 'M6.8 7.25h0M17.3 7.25h0M7 16.75h10', strokeLinecap: 'round' }),
  )
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
    runAttempt(controller.budget.newInFocused(workspaceId ?? undefined))
  }

  return h(
    'div',
    { style: paneStyle, 'data-hkcraft-empty': '' },
    h(
      'div',
      { style: emptyStackStyle },
      h('div', { style: emptyMarkStyle, 'aria-hidden': 'true' }, EmptyPanesIcon()),
      h('div', { style: emptyTitleStyle }, t('pane.empty.workspace.title')),
      h('div', { style: emptyBodyStyle }, t('pane.empty.workspace.body')),
      typeof error === 'string' && error !== ''
        ? h(
            'div',
            { 'data-hkcraft-empty-error': '', style: { fontSize: 12, marginTop: 8 } },
            error,
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          className: 'hk-button hk-button--primary',
          style: emptyActionStyle,
          title: withShortcut(t('pane.empty.new'), shortcutLabel('new-conversation')),
          onClick: startNew,
        },
        t('pane.empty.new'),
      ),
      recent === null
        ? null
        : recent.length === 0
          ? h(
              'div',
              {
                style: {
                  padding: '10px 12px',
                  borderRadius: T.radiusSm,
                  border: `0.5px dashed ${T.border3}`,
                  color: T.textTertiary,
                  fontSize: 12,
                },
              },
              t('command.resume.search.empty'),
            )
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

module.exports = { PaneEmptyState }
