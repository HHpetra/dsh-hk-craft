'use strict'

/**
 * The strip's read-only current-mode seat (ticket 07, spec §6).
 *
 * This is the dumb half of the mode badge: it takes the seat props
 * `pane-toolbar.js` documents — the visible layout snapshot, the focused strip
 * entry, the raw `useSessions` / `useSessionStatus` snapshots, the host kit and
 * the translator — and paints the focused pane's preset name. The projection and
 * label rules live in `pane-mode.js`; the optional roster is read by a loader
 * injected from `index.js`, so nothing here imports dsh or a plugin context.
 *
 * Read-only by construction: a session's composition is fixed once its
 * conversation starts, so the badge is a plain `span` with a `title` and no
 * click handler. The seat renders nothing when the focused session records no
 * preset, and the strip's action group removes the empty slot entirely.
 */

const { focusedPresetId, resolveModeLabel } = require('./pane-mode.js')

let reactModule = null

/** The platform React instance; resolved lazily so Node tests can load this module. */
function react() {
  if (reactModule === null) reactModule = require('react')
  return reactModule
}

/** The chip: content-sized, capped by the seat wrapper, never a control. */
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

/** A long custom name truncates instead of squeezing the subagent seat. */
const modeLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * Build the mode seat component.
 *
 * @param {{loadRoster?: (presetId: string) => Promise<{id: string, name?: string, description?: string}[]>}} [options]
 *   `loadRoster` is the optional agent-preset roster adapter; when it is absent
 *   or fails, the badge still resolves the localized shipped name or the id.
 * @returns {(props: object) => any} the React seat component
 */
function createModeSeat(options = {}) {
  const loadRoster = typeof options.loadRoster === 'function' ? options.loadRoster : null

  /**
   * One pane strip seat: the focused conversation's mode, or null.
   *
   * @param {object} props seat props from `PaneStripActions`
   */
  function ModeSeat(props) {
    const React = react()
    const h = React.createElement
    const presetId = focusedPresetId(props?.focused, props?.sessions)
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
        'data-hkcraft-strip-mode': mode.id,
        style: modeBadgeStyle,
      },
      h('span', { style: modeLabelStyle }, mode.label),
    )
  }

  ModeSeat.displayName = 'HkcraftModeSeat'
  return ModeSeat
}

module.exports = { createModeSeat }
