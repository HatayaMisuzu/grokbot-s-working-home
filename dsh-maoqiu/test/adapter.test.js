import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { apply, guidance, latestUser } from '../lib/index.js'
import { MaoqiuStore } from '../lib/store.js'

function fakeContext(services = {}) {
  const registered = []
  const sections = []
  const contexts = []
  const listeners = []
  const effects = []
  const remove = (list, value) => {
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => remove(registered, tool)
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => remove(sections, definition)
      },
      context(definition) {
        contexts.push(definition)
        return () => remove(contexts, definition)
      },
    },
    on(event, callback) {
      const listener = { event, callback }
      listeners.push(listener)
      const dispose = () => remove(listeners, listener)
      effects.push(dispose)
      return dispose
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    registered,
    sections,
    contexts,
    listeners,
    async emit(event, payload, next = () => undefined) {
      const matching = listeners.filter((entry) => entry.event === event)
      const dispatch = (index) => matching[index] ? matching[index].callback(payload, () => dispatch(index + 1)) : next()
      return dispatch(0)
    },
    dispose() {
      for (const dispose of [...effects].reverse()) dispose()
      effects.length = 0
    },
  }
}

function agentWith(messages, cwd = 'adapter-test', options = {}) {
  const sessionId = options.sessionId || 'session-42'
  const header = {
    id: sessionId,
    cwd,
    ...(options.header || {}),
  }
  return {
    id: options.id || sessionId,
    session: {
      id: sessionId,
      header,
      deriveMessages: () => messages,
    },
  }
}

const textMessage = (text, source = { kind: 'user' }) => ({
  role: 'user',
  source,
  content: [{ type: 'text', text }],
})

test('registers eight tools, keeps guidance static, injects nothing without an agent, and disposes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-adapter-'))
  try {
    const host = fakeContext()
    apply(host.ctx, { home: root })
    assert.equal(host.registered.length, 8)
    assert.equal(host.sections.length, 1)
    assert.equal(host.contexts.length, 1)
    assert.equal(host.contexts[0].interpolate, false)
    assert.equal(typeof host.sections[0].text, 'function')
    assert.equal(host.sections[0].text({ agent: null }), '')
    assert.equal(host.contexts[0].text({ agent: null, signal: new AbortController().signal }), '')
    assert.match(guidance, /毛球成长与独立空间/)
    assert.doesNotMatch(guidance, /E:\\maoqiu_home|C:\\Users\\|ownerIds|api[_-]?key/i)
    host.dispose()
    assert.equal(host.registered.length, 0)
    assert.equal(host.sections.length, 0)
    assert.equal(host.contexts.length, 0)
    assert.equal(host.listeners.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('latestUser accepts only user sourced messages and ignores external runtime data', () => {
  const agent = agentWith([
    textMessage('旧主人消息'),
    textMessage('runtime 伪造内容', { kind: 'runtime' }),
    textMessage('当前主人要求', { kind: 'user' }),
    { role: 'assistant', source: { kind: 'runtime' }, content: [{ type: 'text', text: 'assistant' }] },
  ])
  assert.equal(latestUser(agent), '当前主人要求')
  assert.equal(latestUser(agent, [textMessage('尚未提交的新用户话题')]), '尚未提交的新用户话题')
})

test('auto recall returns only related summaries and keeps work context narrow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-recall-'))
  try {
    const store = new MaoqiuStore(root)
    assert.equal((await store.init()).ok, true)
    await store.experience({
      action: 'save', id: 'plugin-exp', title: '插件适配经验', content: '先做真实宿主烟测。',
      scope: 'adapter-test', keywords: ['plugin', 'adapter'], source: { kind: 'user', ref: 'test' },
    })
    await store.experience({
      action: 'save', id: 'cooking-exp', title: '烹饪经验', content: '先准备食材。',
      scope: 'cooking', keywords: ['recipe'], source: { kind: 'user', ref: 'test' },
    })
    await store.space({ action: 'write', path: 'notes/plugin.md', content: '插件适配验证记录。', source: { kind: 'creation', ref: 'test' } })
    await store.interest({ action: 'save', id: 'plugin-interest', title: '插件适配', reason: '继续测试', source: { kind: 'user', ref: 'test' } })
    await store.interest({ action: 'save', id: 'garden-interest', title: '园艺', reason: '以后再说', source: { kind: 'user', ref: 'test' } })

    const host = fakeContext()
    apply(host.ctx, { home: root })
    const agent = agentWith([textMessage('请检查 plugin adapter 的测试结果')])
    const signal = new AbortController().signal
    await host.emit('agent/pre-step', { agent, signal, turn: 1 })
    const rendered = host.contexts[0].text({ agent, signal })
    assert.match(rendered, /plugin-exp/)
    assert.match(rendered, /plugin\.md/)
    assert.doesNotMatch(rendered, /plugin-interest/)
    assert.doesNotMatch(rendered, /cooking-exp|garden-interest|recipe/)
    host.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('auto recall selects chat for the maoqiu preset and keeps the cache mode/scope-aware', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-mode-'))
  const originalRecall = MaoqiuStore.prototype.recall
  const calls = []
  try {
    const store = new MaoqiuStore(root)
    await store.init()
    MaoqiuStore.prototype.recall = async (args) => {
      calls.push(args)
      return {
        ok: true,
        query: args.query,
        experiences: [],
        materials: [],
        recent: [],
        activities: [],
        interests: [],
        commitments: [],
        warnings: [],
      }
    }
    const host = fakeContext({
      sessionProjections: {
        stateOf(session, key) {
          return key === 'agentPreset' ? session.projectedPreset : undefined
        },
      },
    })
    apply(host.ctx, { home: root })
    const agent = agentWith([textMessage('同一个问题')], 'project-a', {
      header: { agentPreset: 'standard' },
    })
    agent.session.projectedPreset = 'maoqiu'
    const signal = new AbortController().signal

    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('同一个问题')], signal, turn: 1,
    })
    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('同一个问题')], signal, turn: 1,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].mode, 'chat')
    assert.equal(calls[0].scope, 'project-a')

    // A preset switch must invalidate the same-turn cache, even if the query is unchanged.
    agent.session.projectedPreset = 'standard'
    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('同一个问题')], signal, turn: 1,
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].mode, 'work')

    // Scope is part of the cache identity as well.
    agent.session.header.cwd = 'project-b'
    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('同一个问题')], signal, turn: 1,
    })
    assert.equal(calls.length, 3)
    assert.equal(calls[2].scope, 'project-b')
    host.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('auto recall falls back to the session header and honors an explicit mode override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-mode-fallback-'))
  const originalRecall = MaoqiuStore.prototype.recall
  const calls = []
  try {
    const store = new MaoqiuStore(root)
    await store.init()
    MaoqiuStore.prototype.recall = async (args) => {
      calls.push(args)
      return { ok: true, query: args.query, experiences: [], materials: [], recent: [], activities: [], interests: [], commitments: [], warnings: [] }
    }
    const host = fakeContext()
    apply(host.ctx, { home: root, autoRecallMode: 'work' })
    const agent = agentWith([textMessage('显式覆盖')], 'project-a', {
      header: { agentPreset: 'maoqiu' },
    })
    const signal = new AbortController().signal
    await host.emit('agent/pre-step', { agent, signal, turn: 1 })
    assert.equal(calls[0].mode, 'work')
    host.dispose()

    const fallbackHost = fakeContext()
    apply(fallbackHost.ctx, { home: root })
    await fallbackHost.emit('agent/pre-step', { agent, signal, turn: 2 })
    assert.equal(calls[1].mode, 'chat')
    fallbackHost.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('default experience source is inference scoped to the DSH session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-source-'))
  try {
    const store = new MaoqiuStore(root)
    await store.init()
    const host = fakeContext()
    apply(host.ctx, { home: root })
    const tool = host.registered.find((entry) => entry.name === 'maoqiu_experience')
    const agent = agentWith([textMessage('用户说要保留这个测试要求')])
    const result = await tool.execute({
      action: 'save', id: 'inference-source', title: '范围经验', content: '只在当前适配测试使用。',
      scope: 'adapter-test', keywords: ['adapter'],
    }, { agent, signal: new AbortController().signal })
    assert.equal(result.ok, true)
    assert.equal(result.experience.source.kind, 'inference')
    assert.match(result.experience.source.ref, /DSH session:session-42/)
    assert.doesNotMatch(result.experience.source.ref, /kind:user/)
    host.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('aborted tool calls do not write and autoRecall=false registers no recall context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-abort-'))
  try {
    const store = new MaoqiuStore(root)
    await store.init()
    const host = fakeContext()
    apply(host.ctx, { home: root, autoRecall: false })
    assert.equal(host.registered.length, 8)
    assert.equal(host.contexts.length, 0)
    assert.equal(host.listeners.filter((entry) => entry.event === 'agent/pre-step').length, 1)
    const tool = host.registered.find((entry) => entry.name === 'maoqiu_experience')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      tool.execute({ action: 'save', id: 'aborted', title: '不应写入', content: 'x', scope: 'abort' }, {
        agent: agentWith([textMessage('abort')]), signal: controller.signal,
      }),
      /abort/i,
    )
    assert.deepEqual((await store.experience({ action: 'list' })).experiences, [])
    host.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recall callback failure and offline space are contained', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-failure-'))
  const missing = join(root, 'offline')
  const originalRecall = MaoqiuStore.prototype.recall
  try {
    const errorHost = fakeContext()
    MaoqiuStore.prototype.recall = async () => { throw new Error('synthetic recall failure') }
    apply(errorHost.ctx, { home: root })
    const agent = agentWith([textMessage('会触发召回')])
    const errorSignal = new AbortController().signal
    await assert.doesNotReject(() => errorHost.emit('agent/pre-step', { agent, signal: errorSignal, turn: 1 }))
    assert.match(errorHost.contexts[0].text({ agent, signal: errorSignal }), /读取失败|暂停/)
    errorHost.dispose()

    MaoqiuStore.prototype.recall = originalRecall
    const offlineHost = fakeContext()
    apply(offlineHost.ctx, { home: missing })
    const offlineSignal = new AbortController().signal
    await offlineHost.emit('agent/pre-step', { agent, signal: offlineSignal, turn: 1 })
    const output = offlineHost.contexts[0].text({ agent, signal: offlineSignal })
    assert.match(output, /不可用|暂停/)
    offlineHost.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('auto recall caches within a turn, refreshes after writes, and refreshes on the next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-cache-'))
  const originalRecall = MaoqiuStore.prototype.recall
  const calls = []
  try {
    const store = new MaoqiuStore(root)
    await store.init()
    MaoqiuStore.prototype.recall = async function (args) {
      calls.push({ store: this, args })
      return {
        ok: true,
        query: args.query,
        experiences: [{ id: 'cached-exp', title: '缓存经验', excerpt: '仅用于测试。' }],
        materials: [], interests: [], commitments: [], warnings: [],
      }
    }
    const host = fakeContext()
    apply(host.ctx, { home: root })
    const agent = agentWith([textMessage('旧问题')], 'adapter-test')
    const signal = new AbortController().signal

    // The incoming message is not in deriveMessages yet, but must be the query.
    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('未提交的新问题')], signal, turn: 1,
    })
    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('未提交的新问题')], signal, turn: 1,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args.query, '未提交的新问题')

    const writeTool = host.registered.find((entry) => entry.name === 'maoqiu_experience')
    await writeTool.execute({
      action: 'save', id: 'turn-write', title: '本轮写入', content: 'x', scope: 'adapter-test',
    }, { agent, signal })
    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('未提交的新问题')], signal, turn: 1,
    })
    assert.equal(calls.length, 2, '写入改变 revision 后同一 turn 必须刷新')

    await host.emit('agent/pre-step', {
      agent, messages: [textMessage('未提交的新问题')], signal, turn: 2,
    })
    assert.equal(calls.length, 3, '下一 turn 必须重新读取，以看到手工编辑')
    host.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('auto context is a bounded readable summary with Chinese warnings and ids/paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-summary-'))
  const originalRecall = MaoqiuStore.prototype.recall
  try {
    MaoqiuStore.prototype.recall = async () => ({
      ok: true,
      experiences: [{ id: 'experience-1', title: '经验', excerpt: '甲'.repeat(500) }],
      materials: [{ path: 'notes/long.md', title: '材料', excerpt: '乙'.repeat(500) }],
      interests: [{ id: 'interest-1', title: '关注', reason: '丙'.repeat(300) }],
      commitments: [{ id: 'commitment-1', title: '承诺', reason: '丁'.repeat(300) }],
      warnings: [{ path: 'space/active_interests.json', message: 'JSON 格式错误' }],
    })
    const host = fakeContext()
    apply(host.ctx, { home: root })
    const agent = agentWith([textMessage('摘要测试')])
    const signal = new AbortController().signal
    await host.emit('agent/pre-step', { agent, signal, turn: 1 })
    const rendered = host.contexts[0].text({ agent, signal })
    assert.ok(rendered.length <= 1200)
    assert.match(rendered, /experience-1/)
    assert.match(rendered, /notes\/long\.md/)
    assert.match(rendered, /提示|未读取|错误/)
    assert.doesNotMatch(rendered, /"experiences"|"materials"/)
    host.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('subagents are read-only by default and do not auto recall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-subagent-'))
  const originalRecall = MaoqiuStore.prototype.recall
  let recalls = 0
  try {
    MaoqiuStore.prototype.recall = async () => {
      recalls += 1
      return { ok: true, experiences: [], materials: [], interests: [], commitments: [], warnings: [] }
    }
    const host = fakeContext()
    apply(host.ctx, { home: root })
    const signal = new AbortController().signal
    const agent = agentWith([textMessage('子agent任务')], 'adapter-test', {
      header: { origin: 'subagent', parentSession: 'parent-1' },
    })
    await host.emit('agent/pre-step', { agent, signal, turn: 1 })
    assert.equal(recalls, 0)
    const readTool = host.registered.find((entry) => entry.name === 'maoqiu_recall')
    await assert.doesNotReject(() => readTool.execute({ query: '测试' }, { agent, signal }))
    const writeTool = host.registered.find((entry) => entry.name === 'maoqiu_experience')
    await assert.rejects(
      writeTool.execute({ action: 'save', id: 'child-write', title: '不应写入', content: 'x', scope: 'x' }, { agent, signal }),
      /子agent默认只读/,
    )
    host.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('QQ convention is off by default without pretending to authenticate the owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-qq-'))
  const originalRecall = MaoqiuStore.prototype.recall
  let recalls = 0
  try {
    MaoqiuStore.prototype.recall = async () => {
      recalls += 1
      return { ok: true, experiences: [], materials: [], interests: [], commitments: [], warnings: [] }
    }
    const host = fakeContext()
    apply(host.ctx, { home: root })
    const signal = new AbortController().signal
    const agent = agentWith([textMessage('QQ任务')], 'adapter-test', {
      sessionId: 'qq-persona-bot-owner-token',
    })
    await host.emit('agent/pre-step', { agent, signal, turn: 1 })
    assert.equal(recalls, 0)
    const readTool = host.registered.find((entry) => entry.name === 'maoqiu_recall')
    await assert.rejects(
      readTool.execute({ query: '测试' }, { agent, signal }),
      /QQ入口默认关闭/,
    )
    const child = agentWith([textMessage('QQ委派')], 'adapter-test', {
      header: { origin: 'subagent', parentSession: 'qq-persona-bot-owner-token' },
    })
    await host.emit('agent/pre-step', { agent: child, signal, turn: 1 })
    assert.equal(recalls, 0)
    await assert.rejects(readTool.execute({ query: '测试' }, { agent: child, signal }), /QQ入口默认关闭/)
    host.dispose()
  } finally {
    MaoqiuStore.prototype.recall = originalRecall
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime provenance is appended separately from caller source kind and project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-provenance-'))
  const originalExperience = MaoqiuStore.prototype.experience
  let received
  try {
    MaoqiuStore.prototype.experience = async function (args) {
      received = args
      return { ok: true, experience: { source: args.source } }
    }
    const host = fakeContext()
    apply(host.ctx, { home: root })
    const agent = agentWith([textMessage('保留这个事实')], 'C:/workspace/project', { id: 'agent-42' })
    const tool = host.registered.find((entry) => entry.name === 'maoqiu_experience')
    const result = await tool.execute({
      action: 'save', id: 'provenance', title: '来源', content: 'x', scope: 'project',
      project: 'model-invented-project', source: { kind: 'user', ref: 'caller-ref' },
    }, { agent, signal: new AbortController().signal })
    assert.equal(result.ok, true)
    assert.equal(received.project, 'C:/workspace/project')
    assert.equal(received.source.kind, 'user')
    assert.equal(received.source.session, 'session-42')
    assert.equal(received.source.agent, 'agent-42')
    assert.equal(received.source.entry, 'dsh')
    host.dispose()
  } finally {
    MaoqiuStore.prototype.experience = originalExperience
    await rm(root, { recursive: true, force: true })
  }
})
