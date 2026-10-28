import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkloopStore } from '../lib/store.js'
import { tempDir, makeWorkspace } from './helpers.js'

function newStore() {
  return new WorkloopStore(join(tempDir(), 'work'), { maxNotices: 20, dedupeSeconds: 60 })
}

const claim = {
  statement: 'greet 返回 Hello 前缀',
  oracle: ['target_state', 'tests_pass'],
  minQuality: 'Q2',
  subjects: ['src/greet.py'],
}

test('start 冻结 v1，事件链可验证，重复 ID 被拒绝', async () => {
  const workspace = makeWorkspace({ 'src/greet.py': 'def greet():\n    return "Hi"\n' })
  const store = newStore()
  const result = await store.start({ goal: '修复 greet 前缀', claims: [claim] }, { workspaceRoot: workspace })

  assert.equal(result.contract.version, 1)
  assert.equal(result.contract.goalEpoch, 0)
  assert.equal(result.contract.claims[0].id, 'AC-01')
  assert.match(result.contract.hash, /^[0-9a-f]{64}$/)

  const run = store.read(result.runId)
  assert.equal(run.state.status, 'active')
  assert.equal(run.integrity.problems.length, 0)
  assert.equal(run.events.length, 2)
  assert.equal(run.events[1].prev, run.events[0].hash)

  await assert.rejects(
    () => store.start({ goal: '重复' }, { workspaceRoot: workspace, runId: result.runId }),
    /已存在/,
  )
})

test('listRuns 与 activeRun 按工作区匹配', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'a' })
  const other = makeWorkspace({ 'b.txt': 'b' })
  const store = newStore()
  const first = await store.start({ goal: '第一个' }, { workspaceRoot: workspace })
  await store.start({ goal: '第二个' }, { workspaceRoot: other })

  const active = store.activeRun(workspace)
  assert.equal(active.runId, first.runId)
  assert.equal(store.listRuns().length, 2)
  assert.match(store.activeSummary(workspace), /workloop/)
  assert.equal(store.activeSummary(makeWorkspace()), '')
})

test('活动 Run 按创建会话隔离，子 agent 使用继承的 ownerSession；旧 Run 仍可显式读取', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'a' })
  const store = newStore()
  const first = await store.start(
    { goal: '会话 A' },
    { workspaceRoot: workspace, actor: { session: 'session-a', ownerSession: 'session-a', agent: 'a', entry: 'dsh' } },
  )
  const second = await store.start(
    { goal: '会话 B' },
    { workspaceRoot: workspace, actor: { session: 'session-b', ownerSession: 'session-b', agent: 'b', entry: 'dsh' } },
  )

  assert.equal(store.activeRun(workspace, 'session-a').runId, first.runId)
  assert.equal(store.activeRun(workspace, 'session-b').runId, second.runId)
  assert.equal(store.activeRun(workspace, 'session-missing'), null)

  const legacy = await store.start({ goal: '旧格式可读' }, { workspaceRoot: makeWorkspace() })
  assert.equal(store.activeRun(legacy.contract.workspaceRoot, 'new-session'), null)
  assert.equal(store.read(legacy.runId).contract.goal.statement, '旧格式可读')
})

test('子 agent 的 active ownerSession 可以直接继承父会话', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'a' })
  const store = newStore()
  const parent = await store.start(
    { goal: '父会话' },
    { workspaceRoot: workspace, actor: { session: 'parent', ownerSession: 'parent', agent: 'parent', entry: 'dsh' } },
  )
  assert.equal(store.activeRun(workspace, 'parent').runId, parent.runId)
})

test('Claim 变化使它的证据失效；目标变化只提升 epoch，不机械失效', async () => {
  const workspace = makeWorkspace({ 'src/greet.py': 'def greet():\n    return "Hello"\n' })
  const store = newStore()
  const { runId } = await store.start({ goal: '第一版目标', claims: [claim] }, { workspaceRoot: workspace })
  const evidence = await store.evidence(runId, {
    claimId: 'AC-01',
    oracle: 'target_state',
    quality: 'Q2',
    subjects: ['src/greet.py'],
    observed: { summary: 'greet 返回 Hello' },
  })
  assert.equal(evidence.evidence.quality, 'Q2')
  assert.equal(evidence.evidence.goalEpoch, 0)

  const goalAmend = await store.amend(runId, { reason: '目标调整', changes: { goal: '第二版目标' } })
  assert.equal(goalAmend.contract.goalEpoch, 1)
  assert.equal(goalAmend.invalidated.length, 0)
  const afterGoal = store.read(runId).evidence[0]
  assert.equal(afterGoal.stale, undefined)
  assert.equal(afterGoal.goalEpoch, 0)

  const claimAmend = await store.amend(runId, {
    reason: '收紧验收',
    claimOps: [{ action: 'update', claim: { id: 'AC-01', statement: 'greet 返回 Hello 且带名字' } }],
  })
  assert.equal(claimAmend.contract.claims[0].id, 'AC-01')
  assert.equal(store.read(runId).evidence[0].stale, true)
  assert.match(store.read(runId).evidence[0].staleReason, /定义变化/)
})

test('无变化的 amend 被拒绝', async () => {
  const store = newStore()
  const { runId } = await store.start({ goal: '不变' }, { workspaceRoot: makeWorkspace() })
  await assert.rejects(() => store.amend(runId, { reason: '空改', changes: { goal: '不变' } }), /没有变化/)
})

test('并行 amend 被串行化，版本连续', async () => {
  const store = newStore()
  const { runId } = await store.start({ goal: 'g0' }, { workspaceRoot: makeWorkspace() })
  await Promise.all([
    store.amend(runId, { reason: 'a', changes: { goal: 'g1' } }),
    store.amend(runId, { reason: 'b', changes: { risk: 'medium' } }),
  ])
  const run = store.read(runId)
  assert.ok(run.contract.version >= 2)
  assert.equal(run.integrity.problems.length, 0)
  const versions = run.events.filter((event) => event.type === 'contract_amended').length
  assert.equal(versions, run.contract.version - 1)
})

test('证据指纹在文件变化后失效', async () => {
  const workspace = makeWorkspace({ 'src/greet.py': 'one' })
  const store = newStore()
  const { runId } = await store.start({ goal: '指纹', claims: [claim] }, { workspaceRoot: workspace })
  await store.evidence(runId, {
    claimId: 'AC-01',
    oracle: 'target_state',
    quality: 'Q2',
    subjects: ['src/greet.py'],
    observed: { summary: '内容为 one' },
  })
  writeFileSync(join(workspace, 'src/greet.py'), 'two', 'utf8')
  const { verdict } = await store.preview(runId)
  assert.equal(verdict.claims[0].met, false)
  assert.match(verdict.limitations.join('；'), /已变化/)
})

test('状态机：block/resume/abandon 与终态保护', async () => {
  const store = newStore()
  const { runId } = await store.start({ goal: '状态' }, { workspaceRoot: makeWorkspace() })
  await store.block(runId, '等依赖')
  assert.equal(store.read(runId).state.status, 'blocked')
  await store.resume(runId)
  assert.equal(store.read(runId).state.status, 'active')
  await store.abandon(runId, '不需要了')
  assert.equal(store.read(runId).state.status, 'abandoned')
  await assert.rejects(() => store.block(runId, 'again'), /已结束/)
})

test('事件文件被外部篡改时报告完整性问题而非静默通过', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'a' })
  const store = newStore()
  const { runId } = await store.start({ goal: '篡改' }, { workspaceRoot: workspace })
  const file = join(store.runDir(runId), 'events.jsonl')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const first = JSON.parse(lines[0])
  first.data.goal = '被改了'
  writeFileSync(file, `${JSON.stringify(first)}\n${lines[1]}\n`, 'utf8')
  const run = store.read(runId)
  assert.ok(run.integrity.problems.length > 0)
})
