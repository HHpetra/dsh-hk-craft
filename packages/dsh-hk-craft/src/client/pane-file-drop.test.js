'use strict'

/**
 * External behaviour of the drag router: given a drag and a pane snapshot,
 * whether the plugin takes the event, which session it hits, and what it injects.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  isImageMediaType,
  isFileDrag,
  loadedPaneCount,
  routeFileDrag,
  droppedDirectories,
  deliverPaneFiles,
  willAcceptDrop,
} = require('./pane-file-drop.js')

/** @param {string} paneId */
function paneTarget(paneId) {
  const pane = {
    getAttribute(name) {
      return name === 'data-hkcraft-pane' ? paneId : null
    },
    closest(selector) {
      return selector === '[data-hkcraft-pane]' ? pane : null
    },
  }
  return {
    closest(selector) {
      return pane.closest(selector)
    },
  }
}

function missTarget() {
  return {
    closest() {
      return null
    },
  }
}

function fileEvent(target, types = ['Files']) {
  return { target, dataTransfer: { types } }
}

const twoPanes = {
  workspaceId: 'w1',
  layouts: {
    w1: { panes: { p1: { paneId: 'p1', sessionId: 's1' } } },
    w2: { panes: { p2: { paneId: 'p2', sessionId: 's2' } } },
  },
  panes: { p1: { paneId: 'p1', sessionId: 's1' } },
}

const onePane = {
  workspaceId: 'w1',
  layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: 's1' } } } },
  panes: { p1: { paneId: 'p1', sessionId: 's1' } },
}

test('isImageMediaType accepts only the four raster types from 0.2.1-rc.5', () => {
  const rows = [
    ['image/png', true],
    ['image/jpeg', true],
    ['image/webp', true],
    ['image/gif', true],
    ['image/jpg', false],
    ['image/svg+xml', false],
    ['image/bmp', false],
    ['text/plain', false],
    ['', false],
  ]
  for (const [type, expected] of rows) {
    assert.equal(isImageMediaType(type), expected, type)
  }
})

test('a drag is a file drag only when its types include Files', () => {
  const rows = [
    [{ dataTransfer: { types: ['Files'] } }, true],
    [{ dataTransfer: { types: ['text/plain', 'Files'] } }, true],
    [{ dataTransfer: { types: ['text/plain'] } }, false],
    [{ dataTransfer: { types: { contains: (value) => value === 'Files' } } }, true],
    [{ dataTransfer: { types: { contains: () => false } } }, false],
    [{ dataTransfer: { types: null } }, false],
    [{ dataTransfer: null }, false],
    [{}, false],
    [null, false],
  ]
  for (const [event, expected] of rows) {
    assert.equal(isFileDrag(event), expected)
  }
})

test('loaded panes are counted once across the visible tree and every hidden workspace', () => {
  const rows = [
    [twoPanes, 2],
    [onePane, 1],
    [{ workspaceId: null, layouts: {}, panes: { p1: { paneId: 'p1', sessionId: 's1' }, p2: { paneId: 'p2', sessionId: 's2' } } }, 2],
    [{ workspaceId: 'w1', layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: 's1' } } } }, panes: { p1: { paneId: 'p1', sessionId: 's1' } } }, 1],
    [{ layouts: {}, panes: {} }, 0],
    [null, 0],
    [{ layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: '' } } } }, panes: {} }, 1],
  ]
  for (const [snapshot, expected] of rows) {
    assert.equal(loadedPaneCount(snapshot), expected)
  }
})

test('routeFileDrag takes a file drag only when more than one pane is loaded', () => {
  const rows = [
    [fileEvent(paneTarget('p1')), twoPanes, { takeover: true, paneId: 'p1', sessionId: 's1' }],
    [fileEvent(paneTarget('p2')), twoPanes, { takeover: true, paneId: 'p2', sessionId: 's2' }],
    [fileEvent(missTarget()), twoPanes, { takeover: true, paneId: null, sessionId: null }],
    [fileEvent(paneTarget('p9')), twoPanes, { takeover: true, paneId: 'p9', sessionId: null }],
    [fileEvent(paneTarget('p1'), ['text/plain']), twoPanes, { takeover: false, paneId: null, sessionId: null }],
    [fileEvent(paneTarget('p1')), onePane, { takeover: false, paneId: null, sessionId: null }],
    [fileEvent(paneTarget('p1')), { layouts: {}, panes: {} }, { takeover: false, paneId: null, sessionId: null }],
    [fileEvent({ parentElement: paneTarget('p1') }), twoPanes, { takeover: true, paneId: 'p1', sessionId: 's1' }],
  ]
  for (const [event, snapshot, expected] of rows) {
    assert.deepEqual(routeFileDrag(event, snapshot), expected)
  }
})

test('a creating pane is a hit with no session', () => {
  const snapshot = {
    layouts: {
      w1: {
        panes: {
          p1: { paneId: 'p1', sessionId: 's1' },
          p2: { paneId: 'p2', sessionId: '' },
        },
      },
    },
    panes: {},
  }
  assert.deepEqual(routeFileDrag(fileEvent(paneTarget('p2')), snapshot), {
    takeover: true,
    paneId: 'p2',
    sessionId: null,
  })
})

test('droppedDirectories marks only entries the browser reports as directories', () => {
  const file = { name: 'notes.txt' }
  const folder = { name: 'docs' }
  const skipped = { name: 'other' }
  const directories = droppedDirectories(
    {
      items: [
        { kind: 'string' },
        { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: 'file' },
      ],
    },
    [file, folder, skipped],
  )
  assert.equal(directories.has(file), false)
  assert.equal(directories.has(folder), true)
  assert.equal(directories.has(skipped), false)
})

/**
 * @param {Record<string, {canPick?: boolean, add?: boolean, throwAdd?: boolean, missing?: boolean}>} shells
 */
function fakeSessions(shells) {
  const calls = { scope: [], createDrafts: [], addFiles: [], release: [] }
  return {
    calls,
    list: {
      getSnapshot: () => ({
        byId: {
          s1: { cwd: '/work' },
          s2: { cwd: 'C:\\work' },
        },
      }),
    },
    scope(sessionId) {
      calls.scope.push(sessionId)
      const spec = shells[sessionId]
      if (spec == null) return undefined
      if (spec.throwScope === true) throw new Error('scope blew up')
      const conversation = {
        createDrafts(id, uploads) {
          calls.createDrafts.push({ id, uploads })
          if (spec.throwDrafts === true) throw new Error('drafts blew up')
          return uploads.map((file, index) => ({ id: `draft-${index}`, file }))
        },
        releaseDraftAttachments(drafts) {
          calls.release.push(drafts)
        },
      }
      const input = {
        canPickFiles() {
          if (spec.throwPick === true) throw new Error('pick blew up')
          return spec.canPick !== false
        },
        addFiles(references, ids) {
          calls.addFiles.push({ references, ids })
          if (spec.throwAdd === true) throw new Error('add blew up')
          return spec.add !== false
        },
      }
      if (spec.noPick === true) delete input.canPickFiles
      if (spec.noAdd === true) delete input.addFiles
      if (spec.noDrafts === true) delete conversation.createDrafts
      return {
        get(name) {
          if (name === 'conversation') return spec.noConversation === true ? undefined : conversation
          if (name === 'input') return spec.noInput === true ? undefined : input
          return undefined
        },
      }
    },
  }
}

function file(name, type = '') {
  return { name, type }
}

test('a path-less file becomes a draft upload on the hit session', () => {
  const sessions = fakeSessions({ s1: {} })
  const notes = file('notes.txt', 'text/plain')
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [notes],
    directories: new Set(),
    hostPaths: null,
  })
  assert.equal(result.outcome, 'added')
  assert.deepEqual(sessions.calls.scope, ['s1'])
  assert.deepEqual(sessions.calls.createDrafts, [{ id: 's1', uploads: [notes] }])
  assert.deepEqual(sessions.calls.addFiles, [{ references: [], ids: ['draft-0'] }])
  assert.deepEqual(result.references, [])
})

test('a pathful image stays a draft and a pathful non-image becomes a reference chip', () => {
  const sessions = fakeSessions({ s1: {} })
  const image = file('pic.png', 'image/png')
  const notes = file('notes.txt', 'text/plain')
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [image, notes],
    directories: new Set(),
    hostPaths: {
      pathFor(item) {
        return item === image ? '/work/pic.png' : '/work/notes.txt'
      },
    },
  })
  assert.equal(result.outcome, 'added')
  assert.deepEqual(sessions.calls.createDrafts[0].uploads, [image])
  assert.deepEqual(result.references, [
    {
      source: 'reference',
      ref: '@notes.txt',
      label: 'notes.txt',
      appearance: 'file',
      clipboardText: '@notes.txt',
    },
  ])
  assert.deepEqual(sessions.calls.addFiles[0].ids, ['draft-0'])
})

test('a directory becomes a folder chip and several files keep drop order', () => {
  const sessions = fakeSessions({ s1: {} })
  const image = file('pic.png', 'image/png')
  const notes = file('my notes.txt', 'text/plain')
  const folder = file('我的 目录', '')
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [image, notes, folder],
    directories: new Set([folder]),
    hostPaths: {
      pathFor(item) {
        if (item === image) return '/work/pic.png'
        if (item === notes) return '/work/my notes.txt'
        return '/work/我的 目录'
      },
    },
  })
  assert.equal(result.outcome, 'added')
  assert.deepEqual(sessions.calls.createDrafts[0].uploads, [image])
  assert.deepEqual(
    result.references.map((chip) => chip.ref),
    ['@"my notes.txt"', '@"我的 目录/"'],
  )
  assert.deepEqual(
    result.references.map((chip) => chip.appearance),
    ['file', 'folder'],
  )
  assert.equal(result.references[1].label, '我的 目录/')
})

test('a Windows path is relativized against that session cwd', () => {
  const sessions = fakeSessions({ s2: {} })
  const notes = file('result.pdf', 'application/pdf')
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's2',
    files: [notes],
    directories: new Set(),
    hostPaths: { pathFor: () => 'C:\\work\\reports\\result.pdf' },
  })
  assert.equal(result.outcome, 'added')
  assert.equal(result.references[0].ref, '@reports\\result.pdf')
  assert.equal(result.references[0].label, 'result.pdf')
})

test('the host path bridge on globalThis is used when the caller does not pass one', () => {
  const previous = globalThis.__DSH_HOST_PATHS__
  globalThis.__DSH_HOST_PATHS__ = { pathFor: () => '/work/notes.txt' }
  try {
    const sessions = fakeSessions({ s1: {} })
    const result = deliverPaneFiles({
      sessions,
      sessionId: 's1',
      files: [file('notes.txt')],
      directories: new Set(),
    })
    assert.equal(result.outcome, 'added')
    assert.equal(result.references[0].ref, '@notes.txt')
    assert.deepEqual(sessions.calls.createDrafts[0].uploads, [])
  } finally {
    if (previous === undefined) delete globalThis.__DSH_HOST_PATHS__
    else globalThis.__DSH_HOST_PATHS__ = previous
  }
})

test('addFiles returning false releases the drafts and adds nothing else', () => {
  const sessions = fakeSessions({ s1: { add: false } })
  const notes = file('notes.txt')
  const placed = []
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [notes],
    directories: new Set(),
    hostPaths: null,
    paneRoot: {
      querySelector: () => ({ disabled: false }),
    },
    placeFiles(input, files) {
      placed.push({ input, files })
      return true
    },
  })
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.reason, 'refused')
  assert.equal(sessions.calls.release.length, 1)
  assert.equal(sessions.calls.release[0][0].file, notes)
  assert.deepEqual(placed, [])
})

test('canPickFiles false rejects the drop before any draft exists', () => {
  const sessions = fakeSessions({ s1: { canPick: false } })
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [file('notes.txt')],
    directories: new Set(),
    hostPaths: null,
  })
  assert.deepEqual(result, { outcome: 'rejected', reason: 'busy' })
  assert.deepEqual(sessions.calls.createDrafts, [])
  assert.equal(willAcceptDrop(sessions, 's1', null, undefined, null), false)
})

test('a directory without a host path bridge rejects the whole batch', () => {
  const sessions = fakeSessions({ s1: {} })
  const notes = file('notes.txt')
  const folder = file('docs')
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [notes, folder],
    directories: new Set([folder]),
    hostPaths: null,
  })
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.reason, 'directory')
  assert.deepEqual(sessions.calls.createDrafts, [])
})

test('a path the mention grammar refuses rejects the batch', () => {
  const sessions = fakeSessions({ s1: {} })
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [file('bad.txt')],
    directories: new Set(),
    hostPaths: { pathFor: () => '/work/bad"name.txt' },
  })
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.reason, 'mention')
  assert.deepEqual(sessions.calls.createDrafts, [])
})

test('a missing scope falls back to the hidden file input and skips directories', () => {
  const sessions = fakeSessions({})
  const notes = file('notes.txt')
  const folder = file('docs')
  const input = { disabled: false, files: null }
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [notes, folder],
    directories: new Set([folder]),
    hostPaths: null,
    paneRoot: {
      querySelector(selector) {
        return selector === 'input[type="file"]' ? input : null
      },
    },
    placeFiles(target, files) {
      target.files = files
      return true
    },
  })
  assert.equal(result.outcome, 'input')
  assert.deepEqual(result.files, [notes])
  assert.deepEqual(input.files, [notes])
  assert.deepEqual(sessions.calls.createDrafts, [])
})

test('a thrown scope service falls back to the file input', () => {
  const sessions = fakeSessions({ s1: { throwScope: true } })
  const notes = file('notes.txt')
  let placed = 0
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [notes],
    directories: new Set(),
    hostPaths: null,
    paneRoot: { querySelector: () => ({ disabled: false }) },
    placeFiles() {
      placed += 1
      return true
    },
  })
  assert.equal(result.outcome, 'input')
  assert.equal(placed, 1)
})

test('addFiles throwing releases drafts and then tries the file input', () => {
  const sessions = fakeSessions({ s1: { throwAdd: true } })
  const notes = file('notes.txt')
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [notes],
    directories: new Set(),
    hostPaths: null,
    paneRoot: { querySelector: () => ({ disabled: false }) },
    placeFiles() {
      return true
    },
  })
  assert.equal(result.outcome, 'input')
  assert.equal(sessions.calls.release.length, 1)
})

test('a missing file input discards the drop when the scope services are absent', () => {
  const sessions = fakeSessions({})
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [file('notes.txt')],
    directories: new Set(),
    hostPaths: null,
    paneRoot: { querySelector: () => null },
    placeFiles() {
      throw new Error('should not place')
    },
  })
  assert.deepEqual(result, { outcome: 'discarded' })
})

test('a disabled file input discards the fallback', () => {
  const sessions = fakeSessions({})
  const result = deliverPaneFiles({
    sessions,
    sessionId: 's1',
    files: [file('notes.txt')],
    directories: new Set(),
    hostPaths: null,
    paneRoot: { querySelector: () => ({ disabled: true }) },
    placeFiles() {
      return true
    },
  })
  assert.deepEqual(result, { outcome: 'discarded' })
})

test('a creating pane cannot accept a drop', () => {
  const sessions = fakeSessions({ s1: {} })
  assert.equal(willAcceptDrop(sessions, null, { querySelector: () => ({ disabled: false }) }, undefined, null), false)
  assert.equal(willAcceptDrop(sessions, '', null, undefined, null), false)
})

test('a directory drag is acceptable only when a path bridge exists', () => {
  const sessions = fakeSessions({ s1: {} })
  const directory = { items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] }
  assert.equal(willAcceptDrop(sessions, 's1', null, directory, null), false)
  assert.equal(
    willAcceptDrop(sessions, 's1', null, directory, { pathFor: () => '/work/docs' }),
    true,
  )
  assert.equal(willAcceptDrop(sessions, 's1', null, { items: [] }, null), true)
})

test('the default file-input fallback assigns files and fires change', () => {
  const previousTransfer = globalThis.DataTransfer
  const notes = file('notes.txt')
  const input = {
    disabled: false,
    files: null,
    events: [],
    dispatchEvent(event) {
      this.events.push(event)
    },
  }
  globalThis.DataTransfer = class {
    constructor() {
      const files = []
      this.files = files
      this.items = { add: (item) => files.push(item) }
    }
  }
  try {
    const sessions = fakeSessions({})
    const result = deliverPaneFiles({
      sessions,
      sessionId: 's1',
      files: [notes],
      directories: new Set(),
      hostPaths: null,
      paneRoot: { querySelector: () => input },
    })
    assert.equal(result.outcome, 'input')
    assert.deepEqual(input.files, [notes])
    assert.equal(input.events.length, 1)
    assert.equal(input.events[0].type, 'change')
    assert.equal(input.events[0].bubbles, true)
  } finally {
    if (previousTransfer === undefined) delete globalThis.DataTransfer
    else globalThis.DataTransfer = previousTransfer
  }
})

test('an empty drop is ignored', () => {
  const sessions = fakeSessions({ s1: {} })
  assert.deepEqual(deliverPaneFiles({ sessions, sessionId: 's1', files: [], hostPaths: null }), {
    outcome: 'ignored',
  })
  assert.deepEqual(sessions.calls.scope, [])
})
