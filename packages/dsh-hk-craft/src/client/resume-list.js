'use strict'

/**
 * Pure list construction for `/resume`.
 *
 * The dsh popup shell owns rendering, keyboard handling, and the local search
 * filter; this module owns everything that decides *what the list contains*:
 * workspace / blank / archived filtering, newest-activity-first ordering, the
 * title → first-prompt → placeholder fallback, truncation, and the fuzzy text
 * a query is matched against. Keeping it free of dsh objects is what makes the
 * behaviour testable in Node.
 */

/** Default character budgets (counted in Unicode code points). */
const LIMITS = Object.freeze({
  title: 80,
  prompt: 48,
  label: 140,
})

/**
 * Collapse every whitespace run to one space and trim the result.
 *
 * @param {unknown} value raw title or prompt text
 * @returns {string} one-line normalized text, or '' for non-strings
 */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * Truncate to a Unicode-code-point budget, appending '…' when text is lost.
 *
 * `Array.from` splits on code points, so surrogate pairs (emoji) and CJK
 * characters are never cut in half.
 *
 * @param {unknown} value raw text
 * @param {number} maxChars positive code-point budget, ellipsis included
 * @returns {string} normalized, possibly truncated text
 */
function truncateText(value, maxChars) {
  const text = normalizeText(value)
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : LIMITS.label
  const chars = Array.from(text)
  if (chars.length <= budget) return text
  return `${chars.slice(0, budget - 1).join('')}…`
}

/**
 * Split a query into whitespace-delimited tokens.
 *
 * @param {unknown} query raw search text
 * @returns {string[]} lowercased tokens
 */
function queryTokens(query) {
  if (typeof query !== 'string') return []
  return query.trim().toLowerCase().split(/\s+/u).filter((token) => token !== '')
}

/**
 * Whether every query token is an ordered, case-insensitive subsequence of
 * `text`. This is the same matching family as dsh's `/` menu fuzzy ranking
 * (subsequence, not substring), extended to all whitespace-delimited tokens so
 * "login 500" matches "fix login 500 error".
 *
 * @param {unknown} query shell search text
 * @param {unknown} text candidate text
 * @returns {boolean}
 */
function isFuzzyMatch(query, text) {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return true
  if (typeof text !== 'string' || text === '') return false
  const haystack = Array.from(text.toLowerCase())
  return tokens.every((token) => {
    let cursor = 0
    for (const char of token) {
      const found = haystack.indexOf(char, cursor)
      if (found === -1) return false
      cursor = found + 1
    }
    return true
  })
}

/**
 * Compact "age of the last activity" label.
 *
 * @param {unknown} updatedAt epoch milliseconds of the last durable activity
 * @param {number} now epoch milliseconds used as the reference
 * @param {(key: string, params?: Record<string, unknown>) => string} t translator
 * @returns {string} localized age, or '' when there is no usable timestamp
 */
function formatRelativeTime(updatedAt, now, t) {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return ''
  const elapsed = Math.max(0, now - updatedAt)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return t('time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { n: hours })
  return t('time.daysAgo', { n: Math.floor(hours / 24) })
}

/**
 * Compare two normalized conversation rows: newest durable activity first,
 * session id ascending as the deterministic tie-break.
 *
 * @param {{updatedAt: number, sessionId: string}} left
 * @param {{updatedAt: number, sessionId: string}} right
 * @returns {number}
 */
function compareConversations(left, right) {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.sessionId < right.sessionId) return -1
  if (left.sessionId > right.sessionId) return 1
  return 0
}

/**
 * Build the `/resume` option rows from raw conversation data.
 *
 * Filtering (workspace, blank, archived), ordering, the title → first prompt →
 * placeholder fallback, truncation, and the query filter all live here so the
 * behaviour is testable without the popup shell.
 *
 * The label is the searchable text: dsh's `fuzzy-label` popup mode ranks
 * `option.label` only (verified in `dsh-client-ui-commands`,
 * `lib/client.js:1026-1036`), so when a conversation has both a durable title
 * and a first prompt the prompt excerpt is folded into the label. `detail`
 * carries the activity age. `badge` marks a running conversation without
 * affecting the order.
 *
 * @param {object[]} conversations raw rows from the sessions adapter
 * @param {object} options
 * @param {string} [options.workspaceId] only list this workspace when present
 * @param {number} [options.now] reference time for the age label
 * @param {(key: string, params?: Record<string, unknown>) => string} options.t translator
 * @param {unknown} [options.query] local search text (shell filters too)
 * @param {typeof LIMITS} [options.limits] character budgets
 * @returns {{id: string, sessionId: string, label: string, detail?: string, badge?: string}[]}
 */
function buildResumeRows(conversations, options = {}) {
  const { workspaceId, now = Date.now(), t, query = '', limits = LIMITS } = options
  if (!Array.isArray(conversations)) return []

  const ordered = []
  for (const conversation of conversations) {
    if (conversation === null || typeof conversation !== 'object') continue
    const sessionId = conversation.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (workspaceId !== undefined && conversation.workspaceId !== workspaceId) continue
    if (conversation.blank === true || conversation.archived === true) continue
    ordered.push({
      sessionId,
      title: normalizeText(conversation.title),
      prompt: normalizeText(conversation.firstPrompt),
      updatedAt:
        typeof conversation.updatedAt === 'number' && Number.isFinite(conversation.updatedAt)
          ? conversation.updatedAt
          : 0,
      running: conversation.running === true,
    })
  }
  ordered.sort(compareConversations)

  const rows = []
  for (const entry of ordered) {
    const title = truncateText(entry.title, limits.title)
    const prompt = truncateText(entry.prompt, limits.prompt)
    let label
    if (title !== '') {
      label = prompt !== '' && entry.prompt !== entry.title ? `${title} · ${prompt}` : title
    } else {
      label = prompt !== '' ? prompt : t('session.untitled')
    }
    label = truncateText(label, limits.label)
    const detail = formatRelativeTime(entry.updatedAt, now, t)
    if (query !== '' && !isFuzzyMatch(query, label) && !isFuzzyMatch(query, detail)) continue
    rows.push({
      id: entry.sessionId,
      sessionId: entry.sessionId,
      label,
      ...(detail === '' ? {} : { detail }),
      ...(entry.running ? { badge: t('badge.running') } : {}),
    })
  }
  return rows
}

module.exports = {
  LIMITS,
  normalizeText,
  truncateText,
  isFuzzyMatch,
  formatRelativeTime,
  buildResumeRows,
}
