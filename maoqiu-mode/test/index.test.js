import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, WORKLOOP_TOOL_NAMES } from '../index.js'

function fakeContext(knownNames = WORKLOOP_TOOL_NAMES) {
  const restrictions = []
  const known = new Set(knownNames)
  const ctx = {
    tools: {
      restrict(filter) {
        const unknown = filter.deny.filter((name) => !known.has(name))
        if (unknown.length > 0) {
          throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => `"${name}"`).join(', ')}`)
        }
        restrictions.push(filter)
        return () => restrictions.pop()
      },
    },
    effect(factory) {
      return factory()
    },
  }
  return { ctx, restrictions }
}

test('restricts only inherited workloop tools in the preset scope', () => {
  const host = fakeContext()
  apply(host.ctx)
  assert.deepEqual(host.restrictions, [{ deny: [...WORKLOOP_TOOL_NAMES] }])
})

test('does not fail when workloop is absent and can be disabled', () => {
  const missing = fakeContext([])
  apply(missing.ctx)
  assert.deepEqual(missing.restrictions, [])

  const disabled = fakeContext()
  apply(disabled.ctx, { restrictWorkloop: false })
  assert.deepEqual(disabled.restrictions, [])
})

test('does not probe tools.get before restricting the optional set', () => {
  let getCalled = false
  const host = fakeContext()
  host.ctx.tools.get = () => { getCalled = true; throw new Error('tools.get should not be called') }
  apply(host.ctx)
  assert.equal(getCalled, false)
  assert.deepEqual(host.restrictions, [{ deny: [...WORKLOOP_TOOL_NAMES] }])
})

test('does not hide unexpected restriction failures', () => {
  const host = fakeContext()
  host.ctx.tools.restrict = () => { throw new Error('restriction backend unavailable') }
  assert.throws(() => apply(host.ctx), /restriction backend unavailable/)
})

