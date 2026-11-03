'use strict'

/**
 * The host's workspace display order and the neighbour rules built on it.
 *
 * `workspaces.list().items` is already in display order and is the only order the
 * plugin renders (`docs/upstream-contracts.md#workspace-display-order`); the
 * `catalog` read model preserves it. Three callers need the same reads:
 *
 * - the sidebar resolves a drop anchor, and the focus target after a delete,
 *   against this order;
 * - the adapter captures the pre-delete order, because a successful delete drops
 *   the row from `workspaces.list` immediately
 *   (`docs/upstream-contracts.md#deleting-a-workspace`);
 * - the pane controller hands the visible view to the deleted workspace's
 *   next-or-previous neighbour.
 *
 * Pure on purpose: the input is the catalog or an id list, the output is ids, so
 * the rules stay Node-testable without React or dsh.
 */

/**
 * The workspace ids of one catalog, in host display order.
 *
 * Malformed rows never reach here: `catalog.workspaces()` already drops an item
 * without an id, so this is a plain projection.
 *
 * @param {{ workspaces: () => ReadonlyArray<{ id: string }> } | null | undefined} catalog
 * @returns {string[]}
 */
function workspaceOrderOf(catalog) {
  if (catalog === null || catalog === undefined) return []
  return catalog.workspaces().map((workspace) => workspace.id)
}

/**
 * The row after `workspaceId` in host order, if any.
 *
 * @param {ReadonlyArray<string> | null | undefined} order
 * @param {string} workspaceId
 * @returns {string | undefined}
 */
function nextWorkspaceId(order, workspaceId) {
  if (!Array.isArray(order) || typeof workspaceId !== 'string' || workspaceId === '') return undefined
  const index = order.indexOf(workspaceId)
  if (index === -1) return undefined
  for (let i = index + 1; i < order.length; i += 1) {
    if (order[i] !== workspaceId) return order[i]
  }
  return undefined
}

/**
 * The row before `workspaceId` in host order, if any.
 *
 * @param {ReadonlyArray<string> | null | undefined} order
 * @param {string} workspaceId
 * @returns {string | undefined}
 */
function previousWorkspaceId(order, workspaceId) {
  if (!Array.isArray(order) || typeof workspaceId !== 'string' || workspaceId === '') return undefined
  const index = order.indexOf(workspaceId)
  if (index === -1) return undefined
  for (let i = index - 1; i >= 0; i -= 1) {
    if (order[i] !== workspaceId) return order[i]
  }
  return undefined
}

/**
 * The workspace that inherits the view when `deletedId` goes away: the next one
 * in host order, else the previous one, else none.
 *
 * @param {ReadonlyArray<string> | null | undefined} order
 * @param {string} deletedId
 * @returns {string | null}
 */
function neighbourWorkspaceId(order, deletedId) {
  return nextWorkspaceId(order, deletedId) ?? previousWorkspaceId(order, deletedId) ?? null
}

/**
 * Where focus should land after a workspace is deleted: the next row, else the
 * "Add workspace" entry. The previous row is deliberately not a candidate — the
 * user's next action belongs below the deleted row, and the add entry is the one
 * control that is always present.
 *
 * A structured target keeps the add entry distinct from any workspace id.
 *
 * @param {ReadonlyArray<string> | null | undefined} order
 * @param {string} deletedId
 * @returns {{ kind: 'workspace', workspaceId: string } | { kind: 'add' }}
 */
function deleteFocusTarget(order, deletedId) {
  const next = nextWorkspaceId(order, deletedId)
  return next === undefined ? { kind: 'add' } : { kind: 'workspace', workspaceId: next }
}

module.exports = {
  workspaceOrderOf,
  nextWorkspaceId,
  previousWorkspaceId,
  neighbourWorkspaceId,
  deleteFocusTarget,
}
