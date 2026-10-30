'use strict'

/**
 * The dsh adapter for the sidebar workspace section.
 *
 * Every assumption about the host shell is concentrated here, so a wrong one is
 * a one-file fix. The component (`sidebar-workspaces.js`) consumes only the
 * plain rows and callbacks this module produces.
 *
 * Verified against the extracted dsh client/host packages under
 * `.scratch/_tmp/` (read-only reference, dsh 0.2.1-rc.5-d4db512):
 *
 * - The slot: `sidebar.workspaces`, a `single` root slot rendered by the sidebar
 *   shell as `renderSlot('sidebar.workspaces', { wide, expandSidebar })`
 *   (dsh-client-ui-sidebar/lib/client.js:502-510). Its shipped occupant is
 *   ui-workspace's `WorkspaceBrowser`, registered with no `priority`
 *   (dsh-client-ui-workspace/lib/client.js:5221-5252), i.e. priority 0; the slot
 *   core sorts entries ascending by `priority ?? 0` and renders the first, so a
 *   negative priority shadows it (frontend shell bundle, `register` /
 *   `entriesOfSlot`).
 * - Switching workspaces: `uiWorkspace.startSession(workspaceId, {
 *   clearPreviousDraft: false })` (dsh-client-ui-workspace/lib/client.js:1500-1528)
 *   reuses the workspace's blank session or creates one and makes it the main
 *   view. This is the same call the shipped picker makes after adding
 *   (…/client.js:3937-3939).
 * - Adding a workspace: dsh's own add flow picks a directory, calls
 *   `workspaces.create({ path })` and then selects the returned workspace
 *   (…/client.js:2605-2607). The picking half is either the Electron preload
 *   bridge `globalThis.__DSH_DIRECTORY_PICKER__.pick()`
 *   (dsh-client-ui-directory-picker-native/lib/client.js:63-64) or the public
 *   service `uiWorkspace.pickDirectory()`
 *   (dsh-client-ui-workspace/lib/client.js:1560-1564). Both resolve a path or
 *   `null` when the user cancels.
 * - Records: a workspace is `{ workspaceId, path, title, sessionIds, createdAt,
 *   updatedAt }` (dsh-api-workspace-controller/lib/typert.remote-client.js:48-53);
 *   `workspaces.list` is the snapshot `{ items, archivedSessionIds,
 *   pinnedSessionIds, phase, state }`
 *   (dsh-api-workspace-controller/lib/client.js:259-267), its `create`
 *   resolving the workspace or throwing `WorkspaceCreateError`
 *   (…/lib/client.js:386-397). The session list snapshot is `{ phase, ids,
 *   byId }`; `sessionStatus` is a `Map<sessionId, { running, pendingInteraction,
 *   completionUnread }>` (dsh-client-ui-session/lib/client.js:1104-1108,
 *   976-992). "Main view" is derived from the one session retained under
 *   `mainView` (…/client.js:973-975).
 * - The automatic first-use workspace title is the literal `default-workspace`,
 *   localized at display time (dsh-client-ui-workspace/lib/client.js:1737-1739).
 *
 * Known gap: dsh exposes no cheap "this session's last turn failed" bit — the
 * client status map carries only running / pendingInteraction / completionUnread
 * (dsh-client-ui-session/lib/client.js:984-988) and the host `SessionSummary`
 * has no error field (dsh-api-session-controller/lib/typert.host.js:2967), while
 * a turn failure is a conversation node. `workspace-status.js` therefore keeps
 * an `errored` input the light honors, but nothing feeds it yet: red currently
 * means "waiting for you". Reading errors would cost a per-session history open,
 * which the sidebar must not do (documented in the ticket's Comments).
 */

const { projectWorkspaceSection } = require('./workspace-status.js')

/** dsh's stored title for the automatic first workspace (display-time localized). */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace'

/**
 * Project the shell's live snapshots into the rows `WorkspaceSection` renders.
 *
 * @param {any} workspacesSnapshot `workspaces.list` snapshot
 * @param {any} sessionsSnapshot `sessions.list` snapshot
 * @param {any} statusSnapshot `sessionStatus` map
 * @returns {Array<{ workspaceId: string, title: string, light: 'green' | 'yellow' | 'red', current: boolean }>}
 */
function sectionModel(workspacesSnapshot, sessionsSnapshot, statusSnapshot) {
  return projectWorkspaceSection(workspacesSnapshot, sessionsSnapshot, statusSnapshot)
}

/**
 * The Electron preload directory bridge, when the shell provides one.
 *
 * @returns {{ pick: () => Promise<string | null> } | undefined}
 */
function desktopPicker() {
  const bridge = globalThis.__DSH_DIRECTORY_PICKER__
  return bridge !== undefined && bridge !== null && typeof bridge.pick === 'function' ? bridge : undefined
}

/**
 * Ask the user for one directory; `null` means they cancelled.
 *
 * @param {any} ctx client Cordis context
 * @returns {Promise<string | null | undefined>}
 */
async function pickDirectory(ctx) {
  const bridge = desktopPicker()
  if (bridge !== undefined) return bridge.pick()
  return ctx.get('uiWorkspace').pickDirectory()
}

/**
 * The section's two behaviors, over public client services only.
 *
 * @param {any} ctx client Cordis context (already injected with `uiWorkspace`
 *   and `workspaces` by the plugin entry)
 */
function createSectionActions(ctx) {
  return {
    /**
     * Switch to a workspace by starting (or reusing) its blank session.
     *
     * @param {string} workspaceId
     */
    openWorkspace(workspaceId) {
      ctx.get('uiWorkspace').startSession(workspaceId, { clearPreviousDraft: false })
    },

    /**
     * Add a workspace through dsh's own picking and creation path, then select
     * it. Resolves without doing anything when the user cancels the picker;
     * rejects with the shell's error otherwise, so the component can report it.
     *
     * @returns {Promise<void>}
     */
    async addWorkspace() {
      const path = await pickDirectory(ctx)
      if (path === null || path === undefined || path === '') return
      const workspace = await ctx.get('workspaces').create({ path })
      ctx.get('uiWorkspace').startSession(workspace.workspaceId, { clearPreviousDraft: false })
    },
  }
}

module.exports = {
  DEFAULT_WORKSPACE_TITLE,
  sectionModel,
  createSectionActions,
  pickDirectory,
}
