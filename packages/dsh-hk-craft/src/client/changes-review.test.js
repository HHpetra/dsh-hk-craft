'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { changesReviewSessionId, installChangesReviewRoute } = require('./changes-review.js')

/**
 * The card writes the pane session into the review address. The right bar
 * starts on a different session, which is the split-view failure.
 *
 * @param {{ mounted?: string|null, ready?: boolean, openSession?: (id: string) => void }} [options]
 */
function reviewBar(options = {}) {
  let mounted = options.mounted === undefined ? 'shell-current' : options.mounted
  let ready = options.ready !== false
  const opened = []
  const calls = []
  const sidebarRight = {
    mounted: { getSnapshot: () => mounted },
    openResource(address, openOptions) {
      calls.push({ address, options: openOptions, mounted })
      if (!ready || (typeof mounted === 'string' && mounted !== '' && ready === false)) {
        throw new Error('sidebarRight: no session surface is mounted')
      }
      if (mounted == null || mounted === '') throw new Error('sidebarRight: no session surface is mounted')
      opened.push(mounted)
      return mounted
    },
  }
  return {
    sidebarRight,
    calls,
    opened,
    setMounted(next) {
      mounted = next
    },
    setReady(next) {
      ready = next
    },
    openSession(sessionId) {
      options.openSession?.(sessionId)
      mounted = sessionId
      ready = options.adopt === 'later' ? false : true
    },
  }
}

test('a changes-review address names the pane session the card wrote', () => {
  assert.equal(
    changesReviewSessionId('dsh-resource://changes-review/session/pane-session/12/3'),
    'pane-session',
  )
  assert.equal(
    changesReviewSessionId('dsh-resource://changes-review/session/pane%2Fsession/4/1'),
    'pane/session',
  )
  assert.equal(changesReviewSessionId('dsh-resource://file/session/pane-session'), null)
  assert.equal(changesReviewSessionId('dsh-resource://changes-review/session/pane-session/0/0'), null)
  assert.equal(changesReviewSessionId(''), null)
})

test('opening a review uses the card pane session, not the previous right-bar session', () => {
  const bar = reviewBar({ mounted: 'shell-current' })
  const dispose = installChangesReviewRoute(bar.sidebarRight, {
    openSession: (sessionId) => bar.openSession(sessionId),
    enabled: () => true,
  })

  const shown = bar.sidebarRight.openResource(
    'dsh-resource://changes-review/session/pane-session/9/2',
    { params: { index: 1 } },
  )

  assert.equal(shown, 'pane-session')
  assert.deepEqual(bar.opened, ['pane-session'])
  assert.equal(bar.calls[0].options.params.index, 1)
  dispose()
})

test('a review the right bar already shows is opened without moving the shell session', () => {
  const revealed = []
  const bar = reviewBar({ mounted: 'pane-session', openSession: (id) => revealed.push(id) })
  installChangesReviewRoute(bar.sidebarRight, {
    openSession: (sessionId) => {
      revealed.push(sessionId)
      bar.openSession(sessionId)
    },
    enabled: () => true,
  })

  bar.sidebarRight.openResource('dsh-resource://changes-review/session/pane-session/9/2')

  assert.deepEqual(revealed, [])
  assert.deepEqual(bar.opened, ['pane-session'])
})

test('a non-review resource keeps the right bar on its current session', () => {
  const revealed = []
  const bar = reviewBar({ mounted: 'shell-current' })
  installChangesReviewRoute(bar.sidebarRight, {
    openSession: (sessionId) => {
      revealed.push(sessionId)
      bar.openSession(sessionId)
    },
    enabled: () => true,
  })

  const shown = bar.sidebarRight.openResource('dsh-resource://file/readme.md')

  assert.equal(shown, 'shell-current')
  assert.deepEqual(revealed, [])
})

test('outside split view a review opens on the shell session unchanged', () => {
  const revealed = []
  const bar = reviewBar({ mounted: 'shell-current' })
  installChangesReviewRoute(bar.sidebarRight, {
    openSession: (sessionId) => revealed.push(sessionId),
    enabled: () => false,
  })

  const shown = bar.sidebarRight.openResource('dsh-resource://changes-review/session/pane-session/9/2')

  assert.equal(shown, 'shell-current')
  assert.deepEqual(revealed, [])
})

test('a review waits until the pane session surface is mounted, then opens there', () => {
  const bar = reviewBar({ mounted: 'shell-current', adopt: 'later' })
  const queued = []
  installChangesReviewRoute(bar.sidebarRight, {
    openSession: (sessionId) => bar.openSession(sessionId),
    enabled: () => true,
    schedule(fn) {
      queued.push(fn)
      return () => {}
    },
  })

  const first = bar.sidebarRight.openResource('dsh-resource://changes-review/session/pane-session/9/2')
  assert.equal(first, undefined)
  assert.deepEqual(bar.opened, [])
  assert.equal(queued.length, 1)

  bar.setReady(true)
  queued.shift()()

  assert.deepEqual(bar.opened, ['pane-session'])
})
