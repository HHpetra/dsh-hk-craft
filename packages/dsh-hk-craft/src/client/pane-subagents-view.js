'use strict'

/**
 * The subagent viewer's React half, mounted in each pane header.
 *
 * `pane-subagents.js` owns the catalog projection and every dsh shape; this file
 * only paints the count trigger and the flat dropdown, and routes a pick to the
 * pane controller's `openInNewPane` path. It reads the pane's own session id from
 * the header props, so every pane shows its own children.
 *
 * The dropdown is a flat menu of direct children: nested expansion, hover-open,
 * retry and breadcrumbs are out of scope for this viewer.
 *
 * Static styles stay in this file rather than `pane-styles.js`: the two header
 * controls are independent. The menu is `position: fixed` because a narrow pane
 * clips its header content, so a portal-free dropdown has to escape the pane box.
 * `react` is resolved lazily because unit tests load this module in Node, where
 * the platform module graph does not exist.
 */

const { react } = require('./react-and-translator.js')
const { buttonStyle } = require('./pane-styles.js')
const { STRIP_STATUS_COLORS } = require('./status-colors.js')
const {
  SUBAGENT_ACTIVITY_KEYS,
  SUBAGENT_ACTIVITY_RUNNING,
  openSubagentInPane,
  projectSubagentCatalog,
  requestCatalogRefresh,
} = require('./pane-subagents.js')

/** Fallback dot colour while a direct child is running. */
const RUNNING_DOT_COLOR = STRIP_STATUS_COLORS[SUBAGENT_ACTIVITY_RUNNING]

const rootStyle = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
  minWidth: 0,
  maxWidth: '100%',
}

const triggerStyle = {
  ...buttonStyle,
  gap: 4,
  padding: '2px 6px',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

const triggerLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const runningDotStyle = {
  flex: 'none',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: RUNNING_DOT_COLOR,
}

/** A fixed-position menu, because a narrow pane clips anything flowing out of it. */
const menuStyle = {
  position: 'fixed',
  zIndex: 100,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  boxSizing: 'border-box',
  maxWidth: 320,
  maxHeight: 'min(320px, 60vh)',
  overflowY: 'auto',
  padding: 4,
  borderRadius: 8,
  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, Canvas))',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  boxShadow: '0 8px 24px color-mix(in srgb, black 22%, transparent)',
  whiteSpace: 'normal',
  textAlign: 'left',
}

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  minWidth: 0,
  padding: '4px 8px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
}

const rowLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const rowDetailStyle = {
  flex: 'none',
  fontSize: 11,
  opacity: 0.7,
}

/**
 * The subagent viewer. `options.refreshCatalog` is the optional-service callback
 * `index.js` builds (`ctx.get('sessions')?.refreshProjections`); the viewer calls
 * it once per opening and never blocks the menu on its result.
 *
 * @param {{refreshCatalog?: (sessionId: string) => unknown}} [options]
 * @returns {(props: any) => any}
 */
function createSubagentSeat(options = {}) {
  const refreshCatalog =
    typeof options?.refreshCatalog === 'function' ? options.refreshCatalog : undefined

  return function SubagentSeat(props) {
    const React = react()
    const h = React.createElement
    const t = typeof props?.t === 'function' ? props.t : (key) => key
    const controller = props?.controller
    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
    const model = projectSubagentCatalog(props?.sessions, sessionId, props?.statuses)
    const catalogSessionId = model === null ? '' : model.sessionId
    const visible = model !== null

    const [open, setOpen] = React.useState(false)
    const [menuPosition, setMenuPosition] = React.useState(null)
    const rootRef = React.useRef(null)
    const triggerRef = React.useRef(null)

    React.useEffect(() => {
      if (!open || catalogSessionId === '') return undefined
      // One refresh per opening; new direct children then arrive through the
      // normal live projection frames, without a menu subscription.
      requestCatalogRefresh(refreshCatalog, catalogSessionId)
      return undefined
    }, [open, catalogSessionId])

    React.useEffect(() => {
      if (!open || visible) return undefined
      // The focused catalog disappeared while the menu was open (focus moved or
      // the projection was withdrawn): drop the menu with it.
      setOpen(false)
      return undefined
    }, [open, visible])

    React.useEffect(() => {
      if (!open) return undefined
      if (typeof document === 'undefined') return undefined
      const onPointerDown = (event) => {
        const root = rootRef.current
        const target = event?.target
        if (
          root !== null &&
          typeof root.contains === 'function' &&
          typeof Node !== 'undefined' &&
          target instanceof Node &&
          root.contains(target)
        ) {
          return
        }
        setOpen(false)
        // Focus returns to the trigger on every close path.
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(() => triggerRef.current?.focus?.())
        }
      }
      document.addEventListener('pointerdown', onPointerDown)
      return () => document.removeEventListener('pointerdown', onPointerDown)
    }, [open])

    if (!visible) return null

    const restoreTriggerFocus = () => {
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => triggerRef.current?.focus?.())
      }
    }

    const closeMenu = (focusTrigger) => {
      setOpen(false)
      if (focusTrigger) restoreTriggerFocus()
    }

    const openMenu = () => {
      const trigger = triggerRef.current
      if (
        trigger !== null &&
        typeof trigger.getBoundingClientRect === 'function' &&
        typeof window !== 'undefined'
      ) {
        const box = trigger.getBoundingClientRect()
        // Keep the menu inside the viewport and align its right edge with the
        // trigger, like a native header dropdown.
        const width = Math.min(280, Math.max(160, window.innerWidth - 16))
        setMenuPosition({
          top: box.bottom + 4,
          left: Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)),
          width,
        })
      }
      setOpen(true)
    }

    const toggleMenu = () => {
      if (open) closeMenu(false)
      else openMenu()
    }

    const pick = (row) => {
      if (row === null || row.navigable !== true) return
      // Selection closes the menu first, so an open failure still leaves no
      // stale overlay behind.
      closeMenu(true)
      openSubagentInPane(controller, row)
    }

    const triggerText =
      model.running > 0
        ? `${t('subagent.trigger')} ${model.total} · ${model.running} ${t('subagent.activity.running')}`
        : `${t('subagent.trigger')} ${model.total}`

    const menu = open
      ? h(
          'div',
          {
            role: 'menu',
            'aria-label': t('subagent.menu.aria'),
            'data-hkcraft-subagent-menu': '',
            style: {
              ...menuStyle,
              top: menuPosition === null ? 0 : menuPosition.top,
              left: menuPosition === null ? 8 : menuPosition.left,
              width: menuPosition === null ? 280 : menuPosition.width,
            },
          },
          model.rows.map((row) => {
            const activityLabel =
              row.activity === null ? null : t(SUBAGENT_ACTIVITY_KEYS[row.activity])
            const rowText =
              activityLabel === null
                ? `${row.label} · ${t(row.modeKey)}`
                : `${row.label} · ${t(row.modeKey)} · ${activityLabel}`
            const label = h('span', { style: rowLabelStyle }, row.label)
            const detail = h(
              'span',
              { style: rowDetailStyle },
              activityLabel === null ? t(row.modeKey) : `${t(row.modeKey)} · ${activityLabel}`,
            )
            if (!row.navigable) {
              return h(
                'div',
                {
                  key: row.id,
                  role: 'menuitem',
                  tabIndex: -1,
                  'aria-disabled': 'true',
                  'data-hkcraft-subagent-row': row.id,
                  'data-hkcraft-subagent-mode': row.mode,
                  style: { ...rowStyle, cursor: 'default', opacity: 0.66 },
                  title: `${rowText} — ${t('subagent.external.hint')}`,
                },
                label,
                detail,
              )
            }
            return h(
              'button',
              {
                key: row.id,
                type: 'button',
                role: 'menuitem',
                'data-hkcraft-subagent-row': row.id,
                'data-hkcraft-subagent-mode': row.mode,
                'data-hkcraft-subagent-activity': row.activity,
                style: rowStyle,
                title: rowText,
                'aria-label': `${t('subagent.open')}: ${rowText}`,
                onClick: () => pick(row),
              },
              label,
              detail,
            )
          }),
        )
      : null

    return h(
      'div',
      {
        ref: rootRef,
        'data-hkcraft-pane-subagents': '',
        // The pane header's box (width cap) rides on the root the viewer actually
        // renders, so an absent viewer takes no room.
        style: { ...rootStyle, ...props?.seatStyle },
        onKeyDown: (event) => {
          if (event.key !== 'Escape' || !open) return
          event.preventDefault()
          event.stopPropagation()
          closeMenu(true)
        },
      },
      h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': triggerText,
          title: triggerText,
          'data-hkcraft-subagent-trigger': '',
          style: triggerStyle,
          onClick: toggleMenu,
        },
        model.running > 0
          ? h('span', {
              'aria-hidden': 'true',
              'data-hkcraft-subagent-running': '',
              style: runningDotStyle,
            })
          : null,
        h('span', { style: triggerLabelStyle }, `${t('subagent.trigger')} ${model.total}`),
        model.running > 0
          ? h(
              'span',
              { 'aria-hidden': 'true', style: { flex: 'none', opacity: 0.72 } },
              `${model.running} ${t('subagent.activity.running')}`,
            )
          : null,
      ),
      menu,
    )
  }
}

module.exports = { createSubagentSeat }
