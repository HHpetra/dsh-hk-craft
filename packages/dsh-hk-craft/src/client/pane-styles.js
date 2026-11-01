'use strict'

/**
 * Every static style object the pane view uses.
 *
 * Kept away from `pane-view.js` so the component file reads as rendering logic
 * and so the palette / density can be reviewed in one place. Values are plain
 * React style objects; nothing here imports React or dsh.
 *
 * Visual rules that need a pseudo-class (`:hover`, `:focus-visible`,
 * `:disabled`) live in `visuals.js`. This file owns geometry and the resting
 * look; the two communicate through the `--hk-*-bg` / `--hk-*-fg` custom
 * properties from `visual-tokens.js`, so neither layer has to override the
 * other with `!important`.
 */

const { T, paint, ink } = require('./visual-tokens.js')

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flex: 'none',
  minWidth: 0,
  height: 28,
  padding: '0 10px',
  border: 'none',
  borderRadius: T.radiusSm,
  background: paint('button-bg'),
  color: ink('button-fg', 'inherit'),
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  transition: `background-color ${T.fast} ${T.ease}, color ${T.fast} ${T.ease}, opacity ${T.fast} ${T.ease}`,
}

const paneStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  background: T.surface,
  color: T.text,
}

/** The workspace box: the strip on top, the pane area filling the rest. */
const workspaceStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  background: T.surface,
  color: T.text,
}

/** The pane area the fractional rectangles are drawn in. */
const layoutStyle = {
  position: 'relative',
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  width: '100%',
  overflow: 'hidden',
}

/**
 * The host box every workspace layer lives in. It is positioned so hidden
 * workspaces can be absolutely covered by `display: none` without unmounting.
 */
const hostStyle = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  width: '100%',
  overflow: 'hidden',
}

/** A workspace that stays mounted but is not the visible one (spec D5). */
const hiddenWorkspaceStyle = {
  position: 'absolute',
  inset: 0,
  display: 'none',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
}

/** Strip height: native header-row density with room for a 28px pill. */
const PANE_STRIP_HEIGHT = 40

const paneStripStyle = {
  display: 'flex',
  alignItems: 'stretch',
  flex: 'none',
  height: PANE_STRIP_HEIGHT,
  minHeight: PANE_STRIP_HEIGHT,
  minWidth: 0,
  // A hairline, not a 1px rule: it matches the shell's own header dividers.
  borderBottom: `0.5px solid ${T.border2}`,
  background: T.surface,
  paddingRight: 6,
}

/**
 * The strip's scrollport. The tabs and `+` live inside it, so `+`
 * follows the last tab and scrolls away with the tabs when they overflow; the
 * pinned action group sits outside. The viewport gives way before the group:
 * `flex: 1 1 auto` + `minWidth: 0` here, `flex: none` on the group.
 */
const stripViewportStyle = {
  display: 'flex',
  alignItems: 'stretch',
  flex: '1 1 auto',
  minWidth: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  whiteSpace: 'nowrap',
  scrollbarWidth: 'thin',
}

/** Pinned strip actions. Tabs scroll inside the viewport; this group does not. */
const stripActionGroupStyle = {
  display: 'flex',
  alignItems: 'center',
  flex: 'none',
  gap: 2,
  marginLeft: 4,
  minWidth: 0,
}

const stripRightbarStyle = {
  ...buttonStyle,
  flex: 'none',
  alignSelf: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: T.radiusSm,
  padding: 0,
  color: ink('button-fg', T.textSecondary),
}

/** The `tablist`: the entries only, immediately followed by `+` in the viewport. */
const stripTablistStyle = {
  display: 'flex',
  alignItems: 'center',
  flex: '0 0 auto',
}

/**
 * The box for one native control in a pane header. The pane header's own gap
 * supplies the spacing, so an absent control simply contributes no element and
 * no gap. Each caller caps its own width.
 */
const headerSeatStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
  minWidth: 0,
  overflow: 'hidden',
}

const stripItemStyle = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  maxWidth: 208,
  minWidth: 0,
  height: 28,
  margin: '0 1px',
  padding: '0 6px 0 9px',
  border: 'none',
  borderRadius: T.radiusSm,
  background: paint('tab-bg'),
  color: ink('tab-fg', T.textSecondary),
  font: 'inherit',
  fontSize: 13,
  fontWeight: 450,
  lineHeight: 1,
  cursor: 'pointer',
  userSelect: 'none',
  transition: `background-color ${T.fast} ${T.ease}, color ${T.fast} ${T.ease}`,
  // Pointer dragging (not HTML5 DnD) needs the browser not to claim the gesture.
  touchAction: 'none',
}

/** Titles truncate instead of squeezing their neighbours (spec §5). */
const stripTitleStyle = {
  maxWidth: 136,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * A fixed-size dot whose ring keeps it legible on both the light and the dark
 * palette. Neither ring takes part in layout, and the dot is always rendered —
 * a status change only recolours it.
 */
const stripDotStyle = {
  flex: 'none',
  width: 6,
  height: 6,
  borderRadius: '50%',
  transition: `background-color ${T.normal} ${T.ease}, box-shadow ${T.normal} ${T.ease}`,
  boxShadow: `0 0 0 1px ${T.surface}, 0 0 0 2px color-mix(in srgb, currentColor 22%, transparent)`,
}

const stripCloseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 17,
  height: 17,
  padding: 0,
  border: 'none',
  borderRadius: T.radiusXs,
  background: paint('icon-bg'),
  color: ink('icon-fg', T.textTertiary),
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
  transition: `background-color ${T.fast} ${T.ease}, color ${T.fast} ${T.ease}`,
}

/**
 * `+` follows the last tab inside the scrollport: a small square action, not a
 * full-height, right-aligned slab.
 */
const stripNewStyle = {
  ...buttonStyle,
  flex: 'none',
  alignSelf: 'center',
  width: 26,
  height: 26,
  border: 'none',
  borderRadius: T.radiusSm,
  padding: 0,
  color: ink('button-fg', T.textSecondary),
  fontSize: 16,
  fontWeight: 400,
}

const headerStyle = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 'none',
  minHeight: 38,
  padding: '0 8px 0 12px',
  borderBottom: `0.5px solid ${T.border2}`,
  background: paint('header-bg', T.surface),
  fontSize: 12,
}

const titleStyle = {
  // The title keeps its content width so the mode, subagent and view controls
  // sit immediately to its right. It shrinks (and truncates) before them; the
  // close button's `marginLeft: auto` owns the far right edge.
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: T.text,
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '0.005em',
}

const bodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  position: 'relative',
}

const fallbackStyle = {
  margin: 'auto',
  maxWidth: 560,
  padding: 24,
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1.6,
  opacity: 0.9,
}

/** The empty state's hero plus its recent list, centred in the workspace box. */
const emptyStackStyle = {
  margin: 'auto',
  width: '100%',
  maxWidth: 540,
  padding: '32px 24px 36px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1.65,
  boxSizing: 'border-box',
}

/** The hero glyph: four panes drawn in the shell's accent, on a soft tint. */
const emptyMarkStyle = {
  display: 'grid',
  placeItems: 'center',
  width: 52,
  height: 52,
  margin: '0 auto 4px',
  borderRadius: 16,
  color: T.accent,
  background:
    'linear-gradient(145deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 16%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 4%, transparent))',
  border: '0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 22%, transparent)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, #ffffff 34%, transparent)',
}

const emptyTitleStyle = {
  color: T.text,
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1.45,
  letterSpacing: '-0.005em',
}

const emptyBodyStyle = {
  color: T.textSecondary,
  maxWidth: 420,
  margin: '0 auto',
}

const emptyActionStyle = {
  ...buttonStyle,
  alignSelf: 'center',
  height: 32,
  padding: '0 16px',
  marginTop: 4,
  border: 'none',
  borderRadius: T.radiusSm,
  background:
    paint('button-bg', 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, Highlight))'),
  color: ink('button-fg', T.textOnAccent),
  fontSize: 13,
  fontWeight: 500,
  boxShadow: 'var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.06))',
}

const recentHeadingStyle = {
  marginTop: 12,
  paddingTop: 14,
  borderTop: `0.5px solid ${T.border2}`,
  color: T.textTertiary,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  textAlign: 'left',
}

const recentListStyle = { display: 'flex', flexDirection: 'column', gap: 4 }

const recentRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 34,
  boxSizing: 'border-box',
  border: `0.5px solid ${T.border2}`,
  borderRadius: T.radiusSm,
  background: paint('row-bg'),
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '20px',
  cursor: 'pointer',
  padding: '5px 9px',
  textAlign: 'left',
  transition: `background-color ${T.fast} ${T.ease}, border-color ${T.fast} ${T.ease}`,
}

const recentLabelStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: T.text,
}

const recentDetailStyle = { flex: 'none', color: T.textTertiary, fontSize: 11 }

const recentBadgeStyle = {
  flex: 'none',
  fontSize: 10,
  lineHeight: '16px',
  padding: '0 6px',
  borderRadius: 999,
  border: `0.5px solid ${T.border3}`,
  color: T.textSecondary,
  background: T.module,
}

const hintStyle = {
  marginTop: 10,
  padding: '6px 10px',
  borderRadius: T.radiusSm,
  background: `color-mix(in srgb, ${T.module} 60%, transparent)`,
  color: T.textTertiary,
  fontSize: 11,
  lineHeight: 1.55,
  textAlign: 'center',
}

/**
 * The pane header's only two actions: the 对话 ⇄ 轨迹 toggle and "close pane".
 * The toggle is one button that names the view it will switch *to*, so a narrow
 * pane never has to fit a segmented control (ADR-0006).
 */
const viewToggleStyle = {
  ...buttonStyle,
  flex: 'none',
  height: 22,
  padding: '0 8px',
  borderRadius: T.radiusSm,
  background: paint('toggle-bg'),
  color: ink('toggle-fg', T.textSecondary),
  fontSize: 11,
  lineHeight: 1,
}

/** The filled state marks "this pane is on the non-default view". */
const viewToggleActiveStyle = {
  background: T.accentTertiary,
  color: T.accent,
  fontWeight: 500,
}

const headerActionStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 24,
  height: 24,
  padding: 0,
  border: 'none',
  borderRadius: T.radiusSm,
  background: paint('icon-bg'),
  color: ink('icon-fg', T.textTertiary),
  font: 'inherit',
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
  transition: `background-color ${T.fast} ${T.ease}, color ${T.fast} ${T.ease}`,
}

const closeOverlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: T.mask,
  backdropFilter: 'var(--dsw-mask-blur, none)',
}

const closeDialogStyle = {
  width: 440,
  maxWidth: 'calc(100vw - 32px)',
  padding: '20px 22px',
  borderRadius: T.radiusLg,
  border: 'none',
  background: T.layer2,
  color: T.text,
  boxShadow: T.shadowProminent,
  fontSize: 13,
  lineHeight: 1.65,
}

const closeTitleStyle = {
  color: T.textTertiary,
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginBottom: 8,
}

const closeActionsStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 18,
}

const closeErrorStyle = {
  marginTop: 12,
  padding: '8px 10px',
  borderRadius: T.radiusSm,
  background: `color-mix(in srgb, ${T.error} 10%, transparent)`,
  color: T.error,
  fontSize: 12,
  lineHeight: 1.5,
  wordBreak: 'break-word',
}

module.exports = {
  buttonStyle,
  paneStyle,
  workspaceStyle,
  layoutStyle,
  hostStyle,
  hiddenWorkspaceStyle,
  PANE_STRIP_HEIGHT,
  paneStripStyle,
  stripActionGroupStyle,
  stripRightbarStyle,
  stripViewportStyle,
  stripTablistStyle,
  headerSeatStyle,
  stripItemStyle,
  stripTitleStyle,
  stripDotStyle,
  stripCloseStyle,
  stripNewStyle,
  headerStyle,
  titleStyle,
  bodyStyle,
  fallbackStyle,
  emptyStackStyle,
  emptyMarkStyle,
  emptyTitleStyle,
  emptyBodyStyle,
  emptyActionStyle,
  recentHeadingStyle,
  recentListStyle,
  recentRowStyle,
  recentLabelStyle,
  recentDetailStyle,
  recentBadgeStyle,
  hintStyle,
  viewToggleStyle,
  viewToggleActiveStyle,
  headerActionStyle,
  closeOverlayStyle,
  closeDialogStyle,
  closeTitleStyle,
  closeActionsStyle,
  closeErrorStyle,
}