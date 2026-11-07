'use strict'

/**
 * The interrupt confirmation for closing a running pane.
 *
 * The host renders one of these for every loaded workspace. The staged close
 * itself lives in `pane-close.js`; this file only paints the dialog.
 */

const { react } = require('./react-and-translator.js')
const { T } = require('./visual-tokens.js')
const { runAttempt, usePaneSnapshot } = require('./pane-view-support.js')
const {
  buttonStyle,
  closeActionsStyle,
  closeDialogStyle,
  closeErrorStyle,
  closeOverlayStyle,
  closeTitleStyle,
} = require('./pane-styles.js')

/**
 * The interrupt confirmation for closing a running pane (spec D4). It is
 * rendered by the pane host itself, so it exists only while split mode is
 * active; cancelling dismisses it without touching the session.
 *
 * @param {{ controller: any, t: (key: string) => string }} props
 */
function PaneCloseConfirm({ controller, t }) {
  const React = react()
  const h = React.createElement
  const state = usePaneSnapshot(React, controller)
  const pending = state.pendingClose
  if (pending === null || pending === undefined) return null

  const confirm = () => {
    runAttempt(controller.close.confirm())
  }

  return h(
    'div',
    { style: closeOverlayStyle },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('pane.close.confirm.title'),
        'data-hkcraft-dialog': 'pane-close',
        style: closeDialogStyle,
      },
      pending.title === undefined ? null : h('div', { style: closeTitleStyle }, pending.title),
      h(
        'div',
        { style: { fontWeight: 600, fontSize: 15, lineHeight: 1.5, marginBottom: 6, color: T.text } },
        t('pane.close.confirm.title'),
      ),
      h('div', { style: { color: T.textSecondary } }, t('pane.close.confirm.body')),
      state.closeError === null
        ? null
        : h(
            'div',
            { role: 'alert', style: closeErrorStyle },
            `${t('pane.close.confirm.error')}: ${state.closeError}`,
          ),
      h(
        'div',
        { style: closeActionsStyle },
        h(
          'button',
          {
            type: 'button',
            className: 'hk-button hk-button--quiet',
            style: buttonStyle,
            disabled: state.closeBusy,
            onClick: () => controller.close.cancel(),
          },
          t('pane.close.confirm.cancel'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'hk-button hk-button--danger',
            style: buttonStyle,
            disabled: state.closeBusy,
            onClick: confirm,
          },
          state.closeBusy ? t('pane.close.confirm.busy') : t('pane.close.confirm.action'),
        ),
      ),
    ),
  )
}

module.exports = { PaneCloseConfirm }
