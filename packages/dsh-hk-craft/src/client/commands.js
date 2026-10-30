'use strict'

/**
 * `/clear` and `/resume`: two client-only slash commands.
 *
 * Both are registered through `ctx.commandUi.register` and never reach the
 * model: `/clear` is an `action` (the shell consumes the token and calls
 * `run`), `/resume` is a `popupSelect` whose options are loaded once and whose
 * selection calls `onSelect`. Neither calls `command.execute`, so nothing is
 * appended to the session log (`dsh-client-ui-commands`, README "Model
 * Experience"; dispatch/invoke at `lib/client.js:1557-1687`).
 *
 * The descriptors only touch the adapter (`dsh-sessions.js`) and the pure list
 * builder (`resume-list.js`), which keeps this file about wiring, not data.
 */

const { buildResumeRows } = require('./resume-list.js')
const {
  workspaceIdOf,
  listConversations,
  openConversation,
  startConversation,
} = require('./dsh-sessions.js')

/**
 * Whether the plugin's pane workspace is currently showing. When it is, both
 * commands stay inside it instead of calling the shell's session navigation,
 * which would reset the active panel.
 *
 * @param {object} [panes] pane host face
 * @returns {boolean}
 */
function panePanelActive(panes) {
  try {
    return panes?.active?.() === true
  } catch (_error) {
    return false
  }
}

/**
 * The focused pane, or null when there is no pane host or no pane is focused.
 *
 * @param {object} [panes] pane host face
 * @returns {object|null}
 */
function focusedPane(panes) {
  try {
    return panes?.focused?.() ?? null
  } catch (_error) {
    return null
  }
}

/**
 * Build the `/clear` contribution.
 *
 * When the pane workspace is showing, the new conversation must land in the
 * focused pane. The pane host creates it through `sessions.create`, because the
 * native `uiWorkspace.startSession` path reveals the session with
 * `replaceMain(..., "reveal")` → `selectPanel(null)`, which would dismiss the
 * split layout (ui-workspace:1500-1530, 1652-1676; see `dsh-pane-host.js`).
 *
 * @param {object} deps
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t translator
 * @param {(sessionId: string|undefined) => string|undefined} deps.workspaceIdFor workspace lookup
 * @param {(workspaceId: string|undefined) => void} deps.start new-conversation action
 * @param {object} [deps.panes] pane host face (optional: commands work without panes)
 * @returns {object} command contribution
 */
function buildClearCommand({ t, workspaceIdFor, start, panes }) {
  return {
    name: 'clear',
    label: () => t('command.clear.label'),
    description: () => t('command.clear.description'),
    available: () => true,
    ui: {
      kind: 'action',
      run: (session) => {
        const workspaceId = workspaceIdFor(session?.sessionId)
        if (panePanelActive(panes)) {
          const attempt = panes.newConversation(workspaceId)
          // The pane host owns its own error state; never let a rejected
          // creation escape as an unhandled rejection.
          if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
            attempt.catch(() => {})
          }
          return
        }
        start(workspaceId)
      },
    },
  }
}

/**
 * Track Ctrl+Enter (or Cmd+Enter) while a `popupSelect` is open.
 *
 * dsh's popup shell handles a bare Enter/Tab by calling `popup.select(...)` and
 * ignores the event's modifiers (`dsh-client-ui-commands/lib/client.js:1913-
 * 1939`; `onSelect(option, context)` at 1250 carries no event). It also keeps
 * focus in its own search input, so the plugin cannot wrap the key handler.
 * This tracker listens in the document capture phase, which runs before the
 * shell's React handler, and records the chord; `onSelect` consumes the flag
 * synchronously while the same keydown is still dispatching. A `keyup`
 * (or the next consumption) clears it, so a missed chord can never turn a
 * later plain Enter into a new-pane request.
 *
 * @param {{addEventListener?: Function, removeEventListener?: Function}|undefined} target usually `document`
 * @returns {{consume: () => boolean, dispose: () => void}}
 */
function createCtrlEnterTracker(target) {
  let armed = false
  let disposed = false
  if (target === undefined || target === null || typeof target.addEventListener !== 'function') {
    return { consume: () => false, dispose: () => {} }
  }
  const onKeyDown = (event) => {
    if (event?.key !== 'Enter') return
    if (event.ctrlKey === true || event.metaKey === true) armed = true
  }
  const onKeyUp = (event) => {
    if (event?.key === 'Enter') armed = false
  }
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keyup', onKeyUp, true)
  return {
    consume() {
      const value = armed
      armed = false
      return value
    },
    dispose() {
      if (disposed) return
      disposed = true
      target.removeEventListener?.('keydown', onKeyDown, true)
      target.removeEventListener?.('keyup', onKeyUp, true)
    },
  }
}

/**
 * Build the `/resume` contribution.
 *
 * `searchMode: 'fuzzy-label'` is dsh's fuzzy popup mode; it ranks
 * `option.label` only, so the list builder folds the first-prompt excerpt into
 * the label (see `resume-list.js`). The shell owns ↑/↓, Enter, and Esc.
 *
 * @param {object} deps
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t translator
 * @param {(sessionId: string|undefined) => string|undefined} deps.workspaceIdFor workspace lookup
 * @param {(triggerSessionId: string, signal?: AbortSignal) => Promise<object[]>} deps.conversations raw list loader
 * @param {(sessionId: string) => void} deps.open reveal action
 * @param {() => number} deps.now clock used for the age label
 * @param {object} [deps.panes] pane host face (optional: commands work without panes)
 * @param {() => boolean} [deps.newPaneRequested] whether the selection was
 *   Ctrl+Enter (`createCtrlEnterTracker().consume` in production)
 * @returns {object} command contribution
 */
function buildResumeCommand({ t, workspaceIdFor, conversations, open, now, panes, newPaneRequested }) {
  return {
    name: 'resume',
    label: () => t('command.resume.label'),
    description: () => t('command.resume.description'),
    available: () => true,
    ui: {
      kind: 'popupSelect',
      searchMode: 'fuzzy-label',
      searchLabels: () => ({
        placeholder: t('command.resume.search.placeholder'),
        empty: t('command.resume.search.empty'),
        noResults: t('command.resume.search.noResults'),
      }),
      options: async (session, signal) => {
        const rows = await conversations(session?.sessionId, signal)
        return buildResumeRows(rows, {
          workspaceId: workspaceIdFor(session?.sessionId),
          now: now(),
          t,
        })
      },
      onSelect: async (option) => {
        // Pane-aware `/resume`: with the pane workspace showing, the chosen
        // conversation either replaces the focused pane (plain Enter) or opens
        // in a new pane beside it (Ctrl+Enter). The shell-level reveal would
        // otherwise call selectPanel(null) and dismiss the split layout.
        const openBeside = newPaneRequested?.() === true
        if (panePanelActive(panes) && focusedPane(panes) !== null) {
          if (openBeside && typeof panes?.openInNewPane === 'function') {
            const attempt = panes.openInNewPane(option.sessionId)
            if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
              attempt.catch(() => {})
            }
            return
          }
          panes.replaceFocused(option.sessionId)
          return
        }
        open(option.sessionId)
      },
    },
  }
}

/**
 * Register both commands onto the client command service.
 *
 * @param {object} services
 * @param {object} services.commandUi `commandUi` client service
 * @param {object} [services.sessions] ClientSessions service
 * @param {object} [services.workspaces] Workspace controller service
 * @param {object} [services.uiWorkspace] workspace navigation service
 * @param {(key: string, params?: Record<string, unknown>) => string} services.t translator
 * @param {() => number} [services.now] clock (injected by tests)
 * @param {(triggerSessionId: string, signal?: AbortSignal) => Promise<object[]>} [services.conversationsFor] list loader override
 * @param {(sessionId: string) => void} [services.openConversation] reveal override
 * @param {(workspaceId: string|undefined) => void} [services.startConversation] new-conversation override
 * @param {object} [services.panes] pane host face; when present the commands act on the pane workspace
 * @returns {(() => void)[]} registration disposers
 */
function registerCommands(services) {
  const { commandUi, workspaces, t, panes } = services
  const now = services.now ?? (() => Date.now())
  const workspaceIdFor = (sessionId) => workspaceIdOf(workspaces?.list?.getSnapshot?.(), sessionId)
  const conversations =
    services.conversationsFor ??
    ((triggerSessionId, signal) =>
      listConversations({ sessions: services.sessions, workspaces }, triggerSessionId, { signal }))
  const open = services.openConversation ?? ((sessionId) => openConversation(services.uiWorkspace, sessionId))
  const start = services.startConversation ?? ((workspaceId) => startConversation(services.uiWorkspace, workspaceId))
  const tracker =
    services.newPaneRequested === undefined
      ? createCtrlEnterTracker(globalThis.document)
      : null
  const newPaneRequested = services.newPaneRequested ?? (() => tracker.consume())

  const disposers = [
    commandUi.register(buildClearCommand({ t, workspaceIdFor, start, panes })),
    commandUi.register(
      buildResumeCommand({ t, workspaceIdFor, conversations, open, now, panes, newPaneRequested }),
    ),
  ]
  if (tracker !== null) disposers.push(() => tracker.dispose())
  return disposers
}

module.exports = { buildClearCommand, buildResumeCommand, createCtrlEnterTracker, registerCommands }
