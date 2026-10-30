'use strict'

/**
 * The dsh adapter for the sidebar workspace section.
 *
 * Every assumption about the host shell is concentrated here, so a wrong one is
 * a one-file fix. The component (`sidebar-workspaces.js`) consumes only the
 * plain rows and callbacks this module produces.
 *
 * Verified against the 0.2.0-rc.2 bundles; the pinned train is 0.2.1-rc.5
 * (`deps/VERSIONS.md`). The durable contract record lives in
 * `doc/upstream-contracts.md`; this module is the one place that adapts it:
 *
 * - The slot: `sidebar.workspaces` is a `single` root slot rendered by the
 *   sidebar shell as `renderSlot('sidebar.workspaces', { wide, expandSidebar })`
 *   (`doc/upstream-contracts.md#sidebarworkspaces-slot`). Its shipped occupant
 *   is ui-workspace's `WorkspaceBrowser`, registered with no `priority`, i.e.
 *   0; the slot core sorts entries ascending by `priority ?? 0` and renders the
 *   first, so a negative priority shadows it.
 * - Switching workspaces: `uiWorkspace.startSession(workspaceId, {
 *   clearPreviousDraft: false })` reuses the workspace's blank session or
 *   creates one and makes it the main view — the same call the shipped picker
 *   makes after adding (`doc/upstream-contracts.md#creating-a-session-without-leaving-the-panel`).
 * - Adding a workspace: dsh's own add flow picks a directory, calls
 *   `workspaces.create({ path })` and then selects the returned workspace. The
 *   picking half is either the Electron preload bridge
 *   `globalThis.__DSH_DIRECTORY_PICKER__.pick()` or the public service
 *   `uiWorkspace.pickDirectory()`; both resolve a path or `null` when the user
 *   cancels (`doc/upstream-contracts.md#directory-picker`).
 * - Records: `workspaces.list` is `{ items, archivedSessionIds,
 *   pinnedSessionIds, phase, state }` with workspace members in `sessionIds`;
 *   the session list snapshot is `{ phase, ids, byId }`; `sessionStatus` is a
 *   `Map<sessionId, { running, pendingInteraction, completionUnread }>`. "Main
 *   view" is derived from the one session retained under `mainView`
 *   (`doc/upstream-contracts.md#workspace-catalog`,
 *   `#session-summary-fields`).
 * - A summary row's `blank` bit is inverted into the light's `started` signal: a
 *   conversation that never sent a message must not light its workspace green
 *   (`doc/upstream-contracts.md#session-summary-fields`).
 * - "Enabled" (ever opened in split) is the pane controller's answer, from its
 *   loaded layouts plus the workspace layout key's existence. Opening a
 *   workspace in the native view does not count, because it never writes a pane
 *   layout key (`doc/upstream-contracts.md#workspace-enablement-ever-opened-in-split`).
 * - The automatic first-use workspace title is the literal `default-workspace`,
 *   localized at display time (`workspace-status.js:displayWorkspaceName`).
 *
 * Red means "waiting for you" only: dsh exposes no cheap "this session's last
 * turn failed" bit, and reading one would mean opening per-session history,
 * which the sidebar must not do. See
 * `doc/upstream-contracts.md#session-summary-fields`.
 */

const { projectWorkspaceSection, readStatus, sessionSignal } = require('./workspace-status.js')
const { workspaceOrderOf } = require('./workspace-order.js')

/**
 * The enabled-workspace set for one projection, or `undefined` when it cannot be
 * known.
 *
 * `panes` is the pane controller's narrow face (`isWorkspaceEnabled`). A missing
 * face, a face without the method, or a throw inside it all mean "cannot know":
 * returning `undefined` makes the projection treat every workspace as enabled,
 * which loses the never-opened gray instead of painting the column gray (spec
 * §1). A set is still returned when the controller answered for every row, so an
 * empty set genuinely means "none of these was ever opened in split".
 *
 * @param {{ items?: ReadonlyArray<any> } | undefined} workspacesSnapshot
 * @param {{ isWorkspaceEnabled?: (workspaceId: string) => boolean } | null | undefined} panes
 * @returns {Set<string> | undefined}
 */
function enabledWorkspacesOf(workspacesSnapshot, panes) {
  if (panes === null || panes === undefined) return undefined
  if (typeof panes.isWorkspaceEnabled !== 'function') return undefined
  const items = Array.isArray(workspacesSnapshot?.items) ? workspacesSnapshot.items : []
  const enabled = new Set()
  try {
    for (const item of items) {
      const workspaceId = item?.workspaceId
      if (typeof workspaceId !== 'string' || workspaceId === '') continue
      if (panes.isWorkspaceEnabled(workspaceId)) enabled.add(workspaceId)
    }
  } catch (_error) {
    return undefined
  }
  return enabled
}

/**
 * Project the shell's live snapshots into the rows `WorkspaceSection` renders.
 *
 * @param {any} workspacesSnapshot `workspaces.list` snapshot
 * @param {any} sessionsSnapshot `sessions.list` snapshot
 * @param {any} statusSnapshot `sessionStatus` map
 * @param {{ isWorkspaceEnabled?: (workspaceId: string) => boolean } | null} [panes]
 *   the pane controller face; omit it to treat every workspace as enabled
 * @returns {Array<{ workspaceId: string, title: string, light: 'gray' | 'green' | 'yellow' | 'red', current: boolean }>}
 */
function sectionModel(workspacesSnapshot, sessionsSnapshot, statusSnapshot, panes) {
  return projectWorkspaceSection(
    workspacesSnapshot,
    sessionsSnapshot,
    statusSnapshot,
    enabledWorkspacesOf(workspacesSnapshot, panes),
  )
}

/**
 * How many member sessions of one workspace are running right now.
 *
 * The delete confirmation promises that deleting the workspace will not stop
 * those sessions, so the number has to come from the same signals the sidebar
 * light uses (`workspace-status.js:sessionSignal`): the unified status map
 * first, the summary row second. Archived sessions are out of reach from this
 * sidebar, sessions dsh no longer knows are skipped, and a catalog that is
 * still loading cannot be trusted as a membership list — all three contribute
 * zero, which is also the safe answer when the warning would be wrong.
 *
 * @param {any} workspacesSnapshot `workspaces.list` snapshot
 * @param {any} sessionsSnapshot `sessions.list` snapshot
 * @param {any} statusSnapshot `sessionStatus` map
 * @param {string} workspaceId
 * @returns {number}
 */
function workspaceRunningCount(workspacesSnapshot, sessionsSnapshot, statusSnapshot, workspaceId) {
  if (workspacesSnapshot?.phase !== 'ready') return 0
  if (sessionsSnapshot?.phase === 'loading') return 0
  const items = Array.isArray(workspacesSnapshot.items) ? workspacesSnapshot.items : []
  const item = items.find((candidate) => candidate?.workspaceId === workspaceId)
  if (item === undefined) return 0
  const archived = new Set(workspacesSnapshot.archivedSessionIds ?? [])
  const byId = sessionsSnapshot?.byId ?? {}
  let running = 0
  for (const sessionId of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
    if (archived.has(sessionId)) continue
    const summary = byId[sessionId]
    if (summary === undefined || summary === null) continue
    if (sessionSignal(summary, readStatus(statusSnapshot, sessionId)).running) running += 1
  }
  return running
}

/**
 * The host's workspace ids in display order, read once for a delete. The list
 * drops the deleted row as soon as the public call succeeds, so the controller
 * cannot recover the old position afterwards.
 *
 * @param {any} ctx client Cordis context
 * @returns {string[]}
 */
function hostWorkspaceOrder(ctx) {
  try {
    return workspaceOrderOf(ctx.get('workspaces')?.list?.getSnapshot?.())
  } catch (_error) {
    return []
  }
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
 * The section's behaviors, over public client services only.
 *
 * `options.panes` is the pane controller face. While the plugin
 * pane workspace is showing, clicking a workspace must not call the native
 * `startSession`: that path reveals the session through
 * `replaceMain(..., "reveal")`, which calls `selectPanel(null)` and dismisses
 * the pane workspace, unmounting every pane (the exact loss D5 forbids). In
 * pane mode the click only switches which workspace tree is visible; the
 * native reveal stays the behavior when the pane workspace is not showing, and
 * remains the fallback when the pane controller refuses the switch. Deleting is
 * the mirror image: the public registration goes first and the pane controller
 * cleans up locally afterwards.
 *
 * @param {any} ctx client Cordis context (already injected with `uiWorkspace`
 *   and `workspaces` by the plugin entry)
 * @param {{panes?: {active?: () => boolean, switchWorkspace?: (workspaceId: string) => boolean, forgetWorkspace?: (workspaceId: string, options?: {order?: string[]}) => boolean}}} [options]
 */
function createSectionActions(ctx, options = {}) {
  const panes = options?.panes

  /**
   * Switch to a workspace: show its pane tree when the pane workspace is
   * active, otherwise start (or reuse) its blank session natively.
   *
   * @param {string} workspaceId
   */
  function openWorkspace(workspaceId) {
    if (panes?.active?.() === true && panes?.switchWorkspace?.(workspaceId) === true) return
    return ctx.get('uiWorkspace').startSession(workspaceId, { clearPreviousDraft: false })
  }

  return {
    openWorkspace,

    /**
     * Persist a new workspace display order by moving `workspaceId` before
     * `beforeWorkspaceId`; omitting the anchor appends to the end.
     *
     * The host is the order's only source of truth: the `workspaces` client
     * model installs the optimistic order itself, reconciles it with the
     * returned complete order, and on failure restores the committed order
     * before rejecting (`doc/upstream-contracts.md#workspace-display-order`).
     * This adapter therefore writes nothing locally and lets the rejection
     * reach the component, which only reports it.
     *
     * @param {string} workspaceId the dragged workspace
     * @param {string} [beforeWorkspaceId] anchor; omitted appends
     * @returns {Promise<void>}
     */
    async reorderWorkspace(workspaceId, beforeWorkspaceId) {
      await ctx.get('workspaces').insertBefore(workspaceId, beforeWorkspaceId)
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
      openWorkspace(workspace.workspaceId)
    },

    /**
     * Delete a workspace registration.
     *
     * The public service goes first: a host refusal must leave the pane layout
     * exactly as it was, so the local cleanup only runs after the call resolves.
     * The workspace order is captured beforehand because a successful delete
     * drops the row from `workspaces.list` immediately, while `forgetWorkspace`
     * still needs the deleted row's old position to pick the next/previous
     * neighbour.
     *
     * Deleting the registration never deletes the directory or the sessions and
     * never interrupts a running turn (see
     * `doc/upstream-contracts.md#deleting-a-workspace`).
     *
     * @param {string} workspaceId
     * @returns {Promise<void>} rejects with the shell's error when the host
     *   refuses the delete
     */
    async deleteWorkspace(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        throw new Error('deleteWorkspace: a workspace id is required')
      }
      const workspaces = ctx.get('workspaces')
      if (typeof workspaces?.delete !== 'function') {
        throw new Error('workspaces.delete is not available in this shell')
      }
      const order = hostWorkspaceOrder(ctx)
      await workspaces.delete(workspaceId)
      try {
        // The registration is already gone at this point. Local pane cleanup
        // must stay best-effort: a controller failure may not turn a successful
        // delete into a reported error, which would invite a second delete.
        panes?.forgetWorkspace?.(workspaceId, { order })
      } catch (error) {
        console.error('[dsh-hk-craft] failed to forget the deleted workspace layout', error)
      }
    },
  }
}

module.exports = {
  sectionModel,
  workspaceRunningCount,
  createSectionActions,
  pickDirectory,
}
