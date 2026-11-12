'use strict'

/**
 * The close confirmation for a running pane.
 *
 * These tests render the dialog directly with the same React stand-in the other
 * view tests use and assert what a user can observe: the modal contract, the
 * three exits (cancel / interrupt-and-close / close anyway), and the escape
 * hatches that keep a refused interrupt from trapping the UI (ADR-0021).
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { withFakeReact } = require('./fake-react.js')

const { PaneCloseConfirm } = require('./pane-close-confirm.js')
const { interpolate } = require('./react-and-translator.js')
const { zh } = require('./locale.js')

/** Localized copy with translator params, the way the real slot `t` behaves. */
const t = (key, params) => interpolate(zh[key] ?? key, params)

/**
 * A React stand-in covering the calls the dialog makes. It carries the full hook
 * set because Node runs every test file in one process and the first lazy load
 * wins the shared cache.
 */
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Flatten the children arrays a fake element carries into one list. */
function childrenOf(element) {
  return (element?.props?.children ?? []).filter(
    (child) => child !== null && child !== undefined && typeof child === 'object',
  )
}

/** Every element below `element`, depth first. */
function descendants(element) {
  return childrenOf(element).flatMap((child) => [child, ...descendants(child)])
}

/** The first element below `element` matching `predicate`. */
function find(element, predicate) {
  if (element === null || element === undefined || typeof element !== 'object') return null
  if (predicate(element)) return element
  for (const child of childrenOf(element)) {
    const found = find(child, predicate)
    if (found !== null) return found
  }
  return null
}

/** The text a button renders, flattened. */
function textOf(element) {
  return (element?.props?.children ?? [])
    .flat(Infinity)
    .filter((child) => child !== null && child !== undefined)
    .join('')
}

/** Render the dialog over one controller snapshot, recording the actions it calls. */
function renderDialog(overrides = {}) {
  const calls = { cancel: 0, confirm: 0, force: 0 }
  const state = {
    pendingClose: { paneId: 'p1', sessionId: 's1', title: 'One' },
    closeBusy: false,
    closeError: null,
    ...overrides,
  }
  const controller = {
    subscribe: () => () => {},
    getSnapshot: () => state,
    close: {
      cancel: () => {
        calls.cancel += 1
        return true
      },
      confirm: () => {
        calls.confirm += 1
        return Promise.resolve(true)
      },
      force: () => {
        calls.force += 1
        return true
      },
    },
  }
  const view = PaneCloseConfirm({ controller, t })
  return { view, calls, state }
}

/** The overlay (the element carrying the dialog marker's parent) is the backdrop. */
function backdropOf(view) {
  return find(view, (node) => node.type === 'div' && node.props?.onClick !== undefined)
}

test('nothing is rendered while no close is staged', () => {
  withFakeReact(fakeReact, () => {
    const { view } = renderDialog({ pendingClose: null })
    assert.equal(view, null)
  })
})

test('the dialog is a modal that names the conversation and the consequence', () => {
  withFakeReact(fakeReact, () => {
    const { view } = renderDialog()
    const dialog = find(view, (node) => node.props?.['data-hkcraft-dialog'] === 'pane-close')

    assert.notEqual(dialog, null)
    assert.equal(dialog.props.role, 'dialog')
    assert.equal(dialog.props['aria-modal'], 'true')
    assert.equal(dialog.props['aria-label'], zh['pane.close.confirm.title'])
    assert.equal(find(view, (node) => textOf(node) === 'One') !== null, true)
  })
})

test('cancel dismisses the staged close, and the backdrop is the same exit', () => {
  withFakeReact(fakeReact, () => {
    const { view, calls } = renderDialog()
    const cancel = find(view, (node) => textOf(node) === zh['pane.close.confirm.cancel'])
    cancel.props.onClick()
    assert.equal(calls.cancel, 1)

    const backdrop = backdropOf(view)
    backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
    assert.equal(calls.cancel, 2)
    // A click that bubbled out of the dialog body must not dismiss it.
    backdrop.props.onClick({ target: {}, currentTarget: backdrop })
    assert.equal(calls.cancel, 2)
  })
})

test('the confirm action interrupts and closes', () => {
  withFakeReact(fakeReact, () => {
    const { view, calls } = renderDialog()
    const confirm = find(view, (node) => textOf(node) === zh['pane.close.confirm.action'])
    confirm.props.onClick()

    assert.equal(calls.confirm, 1)
    assert.equal(calls.force, 0)
  })
})

test('while the interrupt is in flight the action reports it and both exits are disabled', () => {
  withFakeReact(fakeReact, () => {
    const { view } = renderDialog({ closeBusy: true })
    const busy = find(view, (node) => textOf(node) === zh['pane.close.confirm.busy'])
    const cancel = find(view, (node) => textOf(node) === zh['pane.close.confirm.cancel'])

    assert.notEqual(busy, null)
    assert.equal(busy.props.disabled, true)
    assert.equal(cancel.props.disabled, true)
    // A failed interrupt has not happened yet, so there is nothing to force.
    assert.equal(find(view, (node) => node.props?.['data-hkcraft-pane-close-force'] === '') !== null, false)
  })
})

test('a refused interrupt offers "close anyway" instead of trapping the user', () => {
  withFakeReact(fakeReact, () => {
    const { view, calls } = renderDialog({ closeError: 'session/agent-busy: owned by subagent routing' })
    const alert = find(view, (node) => node.props?.role === 'alert')
    const force = find(view, (node) => node.props?.['data-hkcraft-pane-close-force'] === '')

    assert.notEqual(alert, null)
    assert.match(textOf(alert), /session\/agent-busy/)
    assert.notEqual(force, null)
    assert.equal(textOf(force), zh['pane.close.confirm.force'])
    assert.equal(force.props.title, zh['pane.close.confirm.force.hint'])
    // The reason the pane can be closed anyway is spelled out next to the error.
    assert.equal(
      find(view, (node) => textOf(node) === zh['pane.close.confirm.force.hint']) !== null,
      true,
    )

    force.props.onClick()
    assert.equal(calls.force, 1)
    // "Interrupt and close" stays available so a transient refusal can be retried.
    assert.equal(find(view, (node) => textOf(node) === zh['pane.close.confirm.action']) !== null, true)
  })
})

test('the escape hatch is not offered before an interrupt actually failed', () => {
  withFakeReact(fakeReact, () => {
    const { view } = renderDialog()
    assert.equal(find(view, (node) => node.props?.['data-hkcraft-pane-close-force'] === ''), null)
    assert.equal(find(view, (node) => node.props?.role === 'alert'), null)
  })
})
