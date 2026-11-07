'use strict'

/**
 * One draggable split separator.
 *
 * Split out of `pane-view.js` because a divider drag changes with pointer
 * geometry, not with the strip, the header or the host.
 */

const { react } = require('./react-and-translator.js')
const { SEPARATOR_HIT_PX, SEPARATOR_LINE_PX } = require('./layout-geometry.js')
const { ratioFromDrag } = require('./layout-tree.js')
const { T } = require('./visual-tokens.js')

/**
 * One draggable separator. Its own size is read from the layout box at drag
 * start, so the clamp uses real pixels (`ratioFromDrag`) rather than the
 * fraction alone: a pane can never be dragged below the minimum width/height.
 *
 * @param {{ controller: any, separator: object }} props
 */
function PaneSeparator({ controller, separator }) {
  const React = react()
  const h = React.createElement
  const drag = React.useRef(null)
  const [hot, setHot] = React.useState(false)
  const row = separator.dir === 'row'

  const lineColor = hot
    ? 'var(--dsw-alias-state-business-primary, Highlight)'
    : T.border3

  const hitStyle = row
    ? {
        position: 'absolute',
        left: `${separator.x * 100}%`,
        top: `${separator.y * 100}%`,
        height: `${separator.height * 100}%`,
        width: SEPARATOR_HIT_PX,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        cursor: 'col-resize',
        touchAction: 'none',
        zIndex: 2,
      }
    : {
        position: 'absolute',
        left: `${separator.x * 100}%`,
        top: `${separator.y * 100}%`,
        width: `${separator.width * 100}%`,
        height: SEPARATOR_HIT_PX,
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'center',
        cursor: 'row-resize',
        touchAction: 'none',
        zIndex: 2,
      }

  const lineStyle = row
    ? { width: SEPARATOR_LINE_PX, borderRadius: 2, background: lineColor }
    : { height: SEPARATOR_LINE_PX, width: '100%', borderRadius: 2, background: lineColor }

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    const box = event.currentTarget.parentElement?.getBoundingClientRect?.()
    if (box === undefined) return
    drag.current = {
      // The split's own size, not the workspace: a nested split is smaller than
      // the box, and the pixel minimum must be clamped against it.
      size: (row ? box.width : box.height) * (separator.extent ?? 1),
      start: row ? event.clientX : event.clientY,
      ratio: separator.ratio,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event) => {
    const state = drag.current
    if (state === null) return
    const current = row ? event.clientX : event.clientY
    controller.layout.resize(
      separator.path,
      ratioFromDrag({
        startRatio: state.ratio,
        deltaPx: current - state.start,
        sizePx: state.size,
      }),
    )
    event.preventDefault()
  }

  const endDrag = (event) => {
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  return h(
    'div',
    {
      role: 'separator',
      'aria-orientation': row ? 'vertical' : 'horizontal',
      'data-hkcraft-separator': separator.path.length === 0 ? 'root' : separator.path.join('/'),
      style: hitStyle,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerEnter: () => setHot(true),
      onPointerLeave: () => setHot(false),
    },
    h('div', { style: lineStyle }),
  )
}

module.exports = { PaneSeparator }
