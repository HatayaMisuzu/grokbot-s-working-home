import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { MaoqiuStore } from '../lib/store.js'
import { FreeTime, FREE_SOURCE, freeTimeGrant } from '../lib/freetime.js'
import { buildHomeView, renderText } from '../lib/home-view.js'

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

test('soft limit pauses and asks Ruby instead of truncating; she can say go on', async (t) => {
  const f = await fixture(t, { softSteps: 2 })
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  const proposal = await f.emit('agent/request', { agent: f.agent }, async () => ({ maxTokens: 9000 }))
  assert.equal(proposal.maxTokens, 2048)
  await f.emit('agent/request', { agent: f.agent }, async () => ({}))
  assert.equal(f.free.active.asking, 'steps')
  await assert.rejects(f.execute('space', { action: 'read', path: 'drafts/x.md' }), /软上限/)
  // checkpoint is still allowed while asking
  assert.equal((await f.execute('freetime', { action: 'checkpoint', note: '写到第二段', next_step: '接着写第三段' })).ok, true)
  await f.free.drive(f.agent)
  const status = await f.free.status()
  assert.equal(status.runs[0].stop_reason, 'soft-limit')
  assert.equal(status.runs[0].needs_confirmation, true)
  assert.ok(status.waiting_for_ruby)
  await f.grant('好呀，继续玩吧')
  const resumed = await f.execute('freetime', { action: 'resume', id: status.runs[0].id })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.run.needs_confirmation, false)
  assert.equal(resumed.run.soft_from.decisions, resumed.run.usage.decisions - 1)
  await f.emit('agent/request', { agent: f.agent }, async () => ({}))
  assert.equal(f.free.active.asking, undefined)
  assert.equal(resumed.run.checkpoint.next_step, '接着写第三段')
})

test('a model run of asking requests cannot continue quietly past the soft limit', async (t) => {
  const f = await fixture(t, { softSteps: 1 })
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  for (let i = 0; i < 3; i++) await f.emit('agent/request', { agent: f.agent }, async () => ({}))
  await assert.rejects(f.emit('agent/request', { agent: f.agent }, async () => ({})), /软上限/)
  assert.equal((await f.free.status()).runs[0].stop_reason, 'soft-limit')
})

test('no daily cap, no strict tool count; legacy keys are mapped or ignored', async (t) => {
  const f = await fixture(t, { decisions: 50, tokens: 9e5, seconds: 10, tools: 1, dailyDecisions: 1, dailyTokens: 1 })
  assert.deepEqual(f.free.limits, { defaultMinutes: 20, softMinutes: 120, softSteps: 50, softTokens: 900000, outputTokens: 2048 })
  for (let i = 0; i < 3; i++) {
    await f.grant('随便玩会儿', `g${i}`)
    const started = await f.execute('freetime', { action: 'start' })
    assert.equal(started.ok, true, started.error)
    for (let k = 0; k < 4; k++) assert.equal((await f.execute('space', { action: 'list' })).ok, true)
    await f.emit('agent/request', { agent: f.agent }, async () => ({}))
    await f.execute('freetime', { action: 'finish' })
  }
  const status = await f.free.status()
  assert.equal(status.daily_limit, false)
  assert.equal(status.day, undefined)
  assert.ok(status.runs.every((run) => run.usage.tools >= 5))
})

test('natural phrases from Ruby set the window; default is told back', async (t) => {
  const cases = [
    ['给你半小时', 1800], ['随便玩会儿', undefined], ['今晚你可以自由活动十分钟', 600], ['自由活动一小时', 3600],
    ['毛球，去玩一个半小时吧', 5400], ['好啦 你去自由活动吧', undefined], ['给你二十五分钟自在时间', 1500], ['玩一刻钟吧', 900],
    ['开始自在时间 90秒', 90], ['给你两个小时', 7200],
    ['去玩吧', undefined], ['你自己玩会儿吧', undefined], ['给你半小时自由活动', 1800],
  ]
  for (const [text, seconds] of cases) {
    const g = freeTimeGrant(message(text))
    assert.ok(g, text)
    assert.equal(g.seconds, seconds, text)
  }
  for (const text of [
    '不要自由活动', '先别玩了', '“自由活动”是什么意思', '你能自由活动吗？', '给你看一段代码', '一小时后提醒我开会', '继续',
    // Ruby talking about her own plans / play is not a grant to 毛球
    '周末我想出去玩两小时', '我去玩会儿游戏', '我玩了半小时', '周末想出去玩两小时', '我自己玩会儿',
  ])
    assert.equal(freeTimeGrant(message(text)), null, text)
  // Grants come only from Ruby's runtime message, never from synthetic or assistant text.
  assert.equal(freeTimeGrant(message('给你半小时', 'x', FREE_SOURCE)), null)
  assert.equal(freeTimeGrant({ id: 'a', role: 'assistant', source: { kind: 'user' }, content: [{ type: 'text', text: '给你半小时' }] }), null)

  const f = await fixture(t)
  assert.equal((await f.execute('freetime', { action: 'start', seconds: 60 })).ok, false)
  await f.grant('随便玩会儿')
  const started = await f.execute('freetime', { action: 'start' })
  assert.equal(started.granted.minutes, 20)
  assert.equal(started.granted.defaulted, true)
  assert.match(started.told, /默认 20 分钟/)
  assert.equal(Date.parse(started.run.expires_at) - Date.parse(started.run.created_at), 1200000)
  await f.execute('freetime', { action: 'finish' })
  await f.grant('给你半小时')
  const second = await f.execute('freetime', { action: 'start' })
  assert.equal(second.granted.minutes, 30)
  assert.equal(second.granted.defaulted, false)
  assert.match(second.told, /实际时长 30 分钟/)
})

test('nothing starts on its own: idle, restart and time passing never begin a run', async (t) => {
  const f = await fixture(t)
  await f.emit('agent/status', { agent: f.agent, status: 'idle' })
  await f.free.drive(f.agent)
  const restarted = new FreeTime(f.ctx, f.store, { defaultMinutes: 1 })
  await restarted.ready
  assert.equal(restarted.active, null)
  assert.equal(f.follows.length, 0)
  const status = await f.free.status()
  assert.equal(status.automatic, false)
  assert.equal(status.runs.length, 0)
  const source = await readFile(new URL('../lib/freetime.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setInterval|cron|schedule/i)
})

test('usage bookkeeping is journaled with a marker and folded in the view', async (t) => {
  const f = await fixture(t)
  await f.grant()
  await f.execute('freetime', { action: 'start' })
  await f.emit('agent/request', { agent: f.agent }, async () => ({}))
  await f.execute('space', { action: 'write', path: 'drafts/a.md', content: '一小段', expected_version: 'missing' })
  await f.execute('freetime', { action: 'checkpoint', note: '写了一小段', next_step: '再看看' })
  await f.execute('freetime', { action: 'finish' })
  const entries = (await readFile(f.store.journalFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const books = entries.filter((x) => x.target === 'space/free_time.json')
  assert.ok(books.length >= 3)
  assert.ok(books.every((x) => x.bookkeeping === true))
  assert.ok(entries.filter((x) => x.target !== 'space/free_time.json').every((x) => !x.bookkeeping))
  const view = await buildHomeView(f.store)
  assert.ok(view.board.recent.every((x) => x.raw !== 'space/free_time.json'))
  assert.ok(view.board.recent.some((x) => x.raw === 'space/drafts/a.md'))
  assert.ok(view.board.folded_bookkeeping > 0)
  assert.match(renderText(view), /计费记录已折叠/)
  assert.equal(view.board.last_stop.next_step, '再看看')
  assert.equal((await f.store.verifyJournal()).ok, true)
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
