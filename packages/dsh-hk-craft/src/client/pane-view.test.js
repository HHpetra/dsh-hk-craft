'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { workspaceGroups } = require('./pane-view.js')

/** @param {string} paneId @param {string} sessionId */
function pane(paneId, sessionId) {
  return { paneId, sessionId, view: 'chat' }
}

test('every loaded workspace is rendered, exactly one of them visible', () => {
  const state = {
    workspaceId: 'w2',
    layouts: {
      w1: { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: pane('p1', 's1') }, activePaneId: 'p1' },
      w2: { root: { kind: 'leaf', paneId: 'p2' }, panes: { p2: pane('p2', 's2') }, activePaneId: 'p2' },
    },
    root: { kind: 'leaf', paneId: 'p2' },
    panes: { p2: pane('p2', 's2') },
    activePaneId: 'p2',
  }

  const groups = workspaceGroups(state)

  assert.deepEqual(groups.map((group) => group.workspaceId), ['w1', 'w2'])
  assert.deepEqual(groups.map((group) => group.visible), [false, true])
  assert.deepEqual(groups[0].layout, state.layouts.w1)
})

test('the unscoped layout renders when there is no workspace map', () => {
  const state = {
    workspaceId: null,
    layouts: {},
    root: { kind: 'leaf', paneId: 'p1' },
    panes: { p1: pane('p1', 's1') },
    activePaneId: 'p1',
  }

  const groups = workspaceGroups(state)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].workspaceId, null)
  assert.equal(groups[0].visible, true)
  assert.deepEqual(groups[0].layout.root, state.root)
})

test('an empty active workspace still renders its empty state group', () => {
  const state = {
    workspaceId: 'w1',
    layouts: {
      w1: { root: null, panes: {}, activePaneId: null },
      w2: { root: { kind: 'leaf', paneId: 'p2' }, panes: { p2: pane('p2', 's2') }, activePaneId: 'p2' },
    },
    root: null,
    panes: {},
    activePaneId: null,
  }

  const groups = workspaceGroups(state)

  assert.deepEqual(groups.map((group) => group.workspaceId), ['w1', 'w2'])
  assert.equal(groups[0].visible, true)
  assert.equal(groups[0].layout.root, null)
})

test('a missing active workspace falls back to the first rendered group', () => {
  const state = {
    workspaceId: 'gone',
    layouts: {
      w1: { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: pane('p1', 's1') }, activePaneId: 'p1' },
    },
    root: null,
    panes: {},
    activePaneId: null,
  }

  const groups = workspaceGroups(state)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].visible, true)
})
