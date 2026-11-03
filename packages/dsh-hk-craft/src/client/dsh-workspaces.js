'use strict'

/**
 * The dsh **action** adapter for the sidebar workspace section: reveal, add,
 * reorder and delete a workspace.
 *
 * Reading the record graph — membership, titles, the current session, the light
 * signals — is `catalog.js`'s job (`GLOSSARY.md`: 清单快照). This module takes
 * the read model and never parses `byId`, `sessionIds` or `phase`; what is left
 * here is what no read model can answer: the calls and their order.
 *
 * Verified against the 0.2.0-rc.2 bundles; the pinned train is 0.2.1-rc.5
 * (`deps/VERSIONS.md`). The durable contract record lives in
 * `docs/upstream-contracts.md`; this module is the one place that adapts it:
 *
 * - The slot: `sidebar.workspaces` is a `single` root slot rendered by the
 *   sidebar shell as `renderSlot('sidebar.workspaces', { wide, expandSidebar })`
 *   (`docs/upstream-contracts.md#sidebarworkspaces-slot`). Its shipped occupant
 *   is ui-workspace's `WorkspaceBrowser`, registered with no `priority`, i.e.
 *   0; the slot core sorts entries ascending by `priority ?? 0` and renders the
 *   first, so a negative priority shadows it.
 * - Switching workspaces outside the pane view: reveal an existing conversation
 *   with `uiWorkspace.openSession(sessionId)`. `startSession` only connects a
 *   blank, so a sidebar that no longer lists conversations cannot land on the
 *   one the workspace already has. The blank path
 *   (`startSession(workspaceId, { clearPreviousDraft: false })`) remains the
 *   fallback when the workspace has no revealable conversation, and the path
 *   the add flow uses for a workspace that was just created
 *   (`docs/upstream-contracts.md#native-start-session-reveal`).
 * - Adding a workspace: dsh's own add flow picks a directory, calls
 *   `workspaces.create({ path })` and then selects the returned workspace. The
 *   picking half is either the Electron preload bridge
 *   `globalThis.__DSH_DIRECTORY_PICKER__.pick()` or the public service
 *   `uiWorkspace.pickDirectory()`; both resolve a path or `null` when the user
 *   cancels (`docs/upstream-contracts.md#directory-picker`).
 * - "Enabled" (ever opened in split) is the pane controller's answer, from its
 *   loaded layouts plus the workspace layout key's existence. Opening a
 *   workspace in the native view does not count, because it never writes a pane
 *   layout key (`docs/upstream-contracts.md#workspace-enablement-ever-opened-in-split`).
 * - The automatic first-use workspace title is the literal `default-workspace`,
 *   localized at display time (`workspace-status.js:displayWorkspaceName`).
 *
 * Red means "waiting for you" only: dsh exposes no cheap "this session's last
 * turn failed" bit, and reading one would mean opening per-session history,
 * which the sidebar must not do. See
 * `docs/upstream-contracts.md#session-summary-fields`.
 */

const { openCatalog, readCatalogs } = require('./catalog.js')
const { projectWorkspaceSection, visibleWorkspaceIdOf } = require('./workspace-status.js')
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
 * @param {any} catalog the read model
 * @param {{ isWorkspaceEnabled?: (workspaceId: string) => boolean } | null | undefined} panes
 * @returns {Set<string> | undefined}
 */
function enabledWorkspacesOf(catalog, panes) {
  if (panes === null || panes === undefined) return undefined
  if (typeof panes.isWorkspaceEnabled !== 'function') return undefined
  if (catalog === null || catalog === undefined) return undefined
  const enabled = new Set()
  try {
    for (const workspace of catalog.workspaces()) {
      if (panes.isWorkspaceEnabled(workspace.id)) enabled.add(workspace.id)
    }
  } catch (_error) {
    return undefined
  }
  return enabled
}

/**
 * Project the catalog into the rows `WorkspaceSection` renders.
 *
 * `paneSnapshot` is the object the section's one `getSnapshot` already
 * returned. This reads the 可见工作区 off that plain object; it does not
 * subscribe and it does not hand the controller to the projection. Omit the
 * snapshot (or pass one whose split is off) and the 当前行 stays on dsh's
 * current session.
 *
 * @param {any} catalog the read model (`catalog.js`)
 * @param {{ isWorkspaceEnabled?: (workspaceId: string) => boolean } | null} [panes]
 *   the pane controller face; omit it to treat every workspace as enabled
 * @param {unknown} [paneSnapshot] pane-controller snapshot, already read
 * @returns {Array<{ workspaceId: string, title: string, light: 'gray' | 'idle' | 'green' | 'yellow' | 'red', current: boolean }>}
 */
function sectionModel(catalog, panes, paneSnapshot) {
  return projectWorkspaceSection(
    catalog,
    enabledWorkspacesOf(catalog, panes),
    visibleWorkspaceIdOf(paneSnapshot),
  )
}

/**
 * How many member sessions of one workspace are running right now.
 *
 * The delete confirmation promises that deleting the workspace will not stop
 * those sessions, so the number has to come from the same signals the sidebar
 * light uses (`workspace-status.js:workspaceLight` over `catalog.signal`).
 * Archived sessions are out of reach from this sidebar, and a catalog that is
 * not ready cannot be trusted as a membership list — both contribute zero,
 * which is also the safe answer when the warning would be wrong
 * (`ADR-0016`: readiness is one rule, and a half-loaded list proves nothing).
 *
 * @param {any} catalog the read model
 * @param {string} workspaceId
 * @returns {number}
 */
function workspaceRunningCount(catalog, workspaceId) {
  if (catalog === null || catalog === undefined) return 0
  if (catalog.complete() !== true) return 0
  let running = 0
  for (const row of catalog.sessionsOf(workspaceId)) {
    if (row.archived === true) continue
    if (catalog.signal(row.id).running) running += 1
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
    return workspaceOrderOf(openCatalog(readCatalogs(ctx)))
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
 * Whether `sessionId` is a conversation this workspace can show: a member,
 * still in the catalog, not archived, and not a blank.
 *
 * @param {any} catalog the read model
 * @param {string} workspaceId
 * @param {unknown} sessionId
 * @returns {boolean}
 */
function isWorkspaceConversation(catalog, workspaceId, sessionId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') return false
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (catalog === null || catalog === undefined) return false
  if (catalog.complete() !== true) return false
  const row = catalog.sessionsOf(workspaceId).find((candidate) => candidate.id === sessionId)
  if (row === undefined) return false
  if (row.archived === true) return false
  return row.started === true
}

/**
 * The conversation a native workspace click should reveal.
 *
 * Outside the pane view the sidebar has no conversation list, so the click is
 * the only way to change which conversation is on screen. `startSession`
 * always connects a blank and therefore cannot do that. This picks a member
 * that has actually started:
 *
 * - the conversation already on screen, when it belongs to this workspace
 *   (clicking the current workspace must not jump to a sibling);
 * - otherwise the most recently updated non-blank member.
 *
 * Archived sessions are not openable. A blank is left for `startSession`,
 * which is the call that reuses or creates one. `undefined` means there is
 * nothing to reveal: the catalog is not ready, the workspace is unknown, or
 * every member is blank or archived.
 *
 * @param {any} catalog the read model
 * @param {string} workspaceId
 * @returns {string|undefined}
 */
function nativeConversationId(catalog, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined
  if (catalog === null || catalog === undefined) return undefined
  if (catalog.complete() !== true) return undefined

  const current = catalog.current()
  if (current !== undefined && current !== null && isWorkspaceConversation(catalog, workspaceId, current)) {
    return current
  }

  let bestId
  let bestTime = Number.NEGATIVE_INFINITY
  for (const row of catalog.sessionsOf(workspaceId)) {
    if (!isWorkspaceConversation(catalog, workspaceId, row.id)) continue
    if (row.updatedAt > bestTime) {
      bestTime = row.updatedAt
      bestId = row.id
    }
  }
  return bestId
}

/**
 * The section's behaviors, over public client services only.
 *
 * `options.panes` is the pane controller face. While split mode is active,
 * clicking a workspace must not call the native reveal: that path goes through
 * `replaceMain(..., "reveal")`, which moves the shell's current session instead
 * of switching the layout tree (the loss D5 forbids). In split mode the click
 * switches which workspace tree is visible, and the pane controller shows that
 * workspace's conversation when the tree is not already showing one. When split
 * mode is not active, the click reveals that workspace's existing conversation; a workspace
 * with nothing to reveal falls back to the native blank session, which is also
 * the fallback when the pane controller refuses the switch. Deleting is the
 * mirror image: the public registration goes first and the pane controller
 * cleans up locally afterwards.
 *
 * @param {any} ctx client Cordis context (already injected with `uiWorkspace`
 *   and `workspaces` by the plugin entry)
 * @param {{panes?: {active?: () => boolean, switchWorkspace?: (workspaceId: string) => boolean, forgetWorkspace?: (workspaceId: string, options?: {order?: string[]}) => boolean}}} [options]
 */
function createSectionActions(ctx, options = {}) {
  const panes = options?.panes

  /**
   * Switch to a workspace.
   *
   * While the pane workspace is showing, show that workspace's pane tree. The
   * pane controller puts the workspace's conversation on screen when that tree
   * does not already have one. Otherwise reveal its existing conversation in
   * the native view. A workspace with no revealable conversation starts (or
   * reuses) its blank session —
   * the same call the add flow needs for a workspace that has no history yet.
   *
   * @param {string} workspaceId
   */
  function openWorkspace(workspaceId) {
    if (panes?.active?.() === true && panes?.switchWorkspace?.(workspaceId) === true) return
    const uiWorkspace = ctx.get('uiWorkspace')
    const sessionId = nativeConversationId(openCatalog(readCatalogs(ctx)), workspaceId)
    if (sessionId !== undefined && typeof uiWorkspace?.openSession === 'function') {
      return uiWorkspace.openSession(sessionId)
    }
    return uiWorkspace.startSession(workspaceId, { clearPreviousDraft: false })
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
     * before rejecting (`docs/upstream-contracts.md#workspace-display-order`).
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
     * `docs/upstream-contracts.md#deleting-a-workspace`).
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
  isWorkspaceConversation,
  nativeConversationId,
  createSectionActions,
  pickDirectory,
}
