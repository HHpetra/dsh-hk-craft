'use strict'

/**
 * The delete-workspace confirmation.
 *
 * These tests render the dialog component directly with the same React
 * stand-in the other view tests use, and assert what a user can observe: the
 * modal contract, the retention boundary, the running-session warning, the
 * busy/error states and the cancel paths. Focus restoration and the final
 * keyboard feel stay on the manual smoke list.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { withFakeReact } = require('./fake-react.js')

const { WorkspaceDeleteDialog } = require('./workspace-delete-dialog.js')
const { interpolate } = require('./react-and-translator.js')
const { zh } = require('./locale.js')

/** Localized copy with translator params, the way the real slot `t` behaves. */
const t = (key, params) => interpolate(zh[key] ?? key, params)

/**
 * A React stand-in covering the calls the dialog makes. `workspace-delete-dialog`
 * resolves `react` lazily, so the shared installer routes it to this instance. It
 * carries the full hook set because Node runs every test file in one process and
 * the first lazy load wins the shared cache.
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

/** Every element below `element` matching `predicate`. */
function findAll(element, predicate) {
  return descendants(element).filter(predicate)
}

/** Render the dialog with localized copy and recording callbacks. */
function renderDialog(overrides = {}) {
  const calls = { cancel: 0, confirm: 0 }
  const props = {
    workspaceName: 'Project A',
    runningCount: 0,
    busy: false,
    error: null,
    onCancel: () => {
      calls.cancel += 1
    },
    onConfirm: () => {
      calls.confirm += 1
    },
    t,
    ...overrides,
  }
  return { tree: WorkspaceDeleteDialog(props), calls }
}

test('the dialog is modal, named after the workspace and explains what is kept', () => {
  withFakeReact(fakeReact, () => {
    const { tree } = renderDialog()
    const dialog = find(tree, (element) => element.props?.role === 'dialog')

    assert.notEqual(dialog, null, 'the confirmation must be a dialog')
    assert.equal(dialog.props['aria-modal'], 'true')
    assert.equal(dialog.props['aria-label'], '删除工作区「Project A」')

    const text = descendants(dialog)
      .flatMap((element) => element.props?.children ?? [])
      .filter((child) => typeof child === 'string')
      .join('\n')
    // The retention boundary is the whole point of the second confirmation.
    assert.match(text, /只移除工作区登记/)
    assert.match(text, /目录和会话不会被删除/)
    assert.match(text, /未分组/)

    assert.equal(
      findAll(dialog, (element) => element.props?.role === 'alert').length,
      0,
      'a healthy dialog has no error',
    )
    assert.equal(
      find(tree, (element) => element.props?.['data-hkcraft-delete-running'] !== undefined),
      null,
      'no running warning when nothing is running',
    )

    const cancel = find(tree, (element) => element.props?.['data-hkcraft-delete-cancel'] === '')
    const confirm = find(tree, (element) => element.props?.['data-hkcraft-delete-confirm'] === '')
    assert.equal(cancel.type, 'button')
    assert.equal(confirm.type, 'button')
    assert.deepEqual(cancel.props.children, [zh['workspace.delete.cancel']])
    assert.deepEqual(confirm.props.children, [zh['workspace.delete.action']])
    assert.equal(cancel.props.disabled, false)
    assert.equal(confirm.props.disabled, false)
  })
})

test('a running session is counted and the dialog promises not to stop it', () => {
  withFakeReact(fakeReact, () => {
    const { tree } = renderDialog({ runningCount: 3 })
    const warning = find(tree, (element) => element.props?.['data-hkcraft-delete-running'] !== undefined)

    assert.notEqual(warning, null, 'a running workspace must warn before the delete')
    assert.equal(warning.props['data-hkcraft-delete-running'], '3')
    const text = (warning.props.children ?? []).filter((child) => typeof child === 'string').join('')
    assert.match(text, /3/)
    assert.match(text, /不会停止它们/)
  })
})

test('while deleting, both actions are disabled and the busy label replaces the action', () => {
  withFakeReact(fakeReact, () => {
    const { tree, calls } = renderDialog({ busy: true })
    const cancel = find(tree, (element) => element.props?.['data-hkcraft-delete-cancel'] === '')
    const confirm = find(tree, (element) => element.props?.['data-hkcraft-delete-confirm'] === '')

    assert.equal(cancel.props.disabled, true)
    assert.equal(confirm.props.disabled, true)
    assert.deepEqual(confirm.props.children, [zh['workspace.delete.busy']])

    cancel.props.onClick()
    confirm.props.onClick()
    assert.deepEqual(calls, { cancel: 0, confirm: 0 }, 'a busy dialog submits nothing')
  })
})

test('a failed delete shows the reason in the dialog and keeps it open for a retry', () => {
  withFakeReact(fakeReact, () => {
    const { tree, calls } = renderDialog({ error: 'workspace/conflict' })
    const alert = find(tree, (element) => element.props?.role === 'alert')

    assert.notEqual(alert, null, 'the failure is announced, not logged away')
    const text = (alert.props.children ?? []).filter((child) => typeof child === 'string').join('')
    assert.match(text, /workspace\/conflict/)
    assert.notEqual(find(tree, (element) => element.props?.role === 'dialog'), null)

    find(tree, (element) => element.props?.['data-hkcraft-delete-confirm'] === '').props.onClick()
    assert.equal(calls.confirm, 1, 'the user can retry')
  })
})

test('cancel and a backdrop click dismiss without deleting; a click inside does not', () => {
  withFakeReact(fakeReact, () => {
    const { tree, calls } = renderDialog()
    const overlay = tree
    const dialog = find(tree, (element) => element.props?.role === 'dialog')

    find(tree, (element) => element.props?.['data-hkcraft-delete-cancel'] === '').props.onClick()
    assert.equal(calls.cancel, 1)
    assert.equal(calls.confirm, 0)

    // A press on the backdrop closes; an equivalent target check keeps clicks
    // that started inside the dialog from bubbling out and closing it.
    overlay.props.onClick({ target: overlay, currentTarget: overlay })
    assert.equal(calls.cancel, 2)

    let stopped = 0
    dialog.props.onClick({ stopPropagation: () => (stopped += 1) })
    assert.equal(stopped, 1)
  })
})
