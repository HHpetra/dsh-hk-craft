'use strict'

/**
 * The pane header's read-only current-mode badge.
 *
 * This is the dumb half of the mode badge: it takes the pane header props — the
 * pane's session id, the raw `useSessions` snapshot, the translator and its box
 * style — and paints the preset name. The projection and label rules live in
 * `pane-mode.js`; the optional roster is read by a loader injected from
 * `index.js`, so nothing here imports dsh or a plugin context.
 *
 * Read-only by construction: a session's composition is fixed once its
 * conversation starts, so the badge is a plain `span` with a `title` and no
 * click handler. The seat renders nothing when the session records no preset, so
 * the header simply omits it.
 */

const { presetIdOfSession, resolveModeLabel } = require('./pane-mode.js')
const { react } = require('./react-and-translator.js')

/** The chip: content-sized, capped by its pane-header box, never a control. */
const modeBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 0,
  maxWidth: '100%',
  height: 22,
  padding: '0 6px',
  borderRadius: 4,
  background: 'var(--dsw-alias-fill-tsp-secondary, color-mix(in srgb, currentColor 8%, transparent))',
  color: 'var(--dsw-alias-label-tertiary, inherit)',
  fontSize: 12,
  lineHeight: '22px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  cursor: 'default',
}

/** A long custom name truncates instead of squeezing the rest of the header. */
const modeLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * Build the mode badge component.
 *
 * @param {{loadRoster?: (presetId: string) => Promise<{id: string, name?: string, description?: string}[]>}} [options]
 *   `loadRoster` is the optional agent-preset roster adapter; when it is absent
 *   or fails, the badge still resolves the localized shipped name or the id.
 * @returns {(props: object) => any} the React badge component
 */
function createModeSeat(options = {}) {
  const loadRoster = typeof options.loadRoster === 'function' ? options.loadRoster : null

  /**
   * One pane header badge: that pane's mode, or null.
   *
   * @param {object} props pane header props
   */
  function ModeSeat(props) {
    const React = react()
    const h = React.createElement
    const presetId = presetIdOfSession(props?.sessions, props?.sessionId)
    const [roster, setRoster] = React.useState([])

    React.useEffect(() => {
      if (presetId === undefined || loadRoster === null) return undefined
      let active = true
      Promise.resolve()
        .then(() => loadRoster(presetId))
        .then((rows) => {
          if (active) setRoster(Array.isArray(rows) ? rows : [])
        })
        .catch(() => {})
      return () => {
        active = false
      }
    }, [presetId])

    if (presetId === undefined) return null
    const mode = resolveModeLabel(presetId, roster, props?.t)
    return h(
      'span',
      {
        title: mode.title,
        'data-hkcraft-pane-mode': mode.id,
        // The pane header's box (width cap) rides on the root the badge actually
        // renders, so an absent badge takes no room.
        style: { ...modeBadgeStyle, ...props?.seatStyle },
      },
      h('span', { style: modeLabelStyle }, mode.label),
    )
  }

  ModeSeat.displayName = 'HkcraftModeSeat'
  return ModeSeat
}

module.exports = { createModeSeat }
