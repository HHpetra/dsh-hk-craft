'use strict'

/**
 * The handful of dsh design tokens this plugin's surfaces read.
 *
 * The token sheets shipped by `@deepseek-ai/dsh-client-ui-theme` are the colour
 * authority for the Web client; this module only names the roles the pane UI
 * needs and gives each one a neutral fallback so a trimmed shell or a unit test
 * still renders something sane. Nothing here invents a palette: every literal
 * is either the documented fallback of a token or a neutral canvas keyword.
 *
 * Keep this file dependency-free. `pane-styles.js` and `visuals.js` both import
 * it, and `visuals.js` is also read by the throwaway preview harness.
 */

const T = Object.freeze({
  // Surfaces
  surface: 'var(--dsw-alias-bg-base, Canvas)',
  layer1: 'var(--dsw-alias-bg-layer-1, Canvas)',
  layer2: 'var(--dsw-alias-bg-layer-2, Canvas)',
  layer3: 'var(--dsw-alias-bg-layer-3, Canvas)',
  module: 'var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 6%, transparent))',
  sidebar: 'var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, Canvas))',
  menu: 'var(--dsw-specific-menu, var(--dsw-menu-surface-fill, Canvas))',
  mask: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24))',
  input: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-base, Canvas))',

  // Text
  text: 'var(--dsw-alias-label-primary, CanvasText)',
  textSecondary: 'var(--dsw-alias-label-secondary, currentColor)',
  textTertiary: 'var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 70%, transparent))',
  textCaption: 'var(--dsw-alias-label-caption, color-mix(in srgb, currentColor 55%, transparent))',
  textOnAccent: 'var(--dsw-alias-label-primary-foreground, #ffffff)',

  // Borders and interaction
  border1: 'var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 6%, transparent))',
  border2: 'var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 10%, transparent))',
  border3: 'var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 16%, transparent))',
  border4: 'var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 24%, transparent))',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
  hoverSolid: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, 0.16))',
  hoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.06))',

  // Semantic states
  accent: 'var(--dsw-alias-state-business-primary, Highlight)',
  accentTertiary: 'var(--dsw-alias-state-business-tertiary, color-mix(in srgb, Highlight 14%, transparent))',
  success: 'var(--dsw-alias-state-success-primary, #22c55e)',
  warn: 'var(--dsw-alias-state-warn-primary, #d9a400)',
  error: 'var(--dsw-alias-state-error-primary, #e5484d)',
  errorTertiary: 'var(--dsw-alias-state-error-secondary, #f25a5a)',
  focusRing: 'var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight))',
  focusWidth: 'var(--dsw-focus-ring-width, 2px)',

  // Shape, elevation, motion, type
  radiusXs: 'var(--dsw-radius-xs, 4px)',
  radiusSm: 'var(--dsw-radius-sm, 8px)',
  radiusMd: 'var(--dsw-radius-md, 12px)',
  radiusLg: 'var(--dsw-radius-lg, 16px)',
  radiusXl: 'var(--dsw-radius-xl, 20px)',
  radiusPanel: 'var(--dsw-radius-panel, 28px)',
  shadowPanel:
    'var(--dsw-elevation-panel, 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 3px 8px rgba(0, 0, 0, 0.03), 0 0 16px rgba(0, 0, 0, 0.02))',
  shadowProminent:
    'var(--dsw-elevation-prominent, 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05))',
  font: 'var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif)',
  fontCode: 'var(--ds-font-family-code, "SF Mono", Consolas, monospace)',
  ease: 'var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1))',
  fast: 'var(--ds-transition-duration-fast, 0.1s)',
  normal: 'var(--ds-transition-duration, 0.2s)',
})

/**
 * A background that a stylesheet can repaint without fighting an inline style.
 *
 * Every dynamic fill in `pane-styles.js` reads a `--hk-*-bg` custom property;
 * the global sheet then flips that property on hover, focus and active states.
 * Inline declarations still win over stylesheet declarations, but a custom
 * property has no such contest, so both layers stay composable.
 *
 * @param {string} name custom property name, without the leading `--`
 * @param {string} fallback used when no rule sets the property
 * @returns {string}
 */
function paint(name, fallback = 'transparent') {
  return `var(--hk-${name}, ${fallback})`
}

/**
 * A colour that a stylesheet can repaint the same way as `paint`.
 *
 * @param {string} name custom property name, without the leading `--`
 * @param {string} fallback resolved CSS colour
 * @returns {string}
 */
function ink(name, fallback = T.text) {
  return `var(--hk-${name}, ${fallback})`
}

module.exports = { T, paint, ink }