'use strict'

/**
 * Client-only slash commands: `/clear`, `/new`, `/resume`, `/fork`, `/trace`,
 * plus the pane-aware `Mod+N` binding.
 *
 * Every command is registered through `ctx.commandUi.register` and never
 * reaches the model. `/resume` is a `popupSelect`; the others are `action`s.
 * None of them calls `command.execute`, so nothing is appended to the session
 * log. The dsh contracts are recorded in
 * `docs/upstream-contracts.md`.
 *
 * The descriptors only touch the adapter (`dsh-sessions.js`) and the pure list
 * builder (`resume-list.js`), which keeps this file about wiring, not data.
 */

const { messageOf } = require('./shared.js')
const { buildResumeRows } = require('./resume-list.js')
const { openCatalog, readCatalogs } = require('./catalog.js')
const {
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
 * Build the `/clear` or `/new` contribution. The two names share this builder
 * and the same run path; `/new` is the name carried over from dsh-tui, and
 * `/clear` stays as the compatible name.
 *
 * When split mode is active, the new conversation must land in the focused
 * pane. The pane host creates it through `sessions.create`. The native
 * `uiWorkspace.startSession` path reuses the workspace's blank session and
 * then reveals it, which moves the shell's current session. `sessions.create`
 * always creates a new session. See
 * `docs/upstream-contracts.md#creating-a-session-without-leaving-the-panel`.
 *
 * @param {object} deps
 * @param {'clear'|'new'} [deps.name] registration name
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t translator
 * @param {(sessionId: string|undefined) => string|undefined} deps.workspaceIdFor workspace lookup
 * @param {(workspaceId: string|undefined) => void} deps.start new-conversation action
 * @param {object} [deps.panes] pane host face (optional: commands work without panes)
 * @returns {object} command contribution
 */
function buildNewConversationCommand({ name = 'clear', t, workspaceIdFor, start, panes }) {
  const labelKey = name === 'new' ? 'command.new.label' : 'command.clear.label'
  const descriptionKey = name === 'new' ? 'command.new.description' : 'command.clear.description'
  return {
    name,
    label: () => t(labelKey),
    description: () => t(descriptionKey),
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
 * Bind `Mod+N` to the pane-aware "new conversation" action while split mode
 * is active (spec D8: identical to `/clear`).
 *
 * dsh binds `Mod+N` to its native `session.new`, which reveals a new session
 * and moves the shell's current session. A document-level capture listener runs before the
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
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) {
        // This capture listener runs before dsh's `session.new`. Returning
        // without stopping the event opens a native session under the dialog.
        event.preventDefault()
        event.stopImmediatePropagation?.()
        event.stopPropagation?.()
        return
      }
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
        // Pane-aware `/resume`: while split mode is active, the chosen
        // conversation either replaces the focused pane (plain Enter) or opens
        // in a new pane beside it (Ctrl+Enter). The shell-level reveal would
        // move the current session instead of editing the layout. An
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
 * Diagnostic text for a swallowed `/fork` failure. `SessionForkError` carries
 * the host code (`session/fork-unavailable`, `session/migration-required`);
 * anything else is still warned, never rethrown.
 *
 * @param {unknown} error
 * @returns {string}
 */
function forkFailureText(error) {
  const code =
    error instanceof Error && error.name === 'SessionForkError' && typeof error.rpcError?.code === 'string'
      ? error.rpcError.code
      : ''
  const message = messageOf(error)
  return code === '' ? message : `${code}: ${message}`
}

/**
 * @param {unknown} error
 */
function warnForkFailure(error) {
  console.warn('[dsh-hk-craft] /fork failed:', forkFailureText(error))
}

/**
 * Swallow a thenable rejection. `run` is not awaited by the shell, so a
 * rejection that escapes becomes unhandled.
 *
 * @param {unknown} attempt
 * @param {(error: unknown) => void} onError
 */
function whenRejected(attempt, onError) {
  if (attempt !== null && typeof attempt === 'object' && typeof attempt.catch === 'function') {
    attempt.catch(onError)
  }
}

/**
 * Build the `/fork` contribution.
 *
 * This calls the same `uiWorkspace.forkSession` the native sidebar uses, with
 * `{ allowMigration: false }`, and does not navigate. In the pane workspace the
 * host's `onCreated` opens the copy beside the focused pane; a refused new pane
 * leaves the copy in the session list. See
 * `docs/upstream-contracts.md#forking-a-session-uiworkspaceforksession`.
 *
 * `catalogOf` is a getter, not a catalog: `available` runs long after
 * registration, so it must read the current snapshot.
 *
 * @param {object} deps
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t translator
 * @param {object} [deps.panes] pane host face
 * @param {() => any} deps.catalogOf current read model
 * @param {object} deps.uiWorkspace workspace navigation service
 * @returns {object} command contribution
 */
function buildForkCommand({ t, panes, catalogOf, uiWorkspace }) {
  return {
    name: 'fork',
    label: () => t('command.fork.label'),
    description: () => t('command.fork.description'),
    available: (session) => {
      const row = catalogOf().session(session?.sessionId)
      // A summary that has not loaded is not "blank": only a conversation that
      // provably never sent a message is hidden from the menu.
      return row === undefined || row.started === true
    },
    ui: {
      kind: 'action',
      run: (session) => {
        const sessionId = session?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') return
        const onCreated = panePanelActive(panes)
          ? (childId) => {
              // `sessions.fork` renames the child after `onCreated`. A throw here
              // would skip that rename and look like a failed fork, even though
              // the copy already exists. A refused pane returns false instead.
              try {
                if (typeof panes?.openInNewPane !== 'function') return
                whenRejected(panes.openInNewPane(childId), () => {})
              } catch (_error) {
                // The copy stays in the session list.
              }
            }
          : undefined
        try {
          whenRejected(uiWorkspace.forkSession(sessionId, onCreated, { allowMigration: false }), warnForkFailure)
        } catch (error) {
          warnForkFailure(error)
        }
      },
    },
  }
}

/**
 * The focused pane id, or undefined when there is no focused pane.
 *
 * @param {object} [panes] pane host face
 * @returns {string|undefined}
 */
function focusedPaneId(panes) {
  const focused = focusedPane(panes)
  if (focused === null || typeof focused.paneId !== 'string' || focused.paneId === '') return undefined
  return focused.paneId
}

/**
 * Whether `/trace` can act: the pane workspace is showing, a pane is focused,
 * and the host still offers the trajectory view.
 *
 * @param {object} [panes] pane host face
 * @returns {boolean}
 */
function traceReady(panes) {
  if (!panePanelActive(panes) || focusedPaneId(panes) === undefined) return false
  try {
    return panes.canTrace() === true
  } catch (_error) {
    return false
  }
}

/**
 * Build the `/trace` contribution.
 *
 * One-way switch of the focused pane to the trajectory view. Already being
 * there is a no-op inside `setView`. The command does not change which session
 * is mounted, and a `false` return (the developer-tools gate closed after the
 * menu opened) is ignored.
 *
 * @param {object} deps
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t translator
 * @param {object} deps.panes pane host face
 * @returns {object} command contribution
 */
function buildTraceCommand({ t, panes }) {
  return {
    name: 'trace',
    label: () => t('command.trace.label'),
    description: () => t('command.trace.description'),
    available: () => traceReady(panes),
    ui: {
      kind: 'action',
      run: () => {
        const paneId = focusedPaneId(panes)
        if (paneId === undefined) return
        try {
          panes.setView(paneId, 'trajectory')
        } catch (_error) {
          // The developer-tools gate can close after the menu opened.
        }
      },
    },
  }
}

/**
 * Register the slash commands (and the pane-aware `Mod+N` binding) onto the
 * client command service.
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
  /** The read model at call time; the memo makes repeated reads free. */
  const catalogOf = () => openCatalog(readCatalogs({ sessions: services.sessions, workspaces }))
  const workspaceIdFor = (sessionId) => catalogOf().workspaceOf(sessionId)?.id
  const conversations =
    services.conversationsFor ??
    ((triggerSessionId, signal) =>
      listConversations({ sessions: services.sessions, catalog: catalogOf() }, triggerSessionId, {
        signal,
      }))
  const open = services.openConversation ?? ((sessionId) => openConversation(services.uiWorkspace, sessionId))
  const start = services.startConversation ?? ((workspaceId) => startConversation(services.uiWorkspace, workspaceId))
  const keyTarget = services.keyTarget ?? globalThis.document
  const tracker =
    services.newPaneRequested === undefined ? createCtrlEnterTracker(keyTarget) : null
  const newPaneRequested = services.newPaneRequested ?? (() => tracker.consume())

  const disposers = [
    commandUi.register(buildNewConversationCommand({ t, workspaceIdFor, start, panes })),
    commandUi.register(buildNewConversationCommand({ name: 'new', t, workspaceIdFor, start, panes })),
    commandUi.register(
      buildResumeCommand({ t, workspaceIdFor, conversations, open, now, panes, newPaneRequested }),
    ),
  ]
  if (typeof services.uiWorkspace?.forkSession === 'function') {
    disposers.push(
      commandUi.register(
        buildForkCommand({ t, panes, catalogOf, uiWorkspace: services.uiWorkspace }),
      ),
    )
  }
  if (typeof panes?.canTrace === 'function' && typeof panes?.setView === 'function') {
    disposers.push(commandUi.register(buildTraceCommand({ t, panes })))
  }
  if (tracker !== null) disposers.push(() => tracker.dispose())
  // `Mod+N` only has a pane-aware meaning while the pane host exists.
  if (panes !== undefined && panes !== null) {
    const binding = createNewConversationBinding(keyTarget, panes)
    disposers.push(() => binding.dispose())
  }
  return disposers
}

module.exports = {
  buildNewConversationCommand,
  buildResumeCommand,
  createCtrlEnterTracker,
  createNewConversationBinding,
  isModN,
  registerCommands,
}
