'use strict'

/**
 * The plugin's one global stylesheet and its installer.
 *
 * `pane-styles.js` owns geometry and the resting look. This sheet owns every
 * rule that needs a pseudo-class or an animation: hover, focus-visible,
 * disabled, active indications, dialog entrances and the running pulse. It is
 * scoped exclusively to this plugin's `data-hkcraft-*` markers so it can never
 * leak into the shell's own surfaces.
 *
 * The sheet reads the same dsh semantic tokens as the inline styles. Nothing
 * here introduces a palette; accents, borders, masks and elevations all come
 * from `--dsw-*` with the token sheet's own neutral fallback.
 *
 * Installation is idempotent and disposal removes the element, so a plugin
 * reload never stacks duplicate sheets.
 */

const STYLE_ELEMENT_ID = 'dsh-hk-craft-visual-styles'

const PLUGIN_STYLESHEET = String.raw`
/* ------------------------------------------------------------------ */
/* Shared controls                                                     */
/* ------------------------------------------------------------------ */

[data-hkcraft] button,
[data-hkcraft-pane] button,
[data-hkcraft-pane-strip] button,
[data-hkcraft-subagent-menu] button,
[data-hkcraft-dialog] button,
[data-hkcraft-workspace-delete-dialog] button {
  -webkit-tap-highlight-color: transparent;
}

[data-hkcraft] button:focus-visible,
[data-hkcraft-pane] button:focus-visible,
[data-hkcraft-empty] button:focus-visible,
[data-hkcraft-pane-strip] button:focus-visible,
[data-hkcraft-pane-strip] [role='tab']:focus-visible,
[data-hkcraft-subagent-menu] button:focus-visible,
[data-hkcraft-dialog] button:focus-visible,
[data-hkcraft-workspace-delete-dialog] button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight));
  outline-offset: 1px;
}

[data-hkcraft] button:disabled,
[data-hkcraft-pane] button:disabled,
[data-hkcraft-pane-strip] button:disabled,
[data-hkcraft="settings"] button:disabled {
  opacity: 0.45;
  cursor: default;
}

[data-hkcraft] .hk-button:hover:not(:disabled),
[data-hkcraft-empty] .hk-button:hover:not(:disabled),
[data-hkcraft-dialog] .hk-button:hover:not(:disabled),
[data-hkcraft-workspace-delete-dialog] .hk-button:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-interactive-bg-hover);
}

[data-hkcraft] .hk-button--primary,
[data-hkcraft-empty] .hk-button--primary,
[data-hkcraft-dialog] .hk-button--primary,
[data-hkcraft-workspace-delete-dialog] .hk-button--primary {
  --hk-button-bg: var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #4176e6));
  --hk-button-fg: var(--dsw-alias-label-primary-foreground, #ffffff);
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.06));
}

[data-hkcraft] .hk-button--primary:hover:not(:disabled),
[data-hkcraft-empty] .hk-button--primary:hover:not(:disabled),
[data-hkcraft-dialog] .hk-button--primary:hover:not(:disabled),
[data-hkcraft-workspace-delete-dialog] .hk-button--primary:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-button-info-hover, var(--dsw-alias-state-business-primary, #5686fe));
}

[data-hkcraft] .hk-button--danger,
[data-hkcraft-dialog] .hk-button--danger,
[data-hkcraft-workspace-delete-dialog] .hk-button--danger {
  --hk-button-bg: var(--dsw-alias-state-error-primary, #e5484d);
  --hk-button-fg: var(--dsw-alias-label-primary-foreground, #ffffff);
}

[data-hkcraft] .hk-button--danger:hover:not(:disabled),
[data-hkcraft-dialog] .hk-button--danger:hover:not(:disabled),
[data-hkcraft-workspace-delete-dialog] .hk-button--danger:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-state-error-secondary, #f25a5a);
}

[data-hkcraft] .hk-button--quiet,
[data-hkcraft-dialog] .hk-button--quiet,
[data-hkcraft-workspace-delete-dialog] .hk-button--quiet {
  --hk-button-bg: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-1, transparent));
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.1));
  font-weight: 500;
}

[data-hkcraft] .hk-button--quiet:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary, CanvasText);
}

/* ------------------------------------------------------------------ */
/* Sidebar workspace section                                           */
/* ------------------------------------------------------------------ */

[data-hkcraft="workspaces"] {
  color: var(--dsw-alias-label-primary, CanvasText);
  font-family: var(--dsw-font-family, inherit);
}

[data-hkcraft-workspace-row] {
  height: 34px !important;
  border-radius: var(--dsw-radius-md, 12px) !important;
  transition: background-color var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft-workspace-row]:hover,
[data-hkcraft-workspace-row]:focus-within {
  --hk-row-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

[data-hkcraft-workspace-row][data-hkcraft-workspace-current="true"] {
  --hk-row-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

[data-hkcraft-workspace-row] [data-hkcraft-workspace-delete] {
  border-radius: var(--dsw-radius-xs, 4px);
  color: var(--dsw-alias-label-tertiary, currentColor);
  transition:
    opacity var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft-workspace-row] [data-hkcraft-workspace-delete]:hover {
  --hk-icon-bg: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.06));
  color: var(--dsw-alias-state-error-primary, #e5484d) !important;
}

[data-hkcraft="workspaces"] button[data-hkcraft-workspace-add] {
  border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-tertiary, currentColor);
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft="workspaces"] button[data-hkcraft-workspace-add]:hover:not(:disabled) {
  --hk-row-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --hk-button-fg: var(--dsw-alias-label-secondary, currentColor);
}

/* ------------------------------------------------------------------ */
/* Strip: tabs, add, right-bar tools                                   */
/* ------------------------------------------------------------------ */

[data-hkcraft-pane-strip] {
  font-family: var(--dsw-font-family, inherit);
}

[data-hkcraft-strip-item] {
  color: var(--hk-tab-fg, var(--dsw-alias-label-secondary, currentColor));
}

[data-hkcraft-strip-item]:hover {
  --hk-tab-bg: color-mix(in srgb, currentColor 7%, transparent);
  --hk-tab-fg: var(--dsw-alias-label-primary, CanvasText);
}

[data-hkcraft-strip-item][data-hkcraft-strip-active="true"] {
  --hk-tab-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --hk-tab-fg: var(--dsw-alias-label-primary, CanvasText);
}

/* The active mark is a short accent rule under the tab, like a native view tab. */
[data-hkcraft-strip-item]::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 2px;
  width: 14px;
  height: 2px;
  border-radius: 2px;
  background: transparent;
  transform: translateX(-50%);
  transition: background-color var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
  pointer-events: none;
}

[data-hkcraft-strip-item][data-hkcraft-strip-active="true"]::after {
  background: var(--dsw-alias-state-business-primary, Highlight);
}

[data-hkcraft-strip-item] [data-hkcraft-strip-close]:hover {
  --hk-icon-bg: color-mix(in srgb, currentColor 14%, transparent);
  --hk-icon-fg: var(--dsw-alias-label-primary, CanvasText);
}

[data-hkcraft-strip-new]:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --hk-button-fg: var(--dsw-alias-label-primary, CanvasText);
}

[data-hkcraft-strip-new][data-hkcraft-strip-budget="true"] {
  opacity: 0.45;
  cursor: default;
}

[data-hkcraft-strip-actions] button:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --hk-button-fg: var(--dsw-alias-label-primary, CanvasText);
}

[data-hkcraft-strip-actions] button[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

/* ------------------------------------------------------------------ */
/* Pane frame and header                                               */
/* ------------------------------------------------------------------ */

[data-hkcraft-pane] {
  transition: box-shadow var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft-pane] > [data-hkcraft-pane-header] {
  border-bottom-color: var(--dsw-alias-border-l2);
}

[data-hkcraft-pane][data-hkcraft-pane-active="true"] > [data-hkcraft-pane-header] {
  --hk-header-bg:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--dsw-alias-state-business-primary, Highlight) 5%, transparent),
      transparent 100%
    ),
    var(--dsw-alias-bg-base, Canvas);
}

[data-hkcraft-pane] [data-hkcraft-pane-header] button[data-hkcraft-pane-close]:hover {
  --hk-icon-bg: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.08));
  --hk-icon-fg: var(--dsw-alias-state-error-primary, #e5484d);
}

[data-hkcraft-pane] [data-hkcraft-view-toggle]:hover {
  --hk-toggle-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --hk-toggle-fg: var(--dsw-alias-label-primary, CanvasText);
}

[data-hkcraft-pane] [data-hkcraft-view-toggle][data-hkcraft-view-toggle="trajectory"] {
  --hk-toggle-bg: var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.12));
  --hk-toggle-fg: var(--dsw-alias-state-business-primary, Highlight);
}

[data-hkcraft-pane-mode] {
  transition: background-color var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft-pane-subagents] > button:hover {
  --hk-button-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  --hk-button-fg: var(--dsw-alias-label-primary, CanvasText);
}

[data-hkcraft-subagent-running] {
  animation: hk-pulse 1.6s ease-in-out infinite;
}

/* ------------------------------------------------------------------ */
/* File drop on the pane under the pointer                            */
/* ------------------------------------------------------------------ */

[data-hkcraft-pane][data-hkcraft-drop] > [data-hkcraft-drop-overlay] {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  pointer-events: none;
  border: 1.5px dashed var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 78%, transparent);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  padding: 16px;
}

[data-hkcraft-pane][data-hkcraft-drop="none"] {
  cursor: not-allowed;
}

[data-hkcraft-pane][data-hkcraft-drop="none"] > [data-hkcraft-drop-overlay] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-secondary);
  cursor: not-allowed;
}

/* ------------------------------------------------------------------ */
/* Separators                                                          */
/* ------------------------------------------------------------------ */

[data-hkcraft-separator] {
  transition: background-color var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft-separator]::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 24px;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary, Highlight);
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
  pointer-events: none;
}

[data-hkcraft-separator][aria-orientation="horizontal"]::after {
  width: 24px;
  height: 2px;
}

[data-hkcraft-separator]:hover::after {
  opacity: 0.85;
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

[data-hkcraft-empty] {
  font-family: var(--dsw-font-family, inherit);
}

[data-hkcraft-empty] [data-hkcraft-empty-recent] button:hover {
  --hk-row-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  border-color: var(--dsw-alias-border-l3);
}

[data-hkcraft-empty] [data-hkcraft-empty-recent] button:active {
  --hk-row-bg: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.16));
}

[data-hkcraft-empty] [data-hkcraft-empty-error] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

[data-hkcraft-dialog],
[data-hkcraft-workspace-delete-dialog] {
  animation: hk-dialog-in 160ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft-dialog] button,
[data-hkcraft-workspace-delete-dialog] button {
  min-width: 76px;
  height: 30px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--hk-button-bg, transparent);
  color: var(--hk-button-fg, inherit);
}

[data-hkcraft-dialog] button:hover:not(:disabled),
[data-hkcraft-workspace-delete-dialog] button:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

[data-hkcraft-dialog] button.hk-button--danger:hover:not(:disabled),
[data-hkcraft-workspace-delete-dialog] button.hk-button--danger:hover:not(:disabled) {
  --hk-button-bg: var(--dsw-alias-state-error-secondary, #f25a5a);
}

[data-hkcraft-workspace-delete-dialog] [data-hkcraft-delete-running] {
  color: var(--dsw-alias-state-warn-label, #b45309);
  background: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.14));
}

/* ------------------------------------------------------------------ */
/* Settings page                                                       */
/* ------------------------------------------------------------------ */

[data-hkcraft="settings"] {
  color: var(--dsw-alias-label-primary, CanvasText);
  font-family: var(--dsw-font-family, inherit);
}

[data-hkcraft="settings"] h2 {
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
  letter-spacing: -0.01em;
}

[data-hkcraft="settings"] h3 {
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}

[data-hkcraft="settings"] h4 {
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}

[data-hkcraft="settings"] section {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  padding-top: 16px;
}

[data-hkcraft="settings"] section:first-of-type {
  border-top: none;
}

[data-hkcraft="settings"] label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-state-business-primary, Highlight);
  cursor: pointer;
}

[data-hkcraft="settings"] input[type="number"] {
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base, Canvas));
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16));
  transition: border-color var(--ds-transition-duration-fast, 0.1s)
    var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-hkcraft="settings"] input[type="number"]:focus {
  border-color: var(--dsw-alias-state-business-primary, Highlight);
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.18));
}

[data-hkcraft="settings"] [data-hkcraft-settings-rows] > * {
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}

[data-hkcraft="settings"] [data-hkcraft-settings-rows] > *:last-child {
  border-bottom: none;
}

[data-hkcraft="settings"] [data-hkcraft-settings-status] {
  color: var(--dsw-alias-state-success-primary, #22c55e);
  font-weight: 500;
}

[data-hkcraft="settings"] [data-hkcraft-settings-diagnostic="entry"] [data-hkcraft-diagnostic-value] {
  font-family: var(--ds-font-family-code, Consolas, monospace);
  font-size: 12px;
}

[data-hkcraft="settings"] [data-hkcraft-settings-diagnostic="loaded"] [data-hkcraft-diagnostic-value] {
  color: var(--dsw-alias-state-success-primary, #22c55e);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  font-weight: 500;
}

[data-hkcraft="settings"] [role="alert"] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
  background: color-mix(
    in srgb,
    var(--dsw-alias-state-error-primary, #e5484d) 9%,
    transparent
  );
}

/* ------------------------------------------------------------------ */
/* Subagent menu                                                       */
/* ------------------------------------------------------------------ */

[data-hkcraft-subagent-menu] {
  animation: hk-menu-in 120ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
  border: none !important;
  box-shadow: var(--dsw-elevation-prominent, 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05)) !important;
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
}

[data-hkcraft-subagent-menu] button:hover {
  --hk-row-bg: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

[data-hkcraft-subagent-menu] [data-hkcraft-subagent-activity="running"] {
  color: var(--dsw-alias-state-warn-label, #b45309);
}

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

@keyframes hk-dialog-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes hk-menu-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes hk-pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 currentColor;
  }
  50% {
    opacity: 0.55;
    box-shadow: 0 0 0 3px transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-hkcraft-dialog],
  [data-hkcraft-workspace-delete-dialog],
  [data-hkcraft-subagent-menu],
  [data-hkcraft-subagent-running] {
    animation: none;
  }

  [data-hkcraft-workspace-row],
  [data-hkcraft-strip-item],
  [data-hkcraft-pane],
  [data-hkcraft-separator] {
    transition: none;
  }
}
`

/**
 * Install the stylesheet once per document.
 *
 * Returns a disposer that removes only the element this call created. A
 * previous copy left behind by another plugin instance is left alone; the
 * element id is still used so a diagnostics reader can find one sheet.
 *
 * @param {Document|undefined|null} documentRef
 * @returns {() => void} teardown; a no-op outside a browser
 */
function installPluginStyles(documentRef) {
  if (
    documentRef === null ||
    documentRef === undefined ||
    typeof documentRef.createElement !== 'function' ||
    typeof documentRef.head?.appendChild !== 'function'
  ) {
    return () => {}
  }

  const existing = documentRef.getElementById?.(STYLE_ELEMENT_ID)
  if (existing !== null && existing !== undefined) return () => {}

  const element = documentRef.createElement('style')
  element.id = STYLE_ELEMENT_ID
  element.setAttribute('data-hkcraft-styles', '')
  element.textContent = PLUGIN_STYLESHEET
  documentRef.head.appendChild(element)

  return () => {
    if (typeof element.remove === 'function') {
      element.remove()
      return
    }
    element.parentNode?.removeChild?.(element)
  }
}

module.exports = { STYLE_ELEMENT_ID, PLUGIN_STYLESHEET, installPluginStyles }