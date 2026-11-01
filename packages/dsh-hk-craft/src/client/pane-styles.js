'use strict'

/**
 * Every static style object the pane view uses.
 *
 * Kept away from `pane-view.js` so the component file reads as rendering logic
 * and so the palette / density can be reviewed in one place. Values are plain
 * React style objects; nothing here imports React or dsh.
 */

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  padding: '2px 8px',
}

const paneStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
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
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
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

/** Strip height (spec §5: 36px, the Agent10 density). */
const PANE_STRIP_HEIGHT = 36

const paneStripStyle = {
  display: 'flex',
  alignItems: 'stretch',
  flex: 'none',
  height: PANE_STRIP_HEIGHT,
  minHeight: PANE_STRIP_HEIGHT,
  minWidth: 0,
  borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  background: 'var(--dsw-alias-bg-base, Canvas)',
  // The action group owns its spacing per seat, so an empty group leaves no box;
  // this keeps a visible last seat clear of the window edge without reserving a
  // group-sized gap when both seats render null.
  paddingRight: 8,
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
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 6,
  padding: 0,
}

/** The `tablist`: the entries only, immediately followed by `+` in the viewport. */
const stripTablistStyle = {
  display: 'flex',
  alignItems: 'stretch',
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
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  maxWidth: 200,
  minWidth: 0,
  height: '100%',
  padding: '0 8px',
  border: 'none',
  // Always reserved, so focusing an entry never changes its width or the row's
  // geometry (ticket 10: status/focus must not shift the strip).
  borderTop: '2px solid transparent',
  borderRight: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  userSelect: 'none',
  // Pointer dragging (not HTML5 DnD) needs the browser not to claim the gesture.
  touchAction: 'none',
}

/** Titles truncate instead of squeezing their neighbours (spec §5). */
const stripTitleStyle = {
  maxWidth: 128,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * A fixed-size dot whose two rings (the strip background and a `currentColor`
 * halo) keep it legible on both the light and the dark palette. Neither ring
 * takes part in layout, and the dot is always rendered — a status change only
 * recolours it, with a cheap transition so the change never reads as a flicker.
 */
const stripDotStyle = {
  flex: 'none',
  width: 7,
  height: 7,
  borderRadius: '50%',
  transition: 'background-color 120ms ease',
  boxShadow:
    '0 0 0 1px var(--dsw-alias-bg-base, Canvas), 0 0 0 2px color-mix(in srgb, currentColor 32%, transparent)',
}

const stripCloseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
}

/**
 * `+` follows the last tab inside the scrollport: it is an ordinary
 * inline button, no longer a full-height, right-aligned slab with a left border.
 */
const stripNewStyle = {
  ...buttonStyle,
  flex: 'none',
  alignSelf: 'center',
  border: 'none',
  borderRadius: 4,
  padding: '2px 8px',
  margin: '0 4px',
}

const headerStyle = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  minHeight: 36,
  padding: '0 10px',
  borderBottom: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
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
  fontWeight: 600,
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
  maxWidth: 520,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1.6,
  boxSizing: 'border-box',
}

const emptyActionStyle = { ...buttonStyle, alignSelf: 'center' }

const recentHeadingStyle = {
  marginTop: 6,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  opacity: 0.6,
  textAlign: 'left',
}

const recentListStyle = { display: 'flex', flexDirection: 'column', gap: 4 }

const recentRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
  borderRadius: 6,
  background: 'color-mix(in srgb, currentColor 4%, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '20px',
  cursor: 'pointer',
  padding: '4px 8px',
  textAlign: 'left',
}

const recentLabelStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const recentDetailStyle = { flex: 'none', opacity: 0.6, fontSize: 11 }

const recentBadgeStyle = {
  flex: 'none',
  fontSize: 10,
  lineHeight: '16px',
  padding: '0 5px',
  borderRadius: 999,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  opacity: 0.8,
}

const hintStyle = {
  marginTop: 6,
  fontSize: 11,
  lineHeight: 1.5,
  opacity: 0.62,
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
  fontSize: 11,
  lineHeight: '18px',
  padding: '1px 8px',
}

/** The filled state marks "this pane is on the non-default view". */
const viewToggleActiveStyle = {
  background: 'color-mix(in srgb, currentColor 16%, transparent)',
  fontWeight: 600,
}

const headerActionStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: 22,
  height: 22,
  padding: 0,
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 5,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
}

const closeOverlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: 'rgba(0, 0, 0, 0.35)',
}

const closeDialogStyle = {
  width: 440,
  maxWidth: 'calc(100vw - 32px)',
  padding: '18px 20px',
  borderRadius: 12,
  border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 16px 40px rgba(0, 0, 0, 0.24)',
  fontSize: 13,
  lineHeight: 1.6,
}

const closeTitleStyle = {
  fontSize: 12,
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginBottom: 6,
}

const closeActionsStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 16,
}

const closeErrorStyle = {
  marginTop: 10,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'color-mix(in srgb, tomato 16%, transparent)',
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
