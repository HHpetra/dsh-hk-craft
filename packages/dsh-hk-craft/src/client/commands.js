'use strict'

/**
 * `/clear` and `/resume`: two client-only slash commands, plus the pane-aware
 * `Mod+N` binding.
 *
 * Both commands are registered through `ctx.commandUi.register` and never reach
 * the model: `/clear` is an `action` (the shell consumes the token and calls
 * `run`), `/resume` is a `popupSelect` whose options are loaded once and whose
 * selection calls `onSelect`. Neither calls `command.execute`, so nothing is
 * appended to the session log. The dsh contracts are recorded in
 * `doc/upstream-contracts.md#slash-commands-and-popupselect`.
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
 * split layout. Note that `sessions.create` always creates a new session; it
 * never reuses the workspace's blank one (that reuse lives only in the native
 * `startSession` path, which the pane host deliberately avoids). See
 * `doc/upstream-contracts.md#creating-a-session-without-leaving-the-panel`.
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
 * Whether one key event is exactly `Mod+N` (Ctrl+N, or Cmd+N on macOS).
 *
 * @param {object|null|undefined} event
 * @returns {boolean}
 */
function isModN(event) {
  if (event === null || event === undefined || typeof event !== 'object') return false
  if (event.defaultPrevented === true || event.repeat === true) return false
  if (event.ctrlKey !== true && event.metaKey !== true) return false
  if (event.altKey === true || event.shiftKey === true) return false
  if (typeof event.code === 'string' && event.code !== '') return event.code === 'KeyN'
  return typeof event.key === 'string' && event.key.toLowerCase() === 'n'
}

/**
 * Bind `Mod+N` to the pane-aware "new conversation" action while the pane panel
 * is active (spec D8: identical to `/clear`).
 *
 * dsh binds `Mod+N` to its native `session.new`, which reveals the new session
 * and dismisses the split. A document-level capture listener runs before the
 * shell's React handler (the same technique as the Ctrl+Enter tracker below),
 * and the shell modal check keeps dialogs in control of the keyboard. Outside
 * the pane workspace the listener does nothing, so native dsh keeps its key.
 *
 * @param {{addEventListener?: Function, removeEventListener?: Function}|undefined} target usually `document`
 * @param {object} [panes] pane host face
 * @returns {{dispose: () => void}}
 */
function createNewConversationBinding(target, panes) {
  let disposed = false
  if (target === undefined || target === null || typeof target.addEventListener !== 'function') {
    return { dispose() {} }
  }
  const onKeyDown = (event) => {
    if (!isModN(event)) return
    if (!panePanelActive(panes)) return
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
    }
    event.preventDefault()
    event.stopImmediatePropagation?.()
    event.stopPropagation?.()
    const attempt = panes.newConversation()
    if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
      attempt.catch(() => {})
    }
  }
  target.addEventListener('keydown', onKeyDown, true)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      target.removeEventListener?.('keydown', onKeyDown, true)
    },
  }
}

/**
 * Track Ctrl+Enter (or Cmd+Enter) while a `popupSelect` is open.
 *
 * dsh's popup shell handles a bare Enter/Tab by calling `popup.select(...)` and
 * ignores the event's modifiers; `onSelect(option, context)` carries no event.
 * It also keeps focus in its own search input, so the plugin cannot wrap the
 * key handler. This tracker listens in the document capture phase, which runs
 * before the shell's React handler, and records the chord; `onSelect` consumes
 * the flag synchronously while the same keydown is still dispatching. A `keyup`
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
 * Selecting a row that is already open in a pane must focus that pane rather
 * than reopen the session (spec D10); `panes.replaceFocused` already does that,
 * and `paneIndexOf` supplies the "已在窗格 N" badge.
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
  const paneIndexOf = typeof panes?.paneIndexFor === 'function' ? panes.paneIndexFor : undefined
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
        // The badge only makes sense while the pane workspace is what a
        // selection acts on; in native mode the same conversation is not
        // reachable by "focus its pane".
        const showPaneIndex = panePanelActive(panes) && paneIndexOf !== undefined
        return buildResumeRows(rows, {
          workspaceId: workspaceIdFor(session?.sessionId),
          now: now(),
          t,
          ...(showPaneIndex ? { paneIndexOf } : {}),
        })
      },
      onSelect: async (option) => {
        // Pane-aware `/resume`: with the pane workspace showing, the chosen
        // conversation either replaces the focused pane (plain Enter) or opens
        // in a new pane beside it (Ctrl+Enter). The shell-level reveal would
        // otherwise call selectPanel(null) and dismiss the split layout. An
        // already-open conversation makes `replaceFocused` focus its pane, which
        // is exactly the D10 "focus instead of reopen" rule. Ctrl+Enter still
        // goes through the pane host when the workspace is empty: that opens
        // the first pane and does not spend the split budget.
        const openBeside = newPaneRequested?.() === true
        if (panePanelActive(panes) && openBeside && typeof panes?.openInNewPane === 'function') {
          const attempt = panes.openInNewPane(option.sessionId)
          if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
            attempt.catch(() => {})
          }
          return
        }
        if (panePanelActive(panes) && focusedPane(panes) !== null) {
          panes.replaceFocused(option.sessionId)
          return
        }
        open(option.sessionId)
      },
    },
  }
}

/**
 * Register both commands (and the pane-aware `Mod+N` binding) onto the client
 * command service.
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
 * @param {{addEventListener?: Function}|undefined} [services.keyTarget] document seam for tests
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
  const keyTarget = services.keyTarget ?? globalThis.document
  const tracker =
    services.newPaneRequested === undefined ? createCtrlEnterTracker(keyTarget) : null
  const newPaneRequested = services.newPaneRequested ?? (() => tracker.consume())

  const disposers = [
    commandUi.register(buildClearCommand({ t, workspaceIdFor, start, panes })),
    commandUi.register(
      buildResumeCommand({ t, workspaceIdFor, conversations, open, now, panes, newPaneRequested }),
    ),
  ]
  if (tracker !== null) disposers.push(() => tracker.dispose())
  // `Mod+N` only has a pane-aware meaning while the pane host exists.
  if (panes !== undefined && panes !== null) {
    const binding = createNewConversationBinding(keyTarget, panes)
    disposers.push(() => binding.dispose())
  }
  return disposers
}

module.exports = {
  buildClearCommand,
  buildResumeCommand,
  createCtrlEnterTracker,
  createNewConversationBinding,
  isModN,
  registerCommands,
}
