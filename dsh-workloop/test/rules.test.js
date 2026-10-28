import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildContractBody, normalizeClaim } from '../lib/contract.js'
import { gradeEvidence, stalenessOf } from '../lib/evidence.js'
import { gateAction } from '../lib/actions.js'
import { makeWorkspace } from './helpers.js'

const contract = {
  hash: 'contract-hash',
  version: 1,
  scope: { allow: ['src/**'], protected: ['.env'] },
}

function claim(overrides = {}) {
  return {
    id: 'AC-01',
    statement: '目标状态正确',
    oracle: ['target_state', 'tests_pass', 'file_contains'],
    minQuality: 'Q2',
    subjects: ['src/a.py'],
    hash: 'claim-hash',
    ...overrides,
  }
}

test('合同校验：空目标 / 未知 Oracle / 未知 profile / 非法质量', () => {
  assert.throws(() => buildContractBody({ goal: '  ' }), /goal 不能为空/)
  assert.throws(() => buildContractBody({ goal: 'g', claims: [{ statement: 's', oracle: ['nope'] }] }), /未知 Oracle/)
  assert.throws(() => buildContractBody({ goal: 'g', profile: 'vibe' }), /未知 profile/)
  assert.throws(
    () => buildContractBody({ goal: 'g', claims: [{ statement: 's', oracle: ['target_state'], minQuality: 'Q9' }] }),
    /minQuality/,
  )
  const body = buildContractBody({ goal: 'g', scope: { allow: [] } })
  assert.deepEqual(body.scope.allow, [])
  assert.equal(body.goalEpoch, undefined) // epoch is added by freeze, not by the body
})

test('Claim 自动编号与重复拒绝', () => {
  const first = normalizeClaim({ statement: 'a', oracle: ['target_state'] }, [])
  const second = normalizeClaim({ statement: 'b', oracle: ['target_state'] }, [first])
  assert.equal(first.id, 'AC-01')
  assert.equal(second.id, 'AC-02')
  assert.throws(() => normalizeClaim({ statement: '', oracle: ['target_state'] }), /statement/)
  assert.throws(() => normalizeClaim({ statement: 'x', oracle: [], id: 'AC-01' }), /至少一个 Oracle/)
})

test('占位命令只能算 Q0，不会被声明质量抬高', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'x' })
  const graded = gradeEvidence(
    {
      oracle: 'tests_pass',
      quality: 'Q3',
      subjects: ['src/a.py'],
      observed: { command: 'assert True', exitCode: 0, summary: 'ok' },
    },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(graded.quality, 'Q0')
  assert.match(graded.reasons.join('；'), /占位/)
})

test('缺对象指纹 / 缺摘要 / 缺独立来源都会降级', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'x' })
  const noSubject = gradeEvidence(
    { oracle: 'target_state', quality: 'Q3', observed: { summary: 'ok' } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(noSubject.quality, 'Q1')

  const noSummary = gradeEvidence(
    { oracle: 'target_state', quality: 'Q3', subjects: ['src/a.py'], observed: {} },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(noSummary.quality, 'Q1')

  const q3 = gradeEvidence(
    { oracle: 'target_state', quality: 'Q3', subjects: ['src/a.py'], observed: { summary: 'ok' } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(q3.quality, 'Q2')
  assert.match(q3.reasons.join('；'), /Q3/)
})

test('未知 Oracle 与不在 Claim 允许列表的 Oracle 都被压低', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'x' })
  const unknown = gradeEvidence(
    { oracle: 'vibes', quality: 'Q3', subjects: ['src/a.py'], observed: { summary: 'ok' } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(unknown.quality, 'Q0')

  const notAllowed = gradeEvidence(
    { oracle: 'file_exists', quality: 'Q2', subjects: ['src/a.py'], observed: { summary: 'ok' } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(notAllowed.quality, 'Q1')
})

test('声明型复核记录缺少来源时最高 Q1', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'x' })
  const graded = gradeEvidence(
    { oracle: 'review_record', quality: 'Q2', observed: { summary: '复核通过' } },
    { id: '@review', oracle: ['review_record'], minQuality: 'Q2', hash: null },
    { workspaceRoot: workspace },
  )
  assert.equal(graded.quality, 'Q1')
})

test('命令型证据带非宿主后端限制', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'x' })
  const graded = gradeEvidence(
    {
      oracle: 'tests_pass',
      quality: 'Q2',
      subjects: ['src/a.py'],
      observed: { command: 'pytest -q', exitCode: 0, tests: 3, summary: '3 passed', declaredEffects: true },
      assurance: { backend: 'workspace-write', isolated: false },
    },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(graded.quality, 'Q2')
  assert.match(graded.limitations.join('；'), /只证明功能结果/)
})

test('tests_pass 的非零退出码、零测试与不确定状态不能伪装成支撑证据', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'x' })
  const base = { oracle: 'tests_pass', quality: 'Q3', subjects: ['src/a.py'], assurance: { backend: 'host' } }

  const failed = gradeEvidence(
    { ...base, observed: { command: 'node --test', exitCode: 1, tests: 3, summary: '1 failed', declaredEffects: true } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(failed.quality, 'Q0')
  assert.match(failed.reasons.join('；'), /退出码为 1/)

  const empty = gradeEvidence(
    { ...base, observed: { command: 'node --test', exitCode: 0, tests: 0, summary: '没有测试', declaredEffects: true } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(empty.quality, 'Q0')
  assert.match(empty.reasons.join('；'), /至少 1 个测试/)

  const inconclusive = gradeEvidence(
    {
      ...base,
      status: 'inconclusive',
      observed: { command: 'node --test', exitCode: 0, tests: 3, summary: '结果不确定', declaredEffects: true },
    },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(inconclusive.quality, 'Q0')
  assert.match(inconclusive.reasons.join('；'), /inconclusive/)
})

test('证据对象必须落在 Claim subjects 内', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'a', 'docs/unrelated.md': 'b' })
  const graded = gradeEvidence(
    { oracle: 'target_state', quality: 'Q3', subjects: ['docs/unrelated.md'], observed: { summary: '无关文件看起来正确' } },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(graded.quality, 'Q0')
  assert.match(graded.reasons.join('；'), /不匹配/)
})

test('证据混入 Claim 范围外对象时不能支撑 Claim', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'a', 'docs/unrelated.md': 'b' })
  const graded = gradeEvidence(
    {
      oracle: 'target_state',
      quality: 'Q3',
      subjects: ['src/a.py', 'docs/unrelated.md'],
      observed: { summary: '一个目标文件和一个无关文件看起来正确', independent: true },
    },
    claim(),
    { workspaceRoot: workspace },
  )
  assert.equal(graded.quality, 'Q0')
  assert.match(graded.reasons.join('；'), /不匹配/)
})

test('对象变化/消失使证据失效', () => {
  const workspace = makeWorkspace({ 'src/a.py': 'one' })
  const graded = gradeEvidence(
    { oracle: 'target_state', quality: 'Q2', subjects: ['src/a.py'], observed: { summary: 'one' } },
    claim(),
    { workspaceRoot: workspace },
  )
  const record = { id: 'EV-01', claimId: 'AC-01', ...graded }
  assert.equal(stalenessOf(record, { workspaceRoot: workspace }).stale, false)
  writeFileSync(join(workspace, 'src/a.py'), 'two', 'utf8')
  assert.equal(stalenessOf(record, { workspaceRoot: workspace }).stale, true)
})

test('动作门禁：保护路径 / 越界 / 空 allow / 缺少副作用 / 高风险确认', () => {
  const base = { kind: 'write', intent: '改文件', targets: ['src/a.py'] }
  assert.equal(gateAction(base, { contract }).decision, 'authorized')

  const protectedHit = gateAction({ ...base, targets: ['.env'] }, { contract })
  assert.equal(protectedHit.decision, 'denied')
  assert.match(protectedHit.reason, /受保护/)

  const outside = gateAction({ ...base, targets: ['infra/deploy.yml'] }, { contract })
  assert.equal(outside.decision, 'denied')
  assert.match(outside.reason, /不在允许范围/)

  const emptyAllow = gateAction(base, { contract: { ...contract, scope: { allow: [], protected: [] } } })
  assert.equal(emptyAllow.decision, 'denied')
  assert.match(emptyAllow.reason, /不被允许/)

  const noEffects = gateAction({ kind: 'execute', intent: '跑测试', targets: [] }, { contract })
  assert.equal(noEffects.decision, 'denied')
  assert.match(noEffects.reason, /副作用/)

  const highRisk = gateAction({ kind: 'delete', intent: '删缓存', targets: ['src/a.py'] }, { contract })
  assert.equal(highRisk.decision, 'confirmation_required')

  const confirmed = gateAction(
    { kind: 'delete', intent: '删缓存', targets: ['src/a.py'], confirmation: { by: '用户', note: '同意删除' } },
    { contract },
  )
  assert.equal(confirmed.decision, 'authorized')
  assert.equal(confirmed.action.risk, 'high')
  assert.match(confirmed.findings.join('；'), /未认证/)
})

test('读取不受 allow 限制，但保护路径仍拒绝', () => {
  const read = gateAction({ kind: 'read', intent: '看代码', targets: ['infra/x.yml'] }, { contract })
  assert.equal(read.decision, 'authorized')
  const protectedRead = gateAction({ kind: 'read', intent: '看密钥', targets: ['.env'] }, { contract })
  assert.equal(protectedRead.decision, 'denied')
})
