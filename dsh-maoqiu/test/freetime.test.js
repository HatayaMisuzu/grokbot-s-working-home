import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { MaoqiuStore } from '../lib/store.js'
import { FreeTime, FREE_SOURCE, freeTimeGrant } from '../lib/freetime.js'

const message = (text, id = randomUUID(), kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })
async function fixture(t, limits) {
  const home = await mkdtemp(join(tmpdir(), 'maoqiu-free-'))
  const store = new MaoqiuStore(home)
  assert.equal((await store.init()).ok, true)
  const listeners = []
  const effects = []
  const restrictions = []
  const ctx = {
    on: (event, callback) => listeners.push({ event, callback }),
    effect: (fn) => effects.push(fn()),
    logger: { warn() {} },
  }
  const follows = []
  const agent = {
    id: 'owner', status: 'idle', cancelled: 0,
    session: { id: 'owner', header: {}, deriveMessages: () => [] },
    ctx: { tools: { schemas: () => [], restrict: (filter) => { restrictions.push(filter); return () => restrictions.splice(restrictions.indexOf(filter), 1) } } },
    inbox: { nextTurn: [], nextStep: [], remove(id) { agent.inbox.nextTurn = agent.inbox.nextTurn.filter((item) => item.id !== id) } },
    followup: (input) => { follows.push(input); agent.inbox.nextTurn.push(input) },
    whenIdle: async () => {},
    cancel: () => { agent.cancelled++ },
  }
  const free = new FreeTime(ctx, store, limits)
  free.attach()
  await free.ready
  const emit = async (event, payload, next = async () => ({})) => {
    const list = listeners.filter((item) => item.event === event)
    const run = (index) => list[index] ? list[index].callback(payload, () => run(index + 1)) : next()
    return run(0)
  }
  const grant = async (text = '开始自在时间 60秒', id) => emit('agent/pre-step', { agent, messages: [message(text, id)], signal: new AbortController().signal })
  const execute = (method, args, body = () => store[method](args)) => free.execute(method, args, { agent, signal: new AbortController().signal, callId: randomUUID() }, body)
  t.after(async () => {
    await free.stop('test-end')
    await free.accounting.catch(() => {})
    for (const fn of effects) fn?.()
    await store._mutate(async () => ({ ok: true }))
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  })
  const sessionEvent = (event) => listeners.filter((item) => item.event === 'session/event').forEach((item) => item.callback(agent.session, event))
  return { store, free, agent, ctx, emit, grant, execute, restrictions, follows, home, sessionEvent }
}

test('fresh human command arms one opportunity; quoted, synthetic and old messages do not', async (t) => {
  const f = await fixture(t)
  assert.equal(freeTimeGrant(message('“开始自在时间”是什么意思')), null)
  assert.equal(freeTimeGrant(message('开始自在时间', 'fake', FREE_SOURCE)), null)
  assert.equal(freeTimeGrant(message('不要开始自在时间')), null)
  assert.equal((await f.execute('freetime', { action: 'start' })).ok, false)
  await f.grant('给你40秒自由活动', 'grant-one')
  const started = await f.execute('freetime', { action: 'start', seconds: 3000 })
  assert.equal(started.ok, true)
  assert.ok(Date.parse(started.run.expires_at) - Date.parse(started.run.created_at) <= 40000)
  assert.equal((await f.execute('freetime', { action: 'start' })).ok, false)
  await f.execute('freetime', { action: 'finish' })
  await f.grant('开始自在时间', 'grant-one')
  assert.equal((await f.execute('freetime', { action: 'start' })).ok, false)
  assert.equal((await f.free.status()).runs.length, 1)
})

test('idle continuation is coalesced and never impersonates a human; finish needs no output', async (t) => {
  const f = await fixture(t)
  await f.grant()
  assert.equal((await f.execute('freetime', { action: 'start' })).ok, true)
  await Promise.all([f.free.drive(f.agent), f.free.drive(f.agent)])
  assert.equal(f.follows.length, 1)
  assert.equal(f.follows[0].source.kind, FREE_SOURCE)
  assert.equal((await f.execute('freetime', { action: 'finish' })).run.status, 'finished')
  assert.deepEqual((await f.store.space({ action: 'list' })).files, [])
  assert.equal(f.restrictions.length, 0)
})

test('user preemption invalidates a delayed write before commit and preserves foreground edits', async (t) => {
  const f = await fixture(t)
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  f.agent.status = 'running'
  let unlock
  let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  const hold = new Promise((resolve) => { unlock = resolve })
  const pending = f.execute('space', { action: 'write', path: 'drafts/late.md', content: '过时结果', expected_version: 'missing' }, async () => {
    entered()
    await hold
    return f.store.space({ action: 'write', path: 'drafts/late.md', content: '过时结果', expected_version: 'missing' })
  })
  await enteredPromise
  const stopped = f.free.stop('user-arrived', 'paused', true)
  unlock()
  assert.equal((await pending).ok, false)
  await stopped
  assert.equal(f.agent.cancelled, 1)
  assert.equal((await f.store.space({ action: 'read', path: 'drafts/late.md' })).ok, false)
  f.agent.status = 'idle'
  await f.emit('agent/pre-step', { agent: f.agent, messages: [message('现在帮我写这个')], signal: new AbortController().signal })
  assert.equal((await f.execute('space', { action: 'write', path: 'drafts/late.md', content: '前台新内容' })).ok, true)
  assert.equal((await f.store.space({ action: 'read', path: 'drafts/late.md' })).content, '前台新内容')
})

test('resume preserves deadlines and accumulated usage, expired opportunities require a new grant', async (t) => {
  const f = await fixture(t)
  await f.grant()
  const first = await f.execute('freetime', { action: 'start' })
  await f.execute('freetime', { action: 'checkpoint', note: '草稿只写了一半', next_step: '读原文再续写' })
  await f.execute('freetime', { action: 'pause' })
  await f.grant('继续自在时间')
  const resumed = await f.execute('freetime', { action: 'resume', id: first.run.id })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.run.expires_at, first.run.expires_at)
  assert.ok(resumed.run.usage.decisions > first.run.usage.decisions)
  await f.execute('freetime', { action: 'pause' })
  await f.free.update((data) => { data.runs[0].expires_at = new Date(0).toISOString(); return { ok: true } })
  await f.grant('继续自在时间')
  assert.equal((await f.execute('freetime', { action: 'resume', id: first.run.id })).ok, false)
  const fresh = await f.execute('freetime', { action: 'start' })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.run.previous_run, first.run.id)
  assert.equal(fresh.run.checkpoint.next_step, '读原文再续写')
})

test('unknown write outcomes survive reload; read the target before any retry', async (t) => {
  const f = await fixture(t)
  await f.grant()
  const begun = await f.execute('freetime', { action: 'start' })
  const args = { action: 'write', path: 'drafts/unknown.md', content: '已落盘', expected_version: 'missing' }
  await assert.rejects(f.execute('space', args, async () => {
    assert.equal((await f.store.space(args)).ok, true)
    throw new Error('工具返回前断线')
  }), /断线/)
  assert.equal((await f.free.status()).runs[0].pending.outcome, 'unknown')
  const restarted = new FreeTime(f.ctx, f.store)
  await restarted.ready
  assert.equal(restarted.active, null)
  restarted.grants.set(f.agent, freeTimeGrant(message('继续自在时间')))
  assert.equal((await restarted.control({ action: 'resume', id: begun.run.id }, { agent: f.agent })).ok, true)
  await assert.rejects(restarted.execute('space', { action: 'append', path: args.path, content: '重复', expected_version: 'missing' }, { agent: f.agent }, () => f.store.space(args)), /结果未知/)
  const read = await restarted.execute('space', { action: 'read', path: args.path }, { agent: f.agent }, () => f.store.space({ action: 'read', path: args.path }))
  assert.equal(read.content, '已落盘')
  assert.equal((await restarted.status()).runs[0].pending, null)
  await restarted.stop('test-end')
})

test('decision and tool budgets stop before the next request; daily limits survive new runs', async (t) => {
  const f = await fixture(t, { decisions: 2, dailyDecisions: 2, tools: 2 })
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  const proposal = await f.emit('agent/request', { agent: f.agent }, async () => ({ maxTokens: 9000 }))
  assert.equal(proposal.maxTokens, 2048)
  await assert.rejects(f.emit('agent/request', { agent: f.agent }), /预算/)
  const status = await f.free.status()
  assert.equal(status.runs[0].stop_reason, 'budget-exhausted')
  assert.equal(status.day.decisions, 2)
  assert.ok(status.day.estimated_tokens > 0)
  await f.grant()
  assert.equal((await f.execute('freetime', { action: 'start' })).ok, false)
})

test('actual adapter usage replaces a reserved estimate and is persisted', async (t) => {
  const f = await fixture(t)
  f.free.lastUsage.set(f.agent.session, { inputTokens: 80, outputTokens: 20 })
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  await f.emit('agent/request', { agent: f.agent }, async () => ({}))
  f.sessionEvent({ type: 'assistant/message', data: { usage: { inputTokens: 200, outputTokens: 100 } } })
  await f.free.accounting
  const raw = JSON.parse(await readFile(f.free.file, 'utf8'))
  assert.equal(raw.runs[0].usage.tokens, 400)
  assert.equal(raw.runs[0].usage.estimated_tokens, 0)
})

test('a stored running run recovers as paused; an expired timer never queues another turn', async (t) => {
  const f = await fixture(t)
  await f.grant('自由活动0.01秒')
  await f.execute('freetime', { action: 'start' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(f.free.active, null)
  assert.equal((await f.free.status()).runs[0].stop_reason, 'window-expired')
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  const reloaded = new FreeTime(f.ctx, f.store)
  await reloaded.ready
  assert.equal((await reloaded.status()).runs[0].status, 'paused')
  assert.equal((await reloaded.status()).runs[0].stop_reason, 'host-restarted')
  assert.equal(reloaded.active, null)
  assert.equal(f.follows.length, 0)
})

test('restoring invalidates an old run, and scoped tools exclude outside capabilities', async (t) => {
  const f = await fixture(t)
  await f.grant()
  const start = await f.execute('freetime', { action: 'start' })
  assert.ok(!f.restrictions[0].allow.includes('shell'))
  assert.ok(!f.restrictions[0].allow.includes('maoqiu_experience'))
  await assert.rejects(f.emit('tools/execute', { agent: f.agent, name: 'shell' }), /只允许/)
  await f.store.space({ action: 'write', path: 'drafts/restore.md', content: '旧稿' })
  const current = await f.store.space({ action: 'write', path: 'drafts/restore.md', content: '新稿' })
  const history = await f.store.history({ path: current.path })
  const restored = await f.free.execute('history', { action: 'restore', path: current.path, history_id: history.history[0].history_id, expected_version: current.version }, { agent: { id: 'foreground-other' } }, () => f.store.history({ action: 'restore', path: current.path, history_id: history.history[0].history_id, expected_version: current.version }))
  assert.equal(restored.verified, true)
  assert.equal((await f.store.space({ action: 'read', path: current.path })).content, '旧稿')
  await f.grant('继续自在时间')
  assert.equal((await f.execute('freetime', { action: 'resume', id: start.run.id })).ok, false)
})
