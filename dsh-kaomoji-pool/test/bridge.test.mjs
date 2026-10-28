import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, readConfig, eligibleAgent, presetOf, mountChat } from '../index.js'

function context(records = { tools: new Map(), prompts: [], providers: [] }) {
  const effects = []
  const children = []
  const ctx = {
    records,
    effect(fn) { const undo = fn(); if (typeof undo === 'function') effects.push(undo); return undo },
    tools: {
      register(tool) {
        assert.ok(!records.tools.has(tool.name), 'no duplicate registration')
        records.tools.set(tool.name, tool)
        return () => records.tools.delete(tool.name)
      },
    },
    skills: {
      registerProvider(factory) {
        const provider = factory({ signal: new AbortController().signal, invalidate() {} })
        records.providers.push(provider)
        const undo = () => records.providers.splice(records.providers.indexOf(provider), 1)
        effects.push(undo)
        return undo
      },
    },
    systemPrompt: { section(section) { records.prompts.push(section); return () => records.prompts.splice(records.prompts.indexOf(section), 1) } },
    inject(_services, callback) {
      const child = context(records)
      children.push(child)
      const ready = Promise.resolve(callback(child))
      return { then: ready.then.bind(ready), dispose: () => ready.then(() => child.dispose()) }
    },
    async dispose() {
      for (const child of children) await child.dispose()
      for (const undo of effects.splice(0).reverse()) await undo()
    },
  }
  return ctx
}

test('configuration is conservative about mode selection', () => {
  const config = readConfig({ maxWidth: NaN, chatPresets: [' maoqiu ', 123, ''], historySize: 999 })
  assert.deepEqual(config.chatPresets, ['maoqiu'])
  assert.equal(config.maxWidth, 120)
  assert.equal(config.historySize, 32)
  assert.equal(eligibleAgent({}, { ctx: {}, session: { header: { agentPreset: 'standard' } } }, config), false)
  assert.equal(eligibleAgent({}, { ctx: {}, session: { header: { agentPreset: 'maoqiu', parentSession: 'p' } } }, config), false)
  assert.equal(presetOf({ get: () => ({ stateOf: () => 'maoqiu' }) }, { session: { header: { agentPreset: 'standard' } } }), 'maoqiu')
})

test('disabled bridge does no registration or injection', () => {
  apply({ inject() { throw new Error('must not inject') } }, { enabled: false })
})

test('explicit scoped mode registers tool, native lazy provider and compact prompt', async () => {
  const ctx = context()
  await mountChat(ctx, readConfig({ activation: 'scoped', tool: false }))
  assert.deepEqual([...ctx.records.tools.keys()], ['text_art'])
  assert.equal(ctx.records.prompts.length, 1)
  assert.ok(ctx.records.prompts[0].text.length < 350)
  const provider = ctx.records.providers[0]
  const candidates = await provider.list()
  assert.equal(candidates[0].name, 'text-art-freehand')
  assert.equal(candidates[0].content, undefined)
  assert.match((await provider.get(candidates[0])).content, /你是画面的作者/)
  await ctx.dispose()
  assert.equal(ctx.records.tools.size, 0)
  assert.equal(ctx.records.providers.length, 0)
  assert.equal(ctx.records.prompts.length, 0)
})

test('automatic bridge mounts existing and future chat agents, never a work agent, and unloads', async () => {
  const listeners = new Map(), undo = []
  const chat = { ctx: context(), session: { header: { agentPreset: 'maoqiu' } } }
  const work = { ctx: { inject() { throw new Error('work must stay lightweight') } }, session: { header: { agentPreset: 'standard' } } }
  const bridge = {
    agents: { list: () => [work], get: id => id === 'chat' ? chat : work },
    get() {},
    on(event, callback) { listeners.set(event, callback) },
    effect(callback) { undo.push(callback()) },
  }
  apply({ inject(dependencies, callback) { assert.deepEqual(dependencies, ['agents']); callback(bridge) } }, { tool: false })
  await listeners.get('agent/created')({ agent: chat })
  await listeners.get('agent/created')({ agent: chat })
  assert.equal(chat.ctx.records.tools.size, 1)
  await listeners.get('agent/created')({ agent: work })
  chat.session.header.agentPreset = 'standard'
  await listeners.get('agent-preset/selected')('chat')
  assert.equal(chat.ctx.records.tools.size, 0)
  chat.session.header.agentPreset = 'maoqiu'
  await listeners.get('agent-preset/selected')('chat')
  assert.equal(chat.ctx.records.tools.size, 1)
  await undo[0]()
  assert.equal(chat.ctx.records.tools.size, 0)
  assert.equal(chat.ctx.records.providers.length, 0)
  await listeners.get('agent/created')({ agent: chat })
  assert.equal(chat.ctx.records.tools.size, 0)
})
