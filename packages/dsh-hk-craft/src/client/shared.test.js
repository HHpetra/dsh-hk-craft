'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { browserStorage, isRecord, messageOf } = require('./shared.js')

test('isRecord accepts a plain object and rejects arrays, null and primitives', () => {
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord(undefined), false)
  assert.equal(isRecord('x'), false)
})

test('messageOf reads an Error and stringifies anything else', () => {
  assert.equal(messageOf(new Error('nope')), 'nope')
  assert.equal(messageOf('plain'), 'plain')
})

test('browserStorage is null when localStorage is missing, not an object, or throws', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const restore = () => {
    if (descriptor === undefined) delete globalThis.localStorage
    else Object.defineProperty(globalThis, 'localStorage', descriptor)
  }
  try {
    delete globalThis.localStorage
    assert.equal(browserStorage(), null)

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: 'nope' })
    assert.equal(browserStorage(), null)

    const store = {
      getItem() {
        return null
      },
      setItem() {},
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store })
    assert.equal(browserStorage(), store)

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })
    assert.equal(browserStorage(), null)
  } finally {
    restore()
  }
})
