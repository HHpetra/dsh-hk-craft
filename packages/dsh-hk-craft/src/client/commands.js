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
 * Build the `/clear` contribution.
 *
 * @param {object} deps
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t translator
 * @param {(sessionId: string|undefined) => string|undefined} deps.workspaceIdFor workspace lookup
 * @param {(workspaceId: string|undefined) => void} deps.start new-conversation action
 * @returns {object} command contribution
 */
function buildClearCommand({ t, workspaceIdFor, start }) {
  return {
    name: 'clear',
    label: () => t('command.clear.label'),
    description: () => t('command.clear.description'),
    available: () => true,
    ui: {
      kind: 'action',
      run: (session) => {
        start(workspaceIdFor(session?.sessionId))
      },
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
 * @returns {object} command contribution
 */
function buildResumeCommand({ t, workspaceIdFor, conversations, open, now }) {
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
 * @returns {(() => void)[]} registration disposers
 */
function registerCommands(services) {
  const { commandUi, workspaces, t } = services
  const now = services.now ?? (() => Date.now())
  const workspaceIdFor = (sessionId) => workspaceIdOf(workspaces?.list?.getSnapshot?.(), sessionId)
  const conversations =
    services.conversationsFor ??
    ((triggerSessionId, signal) =>
      listConversations({ sessions: services.sessions, workspaces }, triggerSessionId, { signal }))
  const open = services.openConversation ?? ((sessionId) => openConversation(services.uiWorkspace, sessionId))
  const start = services.startConversation ?? ((workspaceId) => startConversation(services.uiWorkspace, workspaceId))

  return [
    commandUi.register(buildClearCommand({ t, workspaceIdFor, start })),
    commandUi.register(
      buildResumeCommand({ t, workspaceIdFor, conversations, open, now }),
    ),
  ]
}

module.exports = { buildClearCommand, buildResumeCommand, registerCommands }
