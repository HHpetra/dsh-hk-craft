'use strict'

/**
 * The second confirmation before a workspace registration is deleted (ticket
 * 03, spec §2).
 *
 * It exists because deleting a workspace is easy to misread: the row goes away,
 * so the user needs to be told that the directory and the conversations stay, and
 * that a running turn keeps running. The dialog is owned by the sidebar section
 * (`sidebar-workspaces.js`), which is also the only place that knows the pending
 * workspace, the running count and the delete outcome; this component is a dumb
 * renderer over those plain props.
 *
 * Cancel, Escape and a backdrop click all dismiss without writing. The parent
 * disables both actions while a delete is in flight and reports a failure inside
 * this dialog instead of closing it.
 *
 * `react` is resolved lazily for the same reason as the other views: unit tests
 * load this module in Node, where the platform module graph does not exist.
 */

const { createTranslator, react } = require('./diagnostics.js')
const {
  buttonStyle,
  closeOverlayStyle,
  closeDialogStyle,
  closeActionsStyle,
  closeErrorStyle,
} = require('./pane-styles.js')

/** The dialog title is the primary line, unlike the pane close dialog's muted one. */
const titleStyle = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 8,
  wordBreak: 'break-word',
}

const bodyStyle = {
  opacity: 0.82,
  whiteSpace: 'normal',
}

/** The running-session warning: a count plus the "we will not stop them" promise. */
const runningStyle = {
  marginTop: 8,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'color-mix(in srgb, #d9a400 14%, transparent)',
  whiteSpace: 'normal',
}

/** Localize a `{name}` / `{n}` placeholder without relying on translator params. */
function fill(template, placeholder, value) {
  // A function replacement keeps `$&`-style sequences in a workspace name literal.
  return template.replace(placeholder, () => value)
}

/**
 * @param {{
 *   workspaceId?: string,
 *   workspaceName?: string,
 *   runningCount?: number,
 *   busy?: boolean,
 *   error?: string|null,
 *   onCancel?: () => void,
 *   onConfirm?: () => void,
 *   t?: (key: string) => string,
 * }} props
 */
function WorkspaceDeleteDialog(props) {
  const React = react()
  const h = React.createElement
  const t = createTranslator(props)
  const busy = props?.busy === true
  const name =
    typeof props?.workspaceName === 'string' && props.workspaceName !== ''
      ? props.workspaceName
      : t('workspace.defaultName')
  const runningCount = Number.isInteger(props?.runningCount) ? props.runningCount : 0
  const title = fill(t('workspace.delete.title'), '{name}', name)

  const cancel = () => {
    if (!busy) props?.onCancel?.()
  }

  // Escape closes the dialog but never submits it. While the delete is in flight
  // there is nothing safe to do, so the key is swallowed.
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onKeyDown = (event) => {
      if (event?.key !== 'Escape') return
      event.preventDefault?.()
      event.stopPropagation?.()
      cancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  })

  // The first focusable action should receive the focus, so a keyboard user is
  // already inside the modal and cannot tab into the sidebar behind it.
  const cancelRef = React.useRef(null)
  React.useEffect(() => {
    const node = cancelRef.current
    if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
  }, [])

  const onBackdrop = (event) => {
    // Only the backdrop itself, never a bubbled click from the dialog body.
    if (event?.target !== event?.currentTarget) return
    cancel()
  }

  return h(
    'div',
    { style: closeOverlayStyle, onClick: onBackdrop },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        'data-hkcraft-workspace-delete-dialog': props?.workspaceId ?? '',
        style: closeDialogStyle,
        onClick: (event) => event?.stopPropagation?.(),
      },
      h('div', { style: titleStyle }, title),
      h('div', { style: bodyStyle }, t('workspace.delete.body')),
      runningCount > 0
        ? h(
            'div',
            { style: runningStyle, 'data-hkcraft-delete-running': String(runningCount) },
            fill(t('workspace.delete.running'), '{n}', String(runningCount)),
          )
        : null,
      props?.error === null || props?.error === undefined || props?.error === ''
        ? null
        : h(
            'div',
            { role: 'alert', style: closeErrorStyle },
            `${t('workspace.delete.error')}: ${props.error}`,
          ),
      h(
        'div',
        { style: closeActionsStyle },
        h(
          'button',
          {
            type: 'button',
            ref: cancelRef,
            'data-hkcraft-delete-cancel': '',
            style: buttonStyle,
            disabled: busy,
            onClick: cancel,
          },
          t('workspace.delete.cancel'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-hkcraft-delete-confirm': '',
            style: buttonStyle,
            disabled: busy,
            onClick: () => {
              if (!busy) props?.onConfirm?.()
            },
          },
          busy ? t('workspace.delete.busy') : t('workspace.delete.action'),
        ),
      ),
    ),
  )
}

module.exports = { WorkspaceDeleteDialog }
