import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, WORKLOOP_TOOL_NAMES } from '../lib/mode.js'

function fakeContext(knownNames = WORKLOOP_TOOL_NAMES) {
  const active = []
  const known = new Set(knownNames)
  const listeners = []
  const emit = () => { for (const l of listeners) if (l.event === 'tools/change') l.callback() }
  const ctx = {
    tools: {
      restrict(filter) {
        const unknown = filter.deny.filter((name) => !known.has(name))
        if (unknown.length > 0) {
          throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
        }
        const entry = { deny: [...filter.deny] }
        active.push(entry)
        emit()
        return () => { const i = active.indexOf(entry); if (i >= 0) active.splice(i, 1); emit() }
      },
    },
    effect(factory) { return factory() },
    on(event, callback) { listeners.push({ event, callback }) },
  }
  const denied = () => [...new Set(active.flatMap((entry) => entry.deny))].sort()
  const register = (name) => { known.add(name); emit() }
  return { ctx, active, denied, register }
}

test('restricts every inherited workloop tool in the preset scope', () => {
  const host = fakeContext()
  apply(host.ctx)
  assert.deepEqual(host.active, [{ deny: [...WORKLOOP_TOOL_NAMES] }])
})

test('does not fail when workloop is absent and can be disabled', () => {
  const missing = fakeContext([])
  apply(missing.ctx)
  assert.deepEqual(missing.active, [])

  const disabled = fakeContext()
  apply(disabled.ctx, { restrictWorkloop: false })
  assert.deepEqual(disabled.active, [])
})

test('denies a partial set and picks up workloop tools registered later', () => {
  const host = fakeContext(['work_action'])
  apply(host.ctx)
  assert.deepEqual(host.denied(), ['work_action'])
  for (const name of WORKLOOP_TOOL_NAMES) host.register(name)
  assert.deepEqual(host.denied(), [...WORKLOOP_TOOL_NAMES].sort())
  assert.equal(host.active.length, 1, 'old narrower masks are released')
})

test('does not probe tools.get before restricting the optional set', () => {
  let getCalled = false
  const host = fakeContext()
  host.ctx.tools.get = () => { getCalled = true; throw new Error('tools.get should not be called') }
  apply(host.ctx)
  assert.equal(getCalled, false)
  assert.deepEqual(host.active, [{ deny: [...WORKLOOP_TOOL_NAMES] }])
})

test('does not hide unexpected restriction failures', () => {
  const host = fakeContext()
  host.ctx.tools.restrict = () => { throw new Error('restriction backend unavailable') }
  assert.throws(() => apply(host.ctx), /restriction backend unavailable/)
})
