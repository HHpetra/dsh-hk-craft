'use strict'

/**
 * The strip's read-only current-mode seat (ticket 07).
 *
 * The seat is a thin React component: the pure projection lives in
 * `pane-mode.js`, and the optional roster loader is injected by `index.js`, so
 * this module never mentions dsh. These tests drive it with a fake React (the
 * same approach as the pane view tests) and assert what a user can observe:
 * hidden without a preset, a non-interactive label, and copy that follows the
 * focused pane.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const { createModeSeat } = require('./pane-mode-seat.js')

let stateSlots = []
let cursor = 0
let activeEffects = null

/** The one React instance `pane-mode-seat.js` caches; installs only reset its state. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useEffect: (effect) => {
    if (activeEffects !== null) activeEffects.push(effect)
  },
  useState: (initial) => {
    const index = cursor++
    if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next
    }
    return [stateSlots[index], set]
  },
}

/**
 * A minimal hook-capable React stand-in. `pane-mode-seat.js` resolves `react`
 * lazily, so installing this through `Module._load` reaches the same instance.
 *
 * The module caches the React instance for its lifetime, so the fake itself is
 * file-level and every install only resets its state slots and effect sink.
 *
 * @returns {{render: Function, flush: Function, restore: Function}}
 */
function installFakeReact() {
  const originalLoad = Module._load
  stateSlots = []
  cursor = 0
  activeEffects = null
  Module._load = function load(request, parent, isMain) {
    if (request === 'react') return fakeReact
    return originalLoad.call(this, request, parent, isMain)
  }

  /**
   * Render the seat once and collect the effects of that render.
   *
   * @param {Function} Component seat component
   * @param {object} props seat props
   * @returns {{element: any, effects: Function[]}}
   */
  function render(Component, props) {
    cursor = 0
    const effects = []
    activeEffects = effects
    const element = Component(props)
    return { element, effects }
  }

  /** Let the roster promise settle after running the render's effects. */
  async function flush(effects) {
    for (const effect of effects) {
      const cleanup = effect()
      assert.equal(typeof cleanup === 'function' || cleanup === undefined, true)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return {
    render,
    flush,
    restore() {
      Module._load = originalLoad
    },
  }
}

/** Seat props as `PaneStripActions` builds them; only the mode inputs matter. */
function seatProps({ focused = { paneId: 'p1', sessionId: 's1', focused: true }, preset } = {}) {
  return {
    controller: {},
    layout: {},
    focused,
    sessions: preset === undefined ? { byId: {} } : { byId: { s1: { projectionValues: { agentPreset: preset } } } },
    statuses: new Map(),
    kit: {},
    t: (key) => key,
  }
}

/** The visible label inside the badge element. */
function labelOf(element) {
  return element.props.children[0].props.children[0]
}

test('a focused session with a shipped preset renders a read-only, localized badge', () => {
  const harness = installFakeReact()
  try {
    const ModeSeat = createModeSeat({ loadRoster: async () => [] })
    const { element } = harness.render(ModeSeat, seatProps({ preset: 'ptc' }))

    assert.equal(element.type, 'span')
    assert.equal(element.props['data-hkcraft-strip-mode'], 'ptc')
    assert.equal(labelOf(element), 'strip.mode.ptc')
    assert.equal(element.props.title, 'strip.mode.hint')
    // Read-only by construction: no click handler, no button role, no tab stop.
    assert.equal(element.props.onClick, undefined)
    assert.equal(element.props.role, undefined)
    assert.equal(element.props.tabIndex, undefined)
    assert.equal(element.props['aria-disabled'], undefined)
  } finally {
    harness.restore()
  }
})

test('the badge is absent when there is no focused session or no preset', () => {
  const harness = installFakeReact()
  try {
    const calls = []
    const loadRoster = async (id) => {
      calls.push(id)
      return []
    }
    const ModeSeat = createModeSeat({ loadRoster })

    const noFocus = harness.render(ModeSeat, seatProps({ focused: null }))
    assert.equal(noFocus.element, null)
    for (const effect of noFocus.effects) effect()

    const noPreset = harness.render(ModeSeat, seatProps())
    assert.equal(noPreset.element, null)
    for (const effect of noPreset.effects) effect()

    assert.deepEqual(calls, [])
  } finally {
    harness.restore()
  }
})

test('a custom preset uses the roster name and description once loaded', async () => {
  const harness = installFakeReact()
  try {
    const calls = []
    const loadRoster = async (id) => {
      calls.push(id)
      return [{ id: 'review', name: 'Code review', description: 'Prioritize bugs and test gaps.' }]
    }
    const ModeSeat = createModeSeat({ loadRoster })
    const props = seatProps({ preset: 'review' })

    const first = harness.render(ModeSeat, props)
    assert.equal(labelOf(first.element), 'review', 'the id shows until the roster arrives')
    await harness.flush(first.effects)

    const second = harness.render(ModeSeat, props)
    assert.equal(labelOf(second.element), 'Code review')
    assert.equal(second.element.props.title, 'Prioritize bugs and test gaps.')
    assert.deepEqual(calls, ['review'])
  } finally {
    harness.restore()
  }
})

test('changing the focused preset retries the roster for the new id', async () => {
  const harness = installFakeReact()
  try {
    const calls = []
    const loadRoster = async (id) => {
      calls.push(id)
      return []
    }
    const ModeSeat = createModeSeat({ loadRoster })

    const first = harness.render(ModeSeat, seatProps({ preset: 'standard' }))
    await harness.flush(first.effects)
    const second = harness.render(ModeSeat, seatProps({ preset: 'minimal' }))
    await harness.flush(second.effects)

    assert.equal(labelOf(second.element), 'strip.mode.minimal')
    assert.deepEqual(calls, ['standard', 'minimal'])
  } finally {
    harness.restore()
  }
})

test('a failing or absent roster still renders the built-in name or the id', async () => {
  const harness = installFakeReact()
  try {
    const failing = createModeSeat({
      loadRoster: async () => {
        throw new Error('roster unavailable')
      },
    })
    const first = harness.render(failing, seatProps({ preset: 'standard' }))
    await harness.flush(first.effects)
    assert.equal(
      labelOf(harness.render(failing, seatProps({ preset: 'standard' })).element),
      'strip.mode.standard',
    )

    const absent = createModeSeat({})
    assert.equal(labelOf(harness.render(absent, seatProps({ preset: 'my-review' })).element), 'my-review')
  } finally {
    harness.restore()
  }
})
