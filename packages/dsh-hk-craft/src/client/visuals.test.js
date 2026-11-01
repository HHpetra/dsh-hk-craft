'use strict'

/**
 * The visual layer's contract with a document: one idempotent, removable
 * stylesheet. The sheet's content is checked for the scoped markers and the
 * reduced-motion fallback; its exact declarations are design review material,
 * not a unit-test target.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  STYLE_ELEMENT_ID,
  PLUGIN_STYLESHEET,
  installPluginStyles,
} = require('./visuals.js')

/** A document-shaped stub with just enough DOM for the installer. */
function fakeDocument() {
  const children = []
  const head = {
    appendChild(node) {
      children.push(node)
      node.parentNode = head
      return node
    },
    removeChild(node) {
      const index = children.indexOf(node)
      if (index !== -1) children.splice(index, 1)
      return node
    },
  }
  const document = {
    head,
    createElement(tag) {
      return {
        tag,
        id: '',
        textContent: '',
        attributes: {},
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        remove() {
          this.parentNode?.removeChild?.(this)
        },
      }
    },
    getElementById(id) {
      return children.find((node) => node.id === id) ?? null
    },
  }
  return { document, children }
}

test('the stylesheet is scoped to this plugin and keeps a reduced-motion path', () => {
  assert.ok(PLUGIN_STYLESHEET.includes('[data-hkcraft-workspace-row]'))
  assert.ok(PLUGIN_STYLESHEET.includes('[data-hkcraft-strip-item]'))
  assert.ok(PLUGIN_STYLESHEET.includes('[data-hkcraft-pane]'))
  assert.ok(PLUGIN_STYLESHEET.includes('[data-hkcraft="settings"]'))
  assert.ok(PLUGIN_STYLESHEET.includes('[data-hkcraft-subagent-menu]'))
  assert.ok(PLUGIN_STYLESHEET.includes('@media (prefers-reduced-motion: reduce)'))
  // A bare `body` or `*` rule would escape the plugin's surfaces and restyle
  // the shell; every selector must carry one of our markers.
  assert.equal(/(^|\n)\s*(body|html|\*)\s*\{/u.test(PLUGIN_STYLESHEET), false)
})

test('installing appends one style element with the documented id', () => {
  const { document, children } = fakeDocument()
  const dispose = installPluginStyles(document)

  assert.equal(children.length, 1)
  const style = children[0]
  assert.equal(style.tag, 'style')
  assert.equal(style.id, STYLE_ELEMENT_ID)
  assert.equal(style.attributes['data-hkcraft-styles'], '')
  assert.equal(style.textContent, PLUGIN_STYLESHEET)

  dispose()
  assert.equal(children.length, 0)
})

test('installing twice never stacks a second sheet', () => {
  const { document, children } = fakeDocument()
  const disposeFirst = installPluginStyles(document)
  const disposeSecond = installPluginStyles(document)

  assert.equal(children.length, 1)
  disposeSecond()
  assert.equal(children.length, 1, 'the second installer did not own the sheet')
  disposeFirst()
  assert.equal(children.length, 0)
})

test('a sheet left behind by another instance is adopted, not duplicated', () => {
  const { document, children } = fakeDocument()
  const disposeFirst = installPluginStyles(document)
  assert.equal(children.length, 1)

  // Simulate a reload that did not run the first disposer.
  const disposeSecond = installPluginStyles(document)
  assert.equal(children.length, 1)
  disposeSecond()
  assert.equal(children.length, 1)

  disposeFirst()
  assert.equal(children.length, 0)
})

test('a missing document is a harmless no-op', () => {
  assert.equal(typeof installPluginStyles(undefined), 'function')
  assert.doesNotThrow(() => installPluginStyles(undefined)())
  assert.doesNotThrow(() => installPluginStyles(null)())
  assert.doesNotThrow(() => installPluginStyles({})())
})