'use strict'

/**
 * The document listener: capture-phase registration, takeover, and removal.
 * The document is a fake; no DOM implementation is loaded.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { installPaneFileDrop } = require('./pane-file-drop-events.js')

function fakeHost() {
  const records = []
  function track(targetName) {
    return {
      addEventListener(type, fn, capture) {
        records.push({ target: targetName, type, fn, capture: capture === true })
      },
      removeEventListener(type, fn, capture) {
        const captureFlag = capture === true
        const index = records.findIndex(
          (row) => row.target === targetName && row.type === type && row.fn === fn && row.capture === captureFlag,
        )
        if (index !== -1) records.splice(index, 1)
      },
    }
  }
  const document = track('document')
  document.createElement = () => {
    const node = {
      attrs: {},
      textContent: '',
      parentNode: null,
      setAttribute(name, value) {
        this.attrs[name] = String(value)
      },
      getAttribute(name) {
        return this.attrs[name] ?? null
      },
      remove() {
        if (this.parentNode?.overlay === this) this.parentNode.overlay = null
        this.parentNode = null
      },
    }
    return node
  }
  const view = track('window')
  return { document, view, records }
}

function pane(id) {
  const element = {
    attrs: { 'data-hkcraft-pane': id },
    overlay: null,
    setAttribute(name, value) {
      this.attrs[name] = String(value)
    },
    getAttribute(name) {
      return this.attrs[name] ?? null
    },
    removeAttribute(name) {
      delete this.attrs[name]
    },
    appendChild(child) {
      this.overlay = child
      child.parentNode = this
    },
    closest(selector) {
      return selector === '[data-hkcraft-pane]' ? this : null
    },
    querySelector(selector) {
      return selector === 'input[type="file"]' ? this.fileInput ?? null : null
    },
  }
  const child = {
    closest(selector) {
      return element.closest(selector)
    },
  }
  return { element, child }
}

function drag(type, target, extra = {}) {
  return {
    type,
    target,
    relatedTarget: extra.relatedTarget ?? null,
    key: extra.key,
    dataTransfer: {
      types: extra.types ?? ['Files'],
      files: extra.files ?? [],
      items: extra.items ?? [],
      dropEffect: '',
    },
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopImmediatePropagation() {
      this.stopped = true
    },
  }
}

function handler(records, type, target = 'document') {
  const row = records.find((item) => item.type === type && item.target === target)
  if (row === undefined) throw new Error(`missing ${target} listener ${type}`)
  return row
}

const twoPaneSnapshot = {
  layouts: {
    w1: { panes: { p1: { paneId: 'p1', sessionId: 's1' } } },
    w2: { panes: { p2: { paneId: 'p2', sessionId: 's2' } } },
  },
  panes: { p1: { paneId: 'p1', sessionId: 's1' } },
}

function sessionsFor(specs) {
  const calls = []
  return {
    calls,
    list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work' }, s2: { cwd: '/work' } } }) },
    scope(sessionId) {
      const spec = specs[sessionId] ?? {}
      return {
        get(name) {
          if (name === 'conversation') {
            return {
              createDrafts(id, uploads) {
                calls.push({ sessionId: id, uploads })
                return uploads.map((file, index) => ({ id: `d${index}`, file }))
              },
              releaseDraftAttachments() {},
            }
          }
          if (name === 'input') {
            return {
              canPickFiles: () => spec.canPick !== false,
              addFiles: () => true,
            }
          }
          return undefined
        },
      }
    },
  }
}

test('the four file events are captured on document and removed together', () => {
  const host = fakeHost()
  const dispose = installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => twoPaneSnapshot,
    sessions: sessionsFor({}),
    label: (key) => key,
  })

  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    const row = handler(host.records, type)
    assert.equal(row.capture, true, type)
    assert.equal(row.target, 'document')
  }
  assert.equal(handler(host.records, 'keydown').capture, true)
  const dragend = handler(host.records, 'dragend', 'window')
  assert.equal(dragend.capture, false)

  dispose()
  assert.deepEqual(host.records, [])
})

test('a missing document installs nothing', () => {
  const dispose = installPaneFileDrop({ document: undefined, getSnapshot: () => twoPaneSnapshot })
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('a file drag over several panes is taken, and a single pane or a text drag is not', () => {
  const host = fakeHost()
  let snapshot = twoPaneSnapshot
  installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => snapshot,
    sessions: sessionsFor({}),
  })
  const { child } = pane('p1')

  const taken = drag('dragover', child)
  handler(host.records, 'dragover').fn(taken)
  assert.equal(taken.stopped, true)
  assert.equal(taken.defaultPrevented, true)

  snapshot = {
    layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: 's1' } } } },
    panes: { p1: { paneId: 'p1', sessionId: 's1' } },
  }
  const single = drag('dragover', child)
  handler(host.records, 'dragover').fn(single)
  assert.equal(single.stopped, false)
  assert.equal(single.defaultPrevented, false)

  snapshot = twoPaneSnapshot
  const text = drag('dragover', child, { types: ['text/plain'] })
  handler(host.records, 'dragover').fn(text)
  assert.equal(text.stopped, false)
  assert.equal(text.defaultPrevented, false)

  snapshot = {
    layouts: { w1: { panes: { p1: { paneId: 'p1', sessionId: 's1' } } } },
    panes: { p1: { paneId: 'p1', sessionId: 's1' } },
  }
  const nativeDrop = drag('drop', child, { files: [{ name: 'a.txt', type: '' }] })
  handler(host.records, 'drop').fn(nativeDrop)
  assert.equal(nativeDrop.stopped, false)
  assert.equal(nativeDrop.defaultPrevented, false)
})

test('the drop is injected into the pane under the pointer and nowhere else', () => {
  const host = fakeHost()
  const sessions = sessionsFor({ s1: {}, s2: {} })
  installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => twoPaneSnapshot,
    sessions,
    hostPaths: null,
    label: (key) => (key === 'pane.drop.accept' ? '松开以添加文件' : '当前无法添加文件'),
  })
  const first = pane('p1')
  const second = pane('p2')
  const notes = { name: 'notes.txt', type: 'text/plain' }

  const over = drag('dragover', second.child)
  handler(host.records, 'dragover').fn(over)
  assert.equal(second.element.attrs['data-hkcraft-drop'], 'copy')
  assert.equal(second.element.overlay.textContent, '松开以添加文件')
  assert.equal(over.dataTransfer.dropEffect, 'copy')
  assert.equal(first.element.attrs['data-hkcraft-drop'], undefined)

  const dropped = drag('drop', second.child, { files: [notes] })
  handler(host.records, 'drop').fn(dropped)
  assert.equal(dropped.stopped, true)
  assert.deepEqual(sessions.calls, [{ sessionId: 's2', uploads: [notes] }])
  assert.equal(second.element.attrs['data-hkcraft-drop'], undefined)
  assert.equal(second.element.overlay, null)
})

test('a drop on the sidebar, a gap or a creating pane adds no file', () => {
  const host = fakeHost()
  const sessions = sessionsFor({ s1: {} })
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
  installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => snapshot,
    sessions,
    hostPaths: null,
    label: () => '当前无法添加文件',
  })
  const sidebar = { closest: () => null }
  const missed = drag('drop', sidebar, { files: [{ name: 'a.txt', type: '' }] })
  handler(host.records, 'drop').fn(missed)
  assert.equal(missed.stopped, true)
  assert.deepEqual(sessions.calls, [])

  const creating = pane('p2')
  const over = drag('dragover', creating.child)
  handler(host.records, 'dragover').fn(over)
  assert.equal(creating.element.attrs['data-hkcraft-drop'], 'none')
  assert.equal(creating.element.overlay.textContent, '当前无法添加文件')
  assert.equal(over.dataTransfer.dropEffect, 'none')

  const dropped = drag('drop', creating.child, { files: [{ name: 'a.txt', type: '' }] })
  handler(host.records, 'drop').fn(dropped)
  assert.deepEqual(sessions.calls, [])
})

test('a pane that cannot accept files shows the blocked cursor and keeps the draft', () => {
  const host = fakeHost()
  const sessions = sessionsFor({ s1: { canPick: false }, s2: {} })
  installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => twoPaneSnapshot,
    sessions,
    hostPaths: null,
    label: (key) => (key === 'pane.drop.reject' ? '当前无法添加文件' : '松开以添加文件'),
  })
  const blocked = pane('p1')
  const over = drag('dragover', blocked.child)
  handler(host.records, 'dragover').fn(over)
  assert.equal(blocked.element.attrs['data-hkcraft-drop'], 'none')
  assert.equal(blocked.element.overlay.attrs['data-hkcraft-drop-accept'], 'false')
  assert.equal(blocked.element.overlay.textContent, '当前无法添加文件')

  const dropped = drag('drop', blocked.child, { files: [{ name: 'a.txt', type: '' }] })
  handler(host.records, 'drop').fn(dropped)
  assert.deepEqual(sessions.calls, [])
})

test('dragleave, dragend and Escape clear the highlight', () => {
  const host = fakeHost()
  installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => twoPaneSnapshot,
    sessions: sessionsFor({ s1: {}, s2: {} }),
    hostPaths: null,
    label: () => '松开以添加文件',
  })
  const first = pane('p1')
  handler(host.records, 'dragover').fn(drag('dragover', first.child))
  assert.equal(first.element.attrs['data-hkcraft-drop'], 'copy')

  const sidebar = { closest: () => null }
  handler(host.records, 'dragleave').fn(drag('dragleave', first.child, { relatedTarget: sidebar }))
  assert.equal(first.element.attrs['data-hkcraft-drop'], undefined)

  handler(host.records, 'dragover').fn(drag('dragover', first.child))
  handler(host.records, 'dragend', 'window').fn({})
  assert.equal(first.element.attrs['data-hkcraft-drop'], undefined)

  handler(host.records, 'dragover').fn(drag('dragover', first.child))
  handler(host.records, 'keydown').fn({ key: 'Escape' })
  assert.equal(first.element.attrs['data-hkcraft-drop'], undefined)
  handler(host.records, 'dragover').fn(drag('dragover', first.child))
  assert.equal(first.element.attrs['data-hkcraft-drop'], undefined, 'Escape keeps the highlight off until the drag ends')

  handler(host.records, 'dragend', 'window').fn({})
  handler(host.records, 'dragover').fn(drag('dragover', first.child))
  assert.equal(first.element.attrs['data-hkcraft-drop'], 'copy')
})

test('Escape does not swallow a later drag after dragend, and a non-file key is ignored', () => {
  const host = fakeHost()
  const sessions = sessionsFor({ s1: {}, s2: {} })
  installPaneFileDrop({
    document: host.document,
    view: host.view,
    getSnapshot: () => twoPaneSnapshot,
    sessions,
    hostPaths: null,
  })
  const first = pane('p1')
  handler(host.records, 'keydown').fn({ key: 'Escape' })
  handler(host.records, 'dragover').fn(drag('dragover', first.child))
  assert.equal(first.element.attrs['data-hkcraft-drop'], 'copy')

  handler(host.records, 'keydown').fn({ key: 'Escape' })
  const notes = { name: 'notes.txt', type: 'text/plain' }
  handler(host.records, 'drop').fn(drag('drop', first.child, { files: [notes] }))
  assert.deepEqual(sessions.calls, [])
})
