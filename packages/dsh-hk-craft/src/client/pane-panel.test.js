'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createRightbar, readToolEntries } = require('./pane-panel.js')

/** A panel wired to a recording publish, which is all the kernel gives it. */
function withRecorder() {
  const patches = []
  const panel = createRightbar({ publish: (patch) => patches.push(patch) })
  return { panel, patches }
}

test('an unattached panel owns three empty fields', () => {
  const { panel, patches } = withRecorder()

  assert.deepEqual(panel.snapshotPatch(), {
    rightbarAvailable: false,
    rightbarExpanded: false,
    rightbarTools: [],
  })
  assert.deepEqual(patches, [])
  panel.dispose()
})

test('attach reports availability and the service expanded flag', () => {
  const { panel, patches } = withRecorder()
  let expanded = false
  panel.attach({
    isExpanded: () => expanded,
    toggleExpanded() {
      expanded = !expanded
    },
  })

  assert.equal(panel.snapshotPatch().rightbarAvailable, true)
  assert.equal(panel.snapshotPatch().rightbarExpanded, false)
  assert.equal(panel.toggle(), true)
  assert.equal(panel.snapshotPatch().rightbarExpanded, true)
  // Every state change goes through one publish, so the kernel never has to
  // poll the panel to notice.
  assert.equal(patches.length, 2)

  panel.attach(null)
  assert.equal(panel.snapshotPatch().rightbarAvailable, false)
  assert.equal(panel.toggle(), false)
  panel.dispose()
})

test('an isExpanded that throws reads as collapsed instead of failing the publish', () => {
  const { panel } = withRecorder()
  panel.attach({
    isExpanded: () => {
      throw new Error('no surface')
    },
    toggleExpanded() {},
  })

  assert.equal(panel.snapshotPatch().rightbarExpanded, false)
  panel.dispose()
})

test('the tool array keeps its identity while the registry is unchanged', () => {
  // The kernel's change detection compares snapshot fields by identity, so a
  // panel that rebuilt this array on every publish would re-render on every
  // unrelated emit.
  const { panel } = withRecorder()
  let entries = [{ id: 'workspace', providerId: 'files', kind: 'files', title: () => '文件' }]
  panel.attachTabs({
    guide: () => entries,
    subscribe: () => () => {},
  })

  const first = panel.snapshotPatch().rightbarTools
  assert.deepEqual(
    first.map((tool) => [tool.entryId, tool.kind, tool.title]),
    [['workspace', 'files', '文件']],
  )

  panel.attach({ isExpanded: () => false, toggleExpanded() {} })
  assert.equal(panel.snapshotPatch().rightbarTools, first)

  entries = []
  panel.attachTabs({ guide: () => entries, subscribe: () => () => {} })
  assert.notEqual(panel.snapshotPatch().rightbarTools, first)
  assert.deepEqual(panel.snapshotPatch().rightbarTools, [])
  panel.dispose()
})

test('the registry subscription refreshes the tools and dispose unsubscribes', () => {
  const { panel, patches } = withRecorder()
  const listeners = new Set()
  let entries = [{ id: 'workspace', providerId: 'files', kind: 'files', title: () => '文件' }]
  panel.attachTabs({
    guide: () => entries,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })

  entries = [
    { id: 'workspace', providerId: 'files', kind: 'files', title: () => '文件' },
    { id: 'new', providerId: 'terminal', kind: 'terminal', title: () => '终端' },
  ]
  for (const listener of [...listeners]) listener()
  assert.deepEqual(
    panel.snapshotPatch().rightbarTools.map((tool) => tool.kind),
    ['files', 'terminal'],
  )

  const before = patches.length
  panel.dispose()
  assert.equal(listeners.size, 0)
  assert.deepEqual(panel.snapshotPatch(), {
    rightbarAvailable: false,
    rightbarExpanded: false,
    rightbarTools: [],
  })
  // Disposing drops the handle without publishing: the kernel writes the final
  // snapshot itself and must not notify listeners from inside its own teardown.
  assert.equal(patches.length, before)
})

test('openTool needs the service, a non-empty kind and an openTab method', () => {
  const { panel, patches } = withRecorder()
  assert.equal(panel.openTool('files'), false)

  panel.attach({ isExpanded: () => false, toggleExpanded() {} })
  assert.equal(panel.openTool('files'), false)
  assert.equal(panel.openTool(''), false)
  assert.equal(panel.openTool(7), false)

  const opened = []
  panel.attach({
    isExpanded: () => false,
    toggleExpanded() {},
    openTab: (kind) => opened.push(kind),
  })
  const before = patches.length
  assert.equal(panel.openTool('files'), true)
  assert.deepEqual(opened, ['files'])
  assert.equal(patches.length, before + 1)
  panel.dispose()
})

test('a rejected openTab is reported as an error patch', async () => {
  const { panel, patches } = withRecorder()
  panel.attach({
    isExpanded: () => false,
    toggleExpanded() {},
    openTab: () => Promise.reject(new Error('no session surface is mounted')),
  })

  assert.equal(panel.openTool('files'), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(patches.at(-1).error, /no session surface/)
  panel.dispose()
})

test('readToolEntries normalises a registry entry instead of trusting it', () => {
  assert.deepEqual(readToolEntries(null), [])
  assert.deepEqual(readToolEntries({ guide: () => 'nope' }), [])
  assert.deepEqual(
    readToolEntries({
      guide: () => [
        null,
        { kind: '' },
        { kind: 'files' },
        { kind: 'terminal', id: 'new', providerId: 7, title: 'bad' },
      ],
    }),
    [
      { kind: 'files', entryId: 'files', providerId: '', title: 'files', icon: null },
      { kind: 'terminal', entryId: 'new', providerId: '', title: 'terminal', icon: null },
    ],
  )
})

test('a guide that throws yields no tools rather than an error', () => {
  assert.deepEqual(
    readToolEntries({
      guide: () => {
        throw new Error('registry off')
      },
    }),
    [],
  )
})