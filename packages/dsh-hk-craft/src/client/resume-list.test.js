'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeText,
  truncateText,
  isFuzzyMatch,
  formatRelativeTime,
  buildResumeRows,
} = require('./resume-list.js')

/** @returns {(key: string, params?: Record<string, unknown>) => string} */
function fakeT(table = {}) {
  const defaults = {
    'time.justNow': 'just now',
    'time.minutesAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'time.daysAgo': '{n}d ago',
  }
  const merged = { ...defaults, ...table }
  return (key, params) => {
    const template = merged[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }
}

test('normalizeText collapses whitespace and trims', () => {
  assert.equal(normalizeText('  登录页\n\n点击\t提交后 500  '), '登录页 点击 提交后 500')
})

test('normalizeText rejects non-strings as empty', () => {
  assert.equal(normalizeText(undefined), '')
  assert.equal(normalizeText(null), '')
  assert.equal(normalizeText(42), '')
  assert.equal(normalizeText({}), '')
})

test('truncateText leaves text within the budget untouched', () => {
  assert.equal(truncateText('abc', 3), 'abc')
  assert.equal(truncateText('abc', 10), 'abc')
})

test('truncateText marks a cut with an ellipsis inside the budget', () => {
  assert.equal(truncateText('abcdef', 4), 'abc…')
  assert.equal(truncateText('abcdef', 1), '…')
})

test('truncateText counts and cuts by code point, never splitting a surrogate pair', () => {
  const emoji = '😀😀😀😀😀'
  const cut = truncateText(emoji, 3)
  assert.equal(cut, '😀😀…')
  assert.equal(cut.includes('\uD83D'), true)
  assert.equal(cut.includes('\uDE00'), true)
  // No lone surrogate survives truncation.
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false)
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), false)
})

test('truncateText handles CJK without splitting characters', () => {
  assert.equal(truncateText('修复登录页面报错', 5), '修复登录…')
})

test('truncateText normalizes whitespace before measuring', () => {
  assert.equal(truncateText('  a \n b  ', 3), 'a b')
})

test('isFuzzyMatch matches an ordered, case-insensitive subsequence', () => {
  assert.equal(isFuzzyMatch('login', 'Fix login bug'), true)
  assert.equal(isFuzzyMatch('LOGIN', 'Fix login bug'), true)
  assert.equal(isFuzzyMatch('lgn', 'Fix login bug'), true)
  assert.equal(isFuzzyMatch('nig', 'Fix login bug'), false)
})

test('isFuzzyMatch matches CJK text without tokenization', () => {
  assert.equal(isFuzzyMatch('登录', '修复登录页面报错'), true)
  assert.equal(isFuzzyMatch('登录', '修复注册页面报错'), false)
})

test('isFuzzyMatch requires every whitespace-separated token', () => {
  assert.equal(isFuzzyMatch('login 500', 'Fix login 500 error'), true)
  assert.equal(isFuzzyMatch('login 404', 'Fix login 500 error'), false)
  assert.equal(isFuzzyMatch('  登录   500  ', '登录页 500 错误'), true)
})

test('isFuzzyMatch treats a blank query as matching everything', () => {
  assert.equal(isFuzzyMatch('', 'anything'), true)
  assert.equal(isFuzzyMatch('   ', 'anything'), true)
  assert.equal(isFuzzyMatch('', ''), true)
})

test('isFuzzyMatch does not match a query against missing text', () => {
  assert.equal(isFuzzyMatch('x', ''), false)
  assert.equal(isFuzzyMatch('x', undefined), false)
  assert.equal(isFuzzyMatch('x', null), false)
})

test('formatRelativeTime reports just-now, minutes, hours, and days', () => {
  const t = fakeT()
  const now = Date.UTC(2026, 9, 30, 12, 0, 0)
  assert.equal(formatRelativeTime(now - 5_000, now, t), 'just now')
  assert.equal(formatRelativeTime(now - 5 * 60_000, now, t), '5m ago')
  assert.equal(formatRelativeTime(now - 90 * 60_000, now, t), '1h ago')
  assert.equal(formatRelativeTime(now - 50 * 3_600_000, now, t), '2d ago')
})

test('formatRelativeTime floors partial units and tolerates clock skew', () => {
  const t = fakeT()
  const now = Date.UTC(2026, 9, 30, 12, 0, 0)
  assert.equal(formatRelativeTime(now - 119_000, now, t), '1m ago')
  assert.equal(formatRelativeTime(now + 90_000, now, t), 'just now')
})

test('formatRelativeTime is empty for a missing activity time', () => {
  const t = fakeT()
  const now = Date.UTC(2026, 9, 30, 12, 0, 0)
  assert.equal(formatRelativeTime(0, now, t), '')
  assert.equal(formatRelativeTime(undefined, now, t), '')
  assert.equal(formatRelativeTime(Number.NaN, now, t), '')
})

/** One conversation row as the sessions adapter hands it over. */
function row(overrides = {}) {
  return {
    sessionId: 's1',
    workspaceId: 'w1',
    title: '',
    firstPrompt: '',
    updatedAt: 1_000,
    running: false,
    blank: false,
    archived: false,
    ...overrides,
  }
}

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)
const labels = {
  'session.untitled': 'Untitled conversation',
  'badge.running': 'running',
}
const t = fakeT(labels)

test('buildResumeRows returns an empty list for empty input', () => {
  assert.deepEqual(buildResumeRows([], { workspaceId: 'w1', now: NOW, t }), [])
})

test('buildResumeRows drops blank and archived conversations', () => {
  const rows = buildResumeRows(
    [
      row({ sessionId: 'keep', title: 'Keep me' }),
      row({ sessionId: 'blank', title: 'Blank', blank: true }),
      row({ sessionId: 'archived', title: 'Archived', archived: true }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.deepEqual(rows.map((entry) => entry.id), ['keep'])
})

test('buildResumeRows only lists the requested workspace', () => {
  const rows = buildResumeRows(
    [
      row({ sessionId: 'mine', title: 'Mine', workspaceId: 'w1' }),
      row({ sessionId: 'theirs', title: 'Theirs', workspaceId: 'w2' }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.deepEqual(rows.map((entry) => entry.id), ['mine'])
})

test('buildResumeRows orders by newest activity first', () => {
  const rows = buildResumeRows(
    [
      row({ sessionId: 'old', title: 'Old', updatedAt: 1_000 }),
      row({ sessionId: 'new', title: 'New', updatedAt: 3_000 }),
      row({ sessionId: 'mid', title: 'Mid', updatedAt: 2_000 }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.deepEqual(rows.map((entry) => entry.id), ['new', 'mid', 'old'])
})

test('buildResumeRows breaks activity-time ties deterministically by session id', () => {
  const forward = buildResumeRows(
    [
      row({ sessionId: 'b', title: 'B', updatedAt: 5_000 }),
      row({ sessionId: 'a', title: 'A', updatedAt: 5_000 }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  const reverse = buildResumeRows(
    [
      row({ sessionId: 'a', title: 'A', updatedAt: 5_000 }),
      row({ sessionId: 'b', title: 'B', updatedAt: 5_000 }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.deepEqual(forward.map((entry) => entry.id), ['a', 'b'])
  assert.deepEqual(reverse.map((entry) => entry.id), ['a', 'b'])
})

test('buildResumeRows marks running conversations without reordering them', () => {
  const rows = buildResumeRows(
    [
      row({ sessionId: 'running', title: 'Running', running: true, updatedAt: 1_000 }),
      row({ sessionId: 'idle', title: 'Idle', updatedAt: 2_000 }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.deepEqual(rows.map((entry) => entry.id), ['idle', 'running'])
  assert.equal(rows[0].badge, undefined)
  assert.equal(rows[1].badge, 'running')
})

test('buildResumeRows shows the title when there is one', () => {
  const rows = buildResumeRows([row({ title: 'Fix login bug', firstPrompt: 'ignored prompt' })], {
    workspaceId: 'w1',
    now: NOW,
    t,
  })
  assert.match(rows[0].label, /^Fix login bug/u)
})

test('buildResumeRows keeps the first prompt in the label so it stays searchable', () => {
  const rows = buildResumeRows([row({ title: 'Fix login bug', firstPrompt: '登录页点击提交后报 500' })], {
    workspaceId: 'w1',
    now: NOW,
    t,
  })
  assert.equal(rows[0].label, 'Fix login bug · 登录页点击提交后报 500')
})

test('buildResumeRows does not repeat a prompt that equals the title', () => {
  const rows = buildResumeRows([row({ title: 'Fix login bug', firstPrompt: 'Fix login bug' })], {
    workspaceId: 'w1',
    now: NOW,
    t,
  })
  assert.equal(rows[0].label, 'Fix login bug')
})

test('buildResumeRows falls back to the truncated first prompt without a title', () => {
  const rows = buildResumeRows([row({ firstPrompt: 'a'.repeat(120) })], {
    workspaceId: 'w1',
    now: NOW,
    t,
  })
  assert.equal(Array.from(rows[0].label).length, 48)
  assert.equal(rows[0].label.endsWith('…'), true)
})

test('buildResumeRows falls back to the placeholder without title and prompt', () => {
  const rows = buildResumeRows([row({ title: '   ', firstPrompt: undefined })], {
    workspaceId: 'w1',
    now: NOW,
    t,
  })
  assert.equal(rows[0].label, 'Untitled conversation')
})

test('buildResumeRows truncates a long title without splitting a surrogate pair', () => {
  const rows = buildResumeRows([row({ title: '😀'.repeat(200) })], {
    workspaceId: 'w1',
    now: NOW,
    t,
  })
  assert.equal(Array.from(rows[0].label).length, 80)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(rows[0].label), false)
})

test('buildResumeRows shows the activity age as detail and tolerates a missing time', () => {
  const rows = buildResumeRows(
    [
      row({ sessionId: 'aged', title: 'Aged', updatedAt: NOW - 5 * 60_000 }),
      row({ sessionId: 'unknown', title: 'Unknown', updatedAt: 0 }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.equal(rows[0].detail, '5m ago')
  assert.equal('detail' in rows[1], false)
})

test('buildResumeRows filters by title, first prompt, and subsequence', () => {
  const conversations = [
    row({ sessionId: 'a', title: 'Fix login bug', firstPrompt: '登录页点击提交后报 500' }),
    row({ sessionId: 'b', title: 'Write docs', firstPrompt: 'README update' }),
  ]
  const byTitle = buildResumeRows(conversations, { workspaceId: 'w1', now: NOW, t, query: 'login' })
  const byPrompt = buildResumeRows(conversations, { workspaceId: 'w1', now: NOW, t, query: '500' })
  const bySubsequence = buildResumeRows(conversations, { workspaceId: 'w1', now: NOW, t, query: 'fx lgn' })
  const byTwoTokens = buildResumeRows(conversations, { workspaceId: 'w1', now: NOW, t, query: 'fix 500' })
  assert.deepEqual(byTitle.map((entry) => entry.id), ['a'])
  assert.deepEqual(byPrompt.map((entry) => entry.id), ['a'])
  assert.deepEqual(bySubsequence.map((entry) => entry.id), ['a'])
  assert.deepEqual(byTwoTokens.map((entry) => entry.id), ['a'])
})

test('buildResumeRows returns an empty list when the query matches nothing', () => {
  const rows = buildResumeRows([row({ title: 'Fix login bug' })], {
    workspaceId: 'w1',
    now: NOW,
    t,
    query: 'zzz',
  })
  assert.deepEqual(rows, [])
})

test('buildResumeRows tolerates malformed rows', () => {
  const rows = buildResumeRows(
    [
      row({ sessionId: undefined }),
      row({ sessionId: 'odd', title: 42, firstPrompt: null, updatedAt: 'yesterday' }),
    ],
    { workspaceId: 'w1', now: NOW, t },
  )
  assert.deepEqual(rows.map((entry) => entry.id), ['odd'])
  assert.equal(rows[0].label, 'Untitled conversation')
})
