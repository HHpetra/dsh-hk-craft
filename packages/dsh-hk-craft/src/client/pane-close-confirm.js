'use strict'

/**
 * The interrupt confirmation for closing a running pane.
 *
 * The host renders one of these for every loaded workspace. The staged close
 * itself lives in `pane-close.js`; this file only paints the dialog.
 *
 * Three ways out, because the interrupt is a request the Host may refuse: close
 * after a successful interrupt, dismiss without touching the session, or — once
 * the interrupt has failed and `closeError` is set — close the pane anyway and
 * let the turn keep running in the background (ADR-0021).
 *
 * The dialog is not a modal mask. A full-screen overlay, even a dismissable
 * one, sits on top of every other pane for as long as it is open — including
 * the whole interrupt wait, while Cancel used to be disabled — so a running
 * turn made the other sessions unclosable. The card floats and does not take
 * pointer events outside itself. Escape still dismisses, including while the
 * interrupt is in flight.
 */

const { react } = require('./react-and-translator.js')
const { T } = require('./visual-tokens.js')
const { runAttempt, usePaneSnapshot } = require('./pane-view-support.js')
const {
  buttonStyle,
  closeActionsStyle,
  closeDialogStyle,
  closeErrorStyle,
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
  const cancelRef = React.useRef(null)

  const cancel = () => controller.close.cancel()
  const failed = state.closeError !== null && state.closeError !== undefined

  // Escape dismisses, including while the interrupt is still in flight. The
  // close flow drops the staged pane, so a late Host answer does not close it.
  React.useEffect(() => {
    if (pending === null || pending === undefined) return undefined
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

  // A keyboard user should already be inside the modal instead of tabbing into
  // the panes behind the overlay.
  React.useEffect(() => {
    if (pending === null || pending === undefined) return
    const node = cancelRef.current
    if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
  }, [pending])

  if (pending === null || pending === undefined) return null

  const confirm = () => {
    runAttempt(controller.close.confirm())
  }
  const force = () => controller.close.force()

  return h(
    'div',
    {
      // A dock, not a mask: the box is only as large as the card, and the
      // wrapper itself ignores hits. Close buttons on the other panes stay
      // under the pointer while this confirmation is up.
      'data-hkcraft-pane-close-dock': '',
      style: closeDockStyle,
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'false',
        'aria-label': t('pane.close.confirm.title'),
        'data-hkcraft-dialog': 'pane-close',
        style: { ...closeDialogStyle, pointerEvents: 'auto', width: '100%' },
        onClick: (event) => event?.stopPropagation?.(),
      },
      pending.title === undefined ? null : h('div', { style: closeTitleStyle }, pending.title),
      h(
        'div',
        { style: { fontWeight: 600, fontSize: 15, lineHeight: 1.5, marginBottom: 6, color: T.text } },
        t('pane.close.confirm.title'),
      ),
      h('div', { style: { color: T.textSecondary } }, t('pane.close.confirm.body')),
      failed
        ? h(
            'div',
            { role: 'alert', style: closeErrorStyle },
            `${t('pane.close.confirm.error')}: ${state.closeError}`,
          )
        : null,
      // The consequence of closing anyway is not obvious from the button alone,
      // so it is spelled out where the failure is reported.
      failed
        ? h(
            'div',
            { style: { color: T.textTertiary, marginTop: 8 } },
            t('pane.close.confirm.force.hint'),
          )
        : null,
      h(
        'div',
        { style: closeActionsStyle },
        h(
          'button',
          {
            type: 'button',
            ref: cancelRef,
            className: 'hk-button hk-button--quiet',
            style: buttonStyle,
            onClick: cancel,
          },
          t('pane.close.confirm.cancel'),
        ),
        failed
          ? h(
              'button',
              {
                type: 'button',
                'data-hkcraft-pane-close-force': '',
                className: 'hk-button hk-button--quiet',
                style: buttonStyle,
                disabled: state.closeBusy,
                title: t('pane.close.confirm.force.hint'),
                onClick: force,
              },
              t('pane.close.confirm.force'),
            )
          : null,
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

/**
 * The confirmation floats at the bottom of the viewport.
 *
 * Top-anchored cards cover pane headers, which is where the other sessions'
 * close buttons live. The wrapper does not receive hits; only the card does.
 */
const closeDockStyle = {
  position: 'fixed',
  zIndex: 2147483000,
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  width: 'min(440px, calc(100vw - 32px))',
  pointerEvents: 'none',
}

module.exports = { PaneCloseConfirm }
