'use strict'

/**
 * Host workspace order and the neighbour rules built on it.
 *
 * `workspaces.list().items` is already in display order and is the only order the
 * plugin renders (`doc/upstream-contracts.md#workspace-display-order`); the
 * catalog preserves it. The sidebar, the adapter and the pane controller all read
 * that order: the sidebar resolves a drop and the focus target after a delete,
 * the adapter captures the pre-delete order, and the controller hands the view to
 * the neighbour. These tests pin the shared rules once, at the pure seam.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  deleteFocusTarget,
  neighbourWorkspaceId,
  nextWorkspaceId,
  previousWorkspaceId,
  workspaceOrderOf,
} = require('./workspace-order.js')
const { openCatalog } = require('./catalog.js')
const { workspaceItem, workspacesSnapshot } = require('./snapshot-fixtures.js')

test('the order is the catalog order, ids only', () => {
  const catalog = openCatalog({
    workspaces: workspacesSnapshot([
      workspaceItem('w1'),
      workspaceItem(''),
      workspaceItem('w2'),
      workspaceItem('w1', { title: 'duplicate' }),
    ]),
  })
  assert.deepEqual(workspaceOrderOf(catalog), ['w1', 'w2'])
  assert.deepEqual(workspaceOrderOf(undefined), [])
})

test('an unready workspaces catalog keeps its rows, in order', () => {
  const catalog = openCatalog({
    workspaces: workspacesSnapshot([workspaceItem('w1'), workspaceItem('w2')], { phase: 'pending' }),
  })
  assert.deepEqual(workspaceOrderOf(catalog), ['w1', 'w2'])
  assert.deepEqual(workspaceOrderOf(openCatalog({})), [])
})

test('next and previous follow host order', () => {
  const order = ['a', 'b', 'c']
  assert.equal(nextWorkspaceId(order, 'a'), 'b')
  assert.equal(nextWorkspaceId(order, 'c'), undefined)
  assert.equal(previousWorkspaceId(order, 'c'), 'b')
  assert.equal(previousWorkspaceId(order, 'a'), undefined)
  assert.equal(nextWorkspaceId(order, 'gone'), undefined)
  assert.equal(nextWorkspaceId(undefined, 'a'), undefined)
})

test('the neighbour after a delete is the next row, else the previous one', () => {
  const order = ['a', 'b', 'c']
  assert.equal(neighbourWorkspaceId(order, 'a'), 'b')
  assert.equal(neighbourWorkspaceId(order, 'b'), 'c')
  // Only the last row falls back to the one before it.
  assert.equal(neighbourWorkspaceId(order, 'c'), 'b')
  assert.equal(neighbourWorkspaceId(['a'], 'a'), null)
  assert.equal(neighbourWorkspaceId(order, 'gone'), null)
})

test('delete-success focus goes to the next row, never the previous one', () => {
  const order = ['a', 'b', 'c']
  assert.deepEqual(deleteFocusTarget(order, 'b'), { kind: 'workspace', workspaceId: 'c' })
  // Deleting the last row falls through to the add entry, not to the row above.
  assert.deepEqual(deleteFocusTarget(order, 'c'), { kind: 'add' })
  assert.deepEqual(deleteFocusTarget(['a'], 'a'), { kind: 'add' })
  assert.deepEqual(deleteFocusTarget(undefined, 'a'), { kind: 'add' })
})
