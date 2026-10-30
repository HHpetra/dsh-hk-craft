'use strict'

/**
 * The one palette behind both status-dot tables.
 *
 * The sidebar lights and the strip dots describe different things (workspace
 * aggregate vs. one conversation), but they share the same three colour roles,
 * so the literal fills live here once. Token-backed entries follow the shell's
 * palette and fall back to the literal on a shell without the token.
 *
 * The sidebar's fourth state, gray, is a deliberately neutral fill that does not
 * follow the theme's accent: it means "not enabled / no conversation finished",
 * not "disabled by the shell" (spec §1, §10).
 */

const {
  STRIP_STATUS_RUNNING,
  STRIP_STATUS_WAITING,
  STRIP_STATUS_IDLE,
} = require('./pane-strip.js')

/** Dot fills for the sidebar workspace lights (red > yellow > green > gray). */
const LIGHT_COLORS = Object.freeze({
  red: '#e5484d',
  yellow: '#d9a400',
  green: '#30a46c',
  gray: '#8b8d98',
})

/** Dot fills per strip status; running/waiting follow the shell's tokens. */
const STRIP_STATUS_COLORS = Object.freeze({
  [STRIP_STATUS_RUNNING]: 'var(--dsw-alias-state-warn-primary, #d9a400)',
  [STRIP_STATUS_WAITING]: 'var(--dsw-alias-state-error-primary, #e5484d)',
  [STRIP_STATUS_IDLE]: '#30a46c',
})

module.exports = { LIGHT_COLORS, STRIP_STATUS_COLORS }
