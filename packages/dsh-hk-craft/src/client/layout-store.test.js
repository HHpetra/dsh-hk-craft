'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LAYOUT_KEY_PREFIX,
  LAYOUT_PAYLOAD_VERSION,
  layoutKey,
  emptyLayout,
  encodeLayout,
  decodeLayout,
  hasLayoutKey,
  readLayout,
  writeLayout,
  removeLayout,
} = require('./layout-store.js')
const {
  LAYOUT_VERSION,
  createLayout,
  openPane,
  split,
  resize,
  setView,
  leaves,
} = require('./layout-tree.js')

/** @param {string} paneId @param {string} sessionId @param {string} [view] */
function pane(paneId, sessionId, view = 'chat') {
  return { paneId, sessionId, view }
}

/** One workspace layout with three panes: row(col(p1, p3), p2). */
function threePaneLayout() {
  const one = openPane(createLayout('w1'), pane('p1', 's1'))
  const two = split(one, 'p1', 'row', pane('p2', 's2'))
  const three = split(two, 'p1', 'col', pane('p3', 's3'))
  return resize(setView(three, 'p2', 'trajectory'), ['a'], 0.65)
}

/** A payload as it would arrive from storage, before any cleanup. */
function payload(overrides = {}) {
  return { version: LAYOUT_PAYLOAD_VERSION, root: null, panes: {}, activePaneId: null, ...overrides }
}

const EMPTY = {
  version: LAYOUT_VERSION,
  workspaceId: 'w1',
  root: null,
  panes: {},
  activePaneId: null,
}

/** @param {string | null} [raw] */
function fakeStorage(raw) {
  const writes = []
  return {
    writes,
    getItem(key) {
      return typeof raw === 'function' ? raw(key) : (raw ?? null)
    },
    setItem(key, value) {
      writes.push([key, value])
    },
  }
}

function thrownStorage(error) {
  return {
    getItem() {
      throw error
    },
    setItem() {
      throw error
    },
  }
}

// ---------------------------------------------------------------------------
// Storage keys: workspace-scoped, never shared
// ---------------------------------------------------------------------------

test('storage keys carry the payload version and the workspace id', () => {
  assert.equal(LAYOUT_KEY_PREFIX, 'dsh.hkcraft.layout.v1.')
  assert.equal(layoutKey('w1'), 'dsh.hkcraft.layout.v1.w1')
  assert.notEqual(layoutKey('w1'), layoutKey('w2'))
  assert.equal(layoutKey(''), null)
  assert.equal(layoutKey(undefined), null)
  assert.equal(layoutKey(null), null)
  assert.equal(layoutKey(42), null)
})

test('an empty layout is the workspace empty state', () => {
  assert.deepEqual(emptyLayout('w1'), EMPTY)
  assert.equal(emptyLayout('w1').root, null)
})

// ---------------------------------------------------------------------------
// Encoding: whole layout, stable payload shape
// ---------------------------------------------------------------------------

test('encoding keeps the tree, ratios, focus, per-pane session and view', () => {
  const layout = threePaneLayout()
  const raw = encodeLayout(layout)
  assert.equal(typeof raw, 'string')

  const parsed = JSON.parse(raw)
  assert.deepEqual(Object.keys(parsed).sort(), ['activePaneId', 'panes', 'root', 'version'])
  assert.equal(parsed.version, LAYOUT_VERSION)
  assert.deepEqual(parsed.root, layout.root)
  assert.equal(parsed.root.a.ratio, 0.65)
  assert.deepEqual(parsed.panes.p2, { paneId: 'p2', sessionId: 's2', view: 'trajectory' })
  assert.equal(parsed.activePaneId, 'p3')
})

test('encode refuses a non-layout instead of emitting garbage', () => {
  assert.equal(encodeLayout(null), null)
  assert.equal(encodeLayout(undefined), null)
  assert.equal(encodeLayout('layout'), null)
})

// ---------------------------------------------------------------------------
// Decoding: round-trip and version gating
// ---------------------------------------------------------------------------

test('a whole layout survives encode and decode', () => {
  const layout = threePaneLayout()
  const restored = decodeLayout(encodeLayout(layout), { workspaceId: 'w1' })

  assert.deepEqual(restored, layout)
})

test('decode labels the layout with the workspace from the key, not the payload', () => {
  const restored = decodeLayout(
    JSON.stringify(payload({ workspaceId: 'someone-else', activePaneId: null })),
    { workspaceId: 'w2' },
  )
  assert.equal(restored.workspaceId, 'w2')
})

test('a payload version mismatch decodes to the safe empty layout', () => {
  const layout = threePaneLayout()
  const newer = { ...JSON.parse(encodeLayout(layout)), version: LAYOUT_VERSION + 1 }
  assert.deepEqual(decodeLayout(JSON.stringify(newer), { workspaceId: 'w1' }), EMPTY)

  const unversioned = { ...JSON.parse(encodeLayout(layout)) }
  delete unversioned.version
  assert.deepEqual(decodeLayout(JSON.stringify(unversioned), { workspaceId: 'w1' }), EMPTY)

  const stringy = { ...JSON.parse(encodeLayout(layout)), version: String(LAYOUT_VERSION) }
  assert.deepEqual(decodeLayout(JSON.stringify(stringy), { workspaceId: 'w1' }), EMPTY)
})

test('corrupt payloads decode to the safe empty layout and never throw', () => {
  for (const raw of ['{', 'null', '[]', '42', '"layout"', '', null, undefined, '{"version":1,"root":[]}']) {
    assert.deepEqual(decodeLayout(raw, { workspaceId: 'w1' }), EMPTY, `raw=${String(raw)}`)
  }
})

test('missing fields decode to the safe empty layout', () => {
  assert.deepEqual(decodeLayout('{"version":1}', { workspaceId: 'w1' }), EMPTY)
  // A leaf with no pane record is pruned, so the tree becomes empty too.
  assert.deepEqual(
    decodeLayout(
      JSON.stringify({ version: 1, root: { kind: 'leaf', paneId: 'p1' }, panes: {}, activePaneId: 'p1' }),
      { workspaceId: 'w1' },
    ),
    EMPTY,
  )
  // Orphan pane records with no root are dropped.
  assert.deepEqual(
    decodeLayout(
      JSON.stringify({
        version: 1,
        root: null,
        panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'chat' } },
        activePaneId: 'p1',
      }),
      { workspaceId: 'w1' },
    ),
    EMPTY,
  )
})

// ---------------------------------------------------------------------------
// Reconciling against the live session catalog
// ---------------------------------------------------------------------------

test('panes whose session no longer exists are dropped and the tree is normalised', () => {
  const layout = threePaneLayout()
  const restored = decodeLayout(encodeLayout(layout), {
    workspaceId: 'w1',
    knownSessionIds: new Set(['s1', 's3']),
  })

  assert.deepEqual(leaves(restored.root), ['p1', 'p3'])
  assert.deepEqual(Object.keys(restored.panes).sort(), ['p1', 'p3'])
  // The focus was on a surviving pane, so it stays there.
  assert.equal(restored.activePaneId, 'p3')

  const focusedOnStale = decodeLayout(
    JSON.stringify({
      version: LAYOUT_PAYLOAD_VERSION,
      root: { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'leaf', paneId: 'p1' }, b: { kind: 'leaf', paneId: 'p2' } },
      panes: {
        p1: { paneId: 'p1', sessionId: 's1', view: 'chat' },
        p2: { paneId: 'p2', sessionId: 'gone', view: 'chat' },
      },
      activePaneId: 'p2',
    }),
    { workspaceId: 'w1', knownSessionIds: new Set(['s1']) },
  )
  assert.equal(focusedOnStale.activePaneId, 'p1')
})

test('a layout whose panes are all stale decodes to the empty state', () => {
  const layout = threePaneLayout()
  const restored = decodeLayout(encodeLayout(layout), { workspaceId: 'w1', knownSessionIds: new Set() })

  assert.deepEqual(restored, EMPTY)
})

test('an unknown session catalog keeps every pane instead of guessing', () => {
  const layout = threePaneLayout()
  assert.deepEqual(decodeLayout(encodeLayout(layout), { workspaceId: 'w1' }), layout)
  assert.deepEqual(
    decodeLayout(encodeLayout(layout), { workspaceId: 'w1', knownSessionIds: null }),
    layout,
  )
})

test('duplicate pane ids in one tree collapse to the first occurrence', () => {
  const restored = decodeLayout(
    JSON.stringify(
      payload({
        root: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', paneId: 'p1' },
          b: { kind: 'leaf', paneId: 'p1' },
        },
        panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'chat' } },
        activePaneId: 'p1',
      }),
    ),
    { workspaceId: 'w1' },
  )

  assert.deepEqual(restored.root, { kind: 'leaf', paneId: 'p1' })
  assert.deepEqual(leaves(restored.root), ['p1'])
  assert.deepEqual(Object.keys(restored.panes), ['p1'])
})

test('a session mounted in two panes keeps only its first pane', () => {
  const restored = decodeLayout(
    JSON.stringify(
      payload({
        root: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', paneId: 'p1' },
          b: { kind: 'leaf', paneId: 'p2' },
        },
        panes: {
          p1: { paneId: 'p1', sessionId: 's1', view: 'chat' },
          p2: { paneId: 'p2', sessionId: 's1', view: 'trajectory' },
        },
        activePaneId: 'p2',
      }),
    ),
    { workspaceId: 'w1' },
  )

  assert.deepEqual(leaves(restored.root), ['p1'])
  assert.deepEqual(Object.keys(restored.panes), ['p1'])
  assert.equal(restored.activePaneId, 'p1')
})

// ---------------------------------------------------------------------------
// Field-level repair
// ---------------------------------------------------------------------------

test('out-of-range ratios are clamped and unknown split directions become rows', () => {
  const restored = decodeLayout(
    JSON.stringify(
      payload({
        root: {
          kind: 'split',
          dir: 'diagonal',
          ratio: 42,
          a: { kind: 'leaf', paneId: 'p1' },
          b: {
            kind: 'split',
            dir: 'col',
            ratio: -3,
            a: { kind: 'leaf', paneId: 'p2' },
            b: { kind: 'leaf', paneId: 'p3' },
          },
        },
        panes: {
          p1: { paneId: 'p1', sessionId: 's1' },
          p2: { paneId: 'p2', sessionId: 's2' },
          p3: { paneId: 'p3', sessionId: 's3' },
        },
        activePaneId: 'p3',
      }),
    ),
    { workspaceId: 'w1' },
  )

  assert.equal(restored.root.dir, 'row')
  assert.equal(restored.root.ratio, 0.9)
  assert.equal(restored.root.b.dir, 'col')
  assert.equal(restored.root.b.ratio, 0.1)
  assert.equal(restored.activePaneId, 'p3')
})

test('pane records are rebuilt from their keys and unknown fields are ignored', () => {
  const restored = decodeLayout(
    JSON.stringify(
      payload({
        root: { kind: 'leaf', paneId: 'p1' },
        panes: {
          p1: { sessionId: 's1', view: 'trajectory', stale: true, paneId: 'not-p1' },
        },
        activePaneId: 'p1',
      }),
    ),
    { workspaceId: 'w1' },
  )

  assert.deepEqual(restored.panes, { p1: { paneId: 'p1', sessionId: 's1', view: 'trajectory' } })
})

test('an unknown view falls back to chat and a stale focus moves to the first leaf', () => {
  const restored = decodeLayout(
    JSON.stringify(
      payload({
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { paneId: 'p1', sessionId: 's1', view: 'timeline' } },
        activePaneId: 'ghost',
      }),
    ),
    { workspaceId: 'w1' },
  )

  assert.equal(restored.panes.p1.view, 'chat')
  assert.equal(restored.activePaneId, 'p1')
})

// ---------------------------------------------------------------------------
// Storage adapters: scoped read/write, never throw
// ---------------------------------------------------------------------------

test('reading uses this workspace key only', () => {
  const layout = threePaneLayout()
  const storage = fakeStorage((key) => (key === layoutKey('w1') ? encodeLayout(layout) : null))

  assert.deepEqual(readLayout(storage, 'w1'), layout)
  assert.deepEqual(readLayout(storage, 'w2'), emptyLayout('w2'))
})

test('reading a missing or corrupt key is the empty layout, and a throwing store is caught', () => {
  assert.deepEqual(readLayout(fakeStorage(null), 'w1'), EMPTY)
  assert.deepEqual(readLayout(fakeStorage('{'), 'w1'), EMPTY)
  assert.deepEqual(readLayout(thrownStorage(new Error('security error')), 'w1'), EMPTY)
  assert.deepEqual(readLayout(undefined, 'w1'), EMPTY)
})

test('writing targets the layout workspace and round-trips', () => {
  const layout = threePaneLayout()
  const storage = fakeStorage(null)

  assert.equal(writeLayout(storage, layout), true)
  assert.equal(storage.writes.length, 1)
  assert.equal(storage.writes[0][0], layoutKey('w1'))
  assert.deepEqual(readLayout(fakeStorage(storage.writes[0][1]), 'w1'), layout)
})

test('writing without a workspace id writes nothing; a failing store is a silent false', () => {
  const unwritable = fakeStorage(null)
  assert.equal(writeLayout(unwritable, createLayout(null)), false)
  assert.equal(unwritable.writes.length, 0)
  assert.equal(writeLayout(thrownStorage(new Error('quota')), threePaneLayout()), false)
  assert.equal(writeLayout(undefined, threePaneLayout()), false)
})

test('clearing one workspace layout removes only its key and never throws', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  const w1 = threePaneLayout()
  const w2 = openPane(createLayout('w2'), pane('p9', 's9'))
  writeLayout(storage, w1)
  writeLayout(storage, w2)

  assert.equal(removeLayout(storage, 'w1'), true)
  assert.equal(storage.getItem(layoutKey('w1')), null)
  assert.deepEqual(readLayout(storage, 'w2'), w2)
  // Removing a key that is already gone is still a successful cleanup.
  assert.equal(removeLayout(storage, 'w1'), true)
  assert.equal(removeLayout(storage, 'w2'), true)
  assert.equal(store.size, 0)
})

test('clearing is a safe false without a workspace, a store or removeItem', () => {
  assert.equal(removeLayout(undefined, 'w1'), false)
  assert.equal(removeLayout(null, 'w1'), false)
  assert.equal(removeLayout(fakeStorage(null), 'w1'), false)
  assert.equal(removeLayout({ getItem: () => null }, 'w1'), false)
  assert.equal(removeLayout(fakeStorage(null), ''), false)
  assert.equal(removeLayout(fakeStorage(null), null), false)

  const throwing = {
    removeItem() {
      throw new Error('security error')
    },
  }
  assert.equal(removeLayout(throwing, 'w1'), false)
})

// ---------------------------------------------------------------------------
// Key existence: "has this workspace ever been opened in split?"
// ---------------------------------------------------------------------------

test('a stored key exists even when its payload is empty or corrupt', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  }

  assert.equal(hasLayoutKey(storage, 'w1'), false, 'nothing written yet')
  assert.equal(hasLayoutKey(storage, 'w2'), false, 'nothing written yet')

  // Existence is the fact, not parseability: a stale or corrupt value still proves
  // the workspace was opened in split at some point.
  store.set(layoutKey('w1'), '')
  store.set(layoutKey('w2'), '{not json')
  assert.equal(hasLayoutKey(storage, 'w1'), true)
  assert.equal(hasLayoutKey(storage, 'w2'), true)
})

test('an absent, throwing or invalid-id store reports no key instead of throwing', () => {
  assert.equal(hasLayoutKey(undefined, 'w1'), false)
  assert.equal(hasLayoutKey({}, 'w1'), false)
  assert.equal(hasLayoutKey(thrownStorage(new Error('security error')), 'w1'), false)
  assert.equal(hasLayoutKey(fakeStorage(null), ''), false)
  assert.equal(hasLayoutKey(fakeStorage(null), undefined), false)
  assert.equal(hasLayoutKey(fakeStorage(null), null), false)
})

test('writing a layout key makes the existence check agree with readLayout', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  }
  const layout = threePaneLayout()

  assert.equal(hasLayoutKey(storage, 'w1'), false)
  assert.deepEqual(readLayout(storage, 'w1'), emptyLayout('w1'))
  writeLayout(storage, layout)
  assert.equal(hasLayoutKey(storage, 'w1'), true)
  assert.deepEqual(readLayout(storage, 'w1'), layout)
})

test('two workspaces persist under separate keys without overwriting each other', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  }
  const w1 = threePaneLayout()
  const w2 = openPane(createLayout('w2'), pane('p9', 's9'))

  writeLayout(storage, w1)
  writeLayout(storage, w2)

  assert.deepEqual(readLayout(storage, 'w1'), w1)
  assert.deepEqual(readLayout(storage, 'w2'), w2)
  assert.equal(store.size, 2)
})
