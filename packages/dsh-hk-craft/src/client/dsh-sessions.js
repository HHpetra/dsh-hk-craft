'use strict'

/**
 * Every dsh assumption behind `/clear` and `/resume` lives here.
 *
 * Components and command handlers only ever see the plain rows this module
 * returns; if one of the assumed shapes changes upstream, this is the only file
 * that needs to change. Verified against the 0.2.0-rc.2 bundles; the pinned
 * train is 0.2.1-rc.5 (`deps/VERSIONS.md`), and the durable record is
 * `doc/upstream-contracts.md`:
 *
 * - `sessions.list` snapshot shape (`ids`, `byId`, `phase`), the per-row
 *   `{id, title, displayTitle, running, blank, updatedAt}` projection, and
 *   `ClientSessions.using(target, {source, signal}, operate)` —
 *   `doc/upstream-contracts.md#session-summary-fields`.
 * - `displayTitle` falls back to the cwd basename and then the raw id, so a
 *   "missing title" decision must read `title`, never `displayTitle`.
 * - `workspaces.list` snapshot `{items, archivedSessionIds, pinnedSessionIds}`
 *   with `workspace.sessionIds` / `workspace.path` —
 *   `doc/upstream-contracts.md#workspace-catalog`.
 * - Opening a session: `uiWorkspace.openSession(sessionId)` →
 *   `replaceMain(…, "reveal")` —
 *   `doc/upstream-contracts.md#native-start-session-reveal`.
 * - New session in the current workspace: `uiWorkspace.startSession(workspaceId)`
 *   → `connectBlank` reuses an existing blank, otherwise creates one, then
 *   reveals it — `doc/upstream-contracts.md#creating-a-session-without-leaving-the-panel`.
 * - First user prompt: there is no first-prompt projection on the wire (the
 *   list schema only carries `title` and `sessionListMetadata`), so it is read
 *   from the session's event window: `binding.session.eventSource.getSnapshot()
 *   .entries`, `session.loadOlder()`, entries shaped `{event}`, `user/message`
 *   with `data.source.kind === "user"` and text blocks (same filter as dsh's
 *   session-title derivation) — `doc/upstream-contracts.md#session-summary-fields`.
 */

const { normalizeText } = require('./resume-list.js')

/** Retain source for the brief history reads done while building the list. */
const SOURCE = 'hkcraftResume'

/** How many titleless conversations get a first-prompt lookup per opening. */
const MAX_PROMPT_LOOKUPS = 6

/** How many older history pages one first-prompt lookup may pull. */
const MAX_PROMPT_PAGES = 4

/**
 * Resolve the workspace that owns a session.
 *
 * @param {{items?: {workspaceId: string, sessionIds?: string[]}[]}} [snapshot] workspaces snapshot
 * @param {unknown} sessionId session identity
 * @returns {string|undefined} owning workspace id
 */
function workspaceIdOf(snapshot, sessionId) {
  if (snapshot === undefined || snapshot === null || !Array.isArray(snapshot.items)) return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  for (const workspace of snapshot.items) {
    if (workspace === null || typeof workspace !== 'object') continue
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      return workspace.workspaceId
    }
  }
  return undefined
}

/**
 * Project the session catalog into plain conversation rows for one workspace.
 *
 * Every workspace member present in the catalog is listed — including blanks
 * and archived sessions — because filtering is the pure list builder's job.
 *
 * @param {object} input
 * @param {object} input.sessions `sessions.list` snapshot
 * @param {object} input.workspaces `workspaces.list` snapshot
 * @param {string} input.workspaceId workspace to project
 * @returns {object[]} plain conversation rows
 */
function conversationsOf({ sessions, workspaces, workspaceId }) {
  const sessionRows = sessions?.byId
  const workspace = Array.isArray(workspaces?.items)
    ? workspaces.items.find((item) => item?.workspaceId === workspaceId)
    : undefined
  if (sessionRows === undefined || workspace === undefined || !Array.isArray(workspace.sessionIds)) return []
  const archived = new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : [])

  const rows = []
  for (const sessionId of workspace.sessionIds) {
    if (typeof sessionId !== 'string') continue
    const summary = sessionRows[sessionId]
    if (summary === undefined || summary === null) continue
    rows.push({
      sessionId,
      workspaceId,
      title: typeof summary.title === 'string' ? summary.title : '',
      firstPrompt: '',
      updatedAt: typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0,
      running: summary.running === true,
      blank: summary.blank === true,
      archived: archived.has(sessionId),
    })
  }
  return rows
}

/**
 * Extract the first human-authored text from a session event window.
 *
 * @param {{event?: {type?: string, data?: any}}[]} [entries] event window
 * @returns {string} normalized first prompt, or '' when none is present
 */
function firstUserPromptOf(entries) {
  if (!Array.isArray(entries)) return ''
  for (const entry of entries) {
    const event = entry?.event
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const text = normalizeText(
      content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n'),
    )
    if (text !== '') return text
  }
  return ''
}

/**
 * Best-effort first prompt for one session: read the tail window, page older
 * history a bounded number of times, and never reject.
 *
 * @param {object} sessions ClientSessions service
 * @param {string} sessionId session to read
 * @param {AbortSignal} [signal] popup lifetime
 * @param {{maxPages?: number}} [options]
 * @returns {Promise<string>} normalized first prompt, or ''
 */
async function firstPromptOf(sessions, sessionId, signal, options = {}) {
  const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : MAX_PROMPT_PAGES
  try {
    return await sessions.using(sessionId, { source: SOURCE, signal }, async (reference) => {
      const session = reference?.binding?.session
      if (session === undefined || session === null) return ''
      let prompt = firstUserPromptOf(session.eventSource?.getSnapshot?.().entries)
      let pages = 0
      while (prompt === '' && session.hasMore === true && pages < maxPages) {
        // `loadOlder` is the Session's own page-back request; it swallows remote
        // failures and returns undefined, so the loop re-reads the window after.
        await session.loadOlder()
        pages += 1
        prompt = firstUserPromptOf(session.eventSource.getSnapshot().entries)
      }
      return prompt
    })
  } catch (_error) {
    return ''
  }
}

/**
 * Fill the first-prompt fallback for the titleless, non-blank, non-archived
 * rows of a list. Shared by `/resume` and the pane empty state so both lists
 * read the same durable data through the same bounded lookup.
 *
 * @param {object} sessions ClientSessions service
 * @param {object[]} rows conversation rows, mutated in place
 * @param {{signal?: AbortSignal, promptLookups?: number, promptPages?: number}} [options]
 * @returns {Promise<void>}
 */
async function fillFirstPrompts(sessions, rows, options = {}) {
  const lookupLimit = Number.isInteger(options.promptLookups) ? options.promptLookups : MAX_PROMPT_LOOKUPS
  const pending = rows
    .filter((row) => row.blank !== true && row.archived !== true && normalizeText(row.title) === '')
    .slice(0, Math.max(0, lookupLimit))

  await Promise.all(
    pending.map(async (row) => {
      row.firstPrompt = await firstPromptOf(sessions, row.sessionId, options.signal, {
        maxPages: options.promptPages,
      })
    }),
  )
}

/**
 * Build one workspace's raw conversation list without needing a triggering
 * session. This is the empty state's data source (ticket 10): it reuses the
 * exact `/resume` projection (`conversationsOf`) and prompt fallback
 * (`fillFirstPrompts`) instead of inventing a second list.
 *
 * @param {{sessions: object, workspaces: object}} services client services
 * @param {string} workspaceId workspace to project
 * @param {{signal?: AbortSignal, promptLookups?: number, promptPages?: number}} [options]
 * @returns {Promise<object[]>} plain conversation rows
 */
async function listWorkspaceConversations(services, workspaceId, options = {}) {
  if (typeof workspaceId !== 'string' || workspaceId === '') return []
  const sessions = services?.sessions
  const workspaces = services?.workspaces
  const sessionsSnapshot = sessions?.list?.getSnapshot?.()
  const workspacesSnapshot = workspaces?.list?.getSnapshot?.()
  if (sessionsSnapshot === undefined || workspacesSnapshot === undefined) return []

  const rows = conversationsOf({ sessions: sessionsSnapshot, workspaces: workspacesSnapshot, workspaceId })
  await fillFirstPrompts(sessions, rows, options)
  return rows
}

/**
 * Build the raw conversation list for `/resume`: the triggering session's
 * workspace, in catalog order, with first prompts filled in for the handful of
 * titleless conversations that need the fallback.
 *
 * @param {{sessions: object, workspaces: object}} services client services
 * @param {string} triggerSessionId session the command was invoked from
 * @param {{signal?: AbortSignal, promptLookups?: number, promptPages?: number}} [options]
 * @returns {Promise<object[]>} plain conversation rows
 */
async function listConversations(services, triggerSessionId, options = {}) {
  const workspacesSnapshot = services?.workspaces?.list?.getSnapshot?.()
  if (workspacesSnapshot === undefined) return []
  const workspaceId = workspaceIdOf(workspacesSnapshot, triggerSessionId)
  if (workspaceId === undefined) return []
  return listWorkspaceConversations(services, workspaceId, options)
}

/**
 * Reveal an existing conversation in the main view.
 *
 * @param {object} uiWorkspace `uiWorkspace` service
 * @param {string} sessionId session to show
 * @returns {void}
 */
function openConversation(uiWorkspace, sessionId) {
  uiWorkspace.openSession(sessionId)
}

/**
 * Start a new conversation and switch to it. With no workspace id the shell
 * resolves the current workspace itself.
 *
 * @param {object} uiWorkspace `uiWorkspace` service
 * @param {string} [workspaceId] workspace to create the session in
 * @returns {void}
 */
function startConversation(uiWorkspace, workspaceId) {
  if (workspaceId === undefined) uiWorkspace.startSession()
  else uiWorkspace.startSession(workspaceId)
}

module.exports = {
  SOURCE,
  MAX_PROMPT_LOOKUPS,
  MAX_PROMPT_PAGES,
  workspaceIdOf,
  conversationsOf,
  firstUserPromptOf,
  firstPromptOf,
  fillFirstPrompts,
  listWorkspaceConversations,
  listConversations,
  openConversation,
  startConversation,
}
