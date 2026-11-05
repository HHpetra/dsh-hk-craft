'use strict'

/**
 * The three pure path helpers a pane drop uses to build a reference chip.
 *
 * Copied from the 0.2.2-rc.1 train so a drop formats the same text dsh's own
 * composer would (`docs/upstream-contracts.md#document-file-drop-and-per-pane-routing`):
 *
 * - `relativizeToCwd` and `workspaceTitleOf` from `@deepseek-ai/dsh-util-workspace-path`
 * - `formatFileMention` from `@deepseek-ai/dsh-file-reference/grammar`
 *
 * The directory chip calls `formatFileMention` with `kind: 'file'` and a
 * trailing slash already on the path, the same call the composer makes, so a
 * finished directory closes its quotes instead of leaving them open for drill.
 */

/**
 * Strip the workspace root from a workspace-rooted absolute path (display only).
 *
 * @param {string} text the path to shorten
 * @param {string|undefined} cwd session workspace root; absent or empty leaves the path unchanged
 * @returns {string} the path relative to the workspace root, or unchanged when it is not rooted there
 */
function relativizeToCwd(text, cwd) {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/**
 * Read the final non-empty segment of a workspace path for display.
 *
 * @param {string} path workspace directory path using POSIX or Windows separators
 * @returns {string} the final segment, or an empty string for a separator-only path
 */
function workspaceTitleOf(path) {
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * Format a selected path as prompt text.
 *
 * Whitespace uses the quoted `@"path"` grammar. A quoted directory keeps that
 * quote open after its trailing slash so completion can descend another level.
 * A path the editor grammar cannot represent safely returns `undefined`.
 *
 * @param {{path: string, kind: string}} candidate selected file or directory
 * @param {boolean} preserveQuote retain an explicitly opened quote even when unnecessary
 * @returns {string|undefined}
 */
function formatFileMention(candidate, preserveQuote) {
  const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const quoted = preserveQuote || /\s/u.test(path)
  if (!quoted) return `@${path}`
  if (candidate.kind === 'directory') return `@"${path}`
  return `@"${path}"`
}

module.exports = {
  relativizeToCwd,
  workspaceTitleOf,
  formatFileMention,
}
