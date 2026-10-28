import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { WorkloopStore } from '../lib/store.js'
import { computeVerdict } from '../lib/verdict.js'
import { tempDir, makeWorkspace, hostCaptureFor } from './helpers.js'

function newStore() {
  return new WorkloopStore(join(tempDir(), 'work'), { maxNotices: 20, dedupeSeconds: 60 })
}

const claims = [
  { id: 'AC-01', statement: '功能可用', oracle: ['target_state', 'tests_pass'], minQuality: 'Q2', subjects: ['src/a.py'] },
  { id: 'AC-02', statement: '测试通过', oracle: ['target_state', 'tests_pass'], minQuality: 'Q2', subjects: ['src/a.py'] },
]

async function start(store, workspace, extra = {}) {
  return store.start({ goal: '完成任务', claims, ...extra }, { workspaceRoot: workspace })
}

async function supporting(store, runId, claimId, extra = {}) {
  return store.evidence(runId, {
    claimId,
    oracle: 'target_state',
    quality: 'Q2',
    subjects: ['src/a.py'],
    observed: { summary: '状态符合预期' },
    ...extra,
  })
}

test('必过 Claim 全过且无限制 → PASS，finalize 收尾', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  await supporting(store, runId, 'AC-01')
  await store.evidence(runId, {
    claimId: 'AC-02',
    oracle: 'tests_pass',
    quality: 'Q2',
    subjects: ['src/a.py'],
    observed: { command: 'pytest -q', exitCode: 0, tests: 3, summary: '3 passed', declaredEffects: true },
    assurance: { backend: 'host', isolated: false },
    hostCapture: hostCaptureFor('pytest -q'),
  })

  const preview = await store.preview(runId)
  assert.equal(preview.verdict.verdict, 'PASS')
  assert.equal(preview.verdict.passEligible, true)

  const result = await store.finalize(runId, { summary: '完成' })
  assert.equal(result.verdict.verdict, 'PASS')
  assert.equal(store.read(runId).state.status, 'finished')
  assert.equal(store.read(runId).state.verdict, 'PASS')
})

test('有未确认 blocker 或旧证据待重评 → DEGRADED', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  await supporting(store, runId, 'AC-01')
  await supporting(store, runId, 'AC-02')
  await store.postNotice(runId, { kind: 'blocker', topic: '依赖缺失', summary: '缺第三方库', recipients: ['worker-2'] })

  let preview = await store.preview(runId)
  assert.equal(preview.verdict.verdict, 'DEGRADED')
  assert.match(preview.verdict.limitations.join('；'), /未确认的阻塞/)

  await store.setNoticeState(runId, { id: 'NT-01', state: 'acked', by: 'worker-2' })
  preview = await store.preview(runId)
  assert.equal(preview.verdict.verdict, 'PASS')
})

test('目标变更后旧证据保留但标记待重新评估', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  await supporting(store, runId, 'AC-01')
  await supporting(store, runId, 'AC-02')
  assert.equal((await store.preview(runId)).verdict.verdict, 'PASS')

  await store.amend(runId, { reason: '目标调整', changes: { goal: '完成任务（新目标）' } })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.verdict, 'DEGRADED')
  assert.match(preview.verdict.limitations.join('；'), /需要重新评估/)
  assert.equal(preview.verdict.needsReevaluation.length, 2)

  await supporting(store, runId, 'AC-01')
  await supporting(store, runId, 'AC-02')
  assert.equal((await store.preview(runId)).verdict.verdict, 'PASS')
})

test('部分满足 → PARTIAL；反驳证据 → 不算完成', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  await supporting(store, runId, 'AC-01')
  await store.evidence(runId, {
    claimId: 'AC-02',
    oracle: 'tests_pass',
    quality: 'Q2',
    status: 'refuting',
    subjects: ['src/a.py'],
    observed: { command: 'pytest -q', exitCode: 1, tests: 3, summary: '1 failed' },
  })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.verdict, 'PARTIAL')
  assert.deepEqual(preview.verdict.missing, ['AC-02'])
})

test('tests_pass 的失败/零测试/不确定记录不能让必过 Claim PASS', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  for (const observed of [
    { command: 'node --test', exitCode: 1, tests: 2, summary: '1 failed', declaredEffects: true },
    { command: 'node --test', exitCode: 0, tests: 0, summary: 'no tests', declaredEffects: true },
  ]) {
    await store.evidence(runId, {
      claimId: 'AC-01',
      oracle: 'tests_pass',
      quality: 'Q3',
      subjects: ['src/a.py'],
      observed,
    })
  }
  await store.evidence(runId, {
    claimId: 'AC-02',
    oracle: 'target_state',
    quality: 'Q2',
    subjects: ['src/a.py'],
    observed: { summary: '状态符合预期' },
  })
  let preview = await store.preview(runId)
  assert.equal(preview.verdict.claims.find((claim) => claim.id === 'AC-01').met, false)
  assert.equal(preview.verdict.verdict, 'PARTIAL')

  await store.evidence(runId, {
    claimId: 'AC-01',
    oracle: 'tests_pass',
    quality: 'Q3',
    status: 'inconclusive',
    subjects: ['src/a.py'],
    observed: { command: 'node --test', exitCode: 0, tests: 2, summary: '结果不确定', declaredEffects: true },
  })
  preview = await store.preview(runId)
  assert.equal(preview.verdict.claims.find((claim) => claim.id === 'AC-01').met, false)
})

test('Q0 即使被 Claim 声明为最低质量也不能满足完成', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await store.start(
    {
      goal: '禁止 Q0 完成',
      claims: [{ id: 'AC-01', statement: '目标状态正确', oracle: ['target_state'], minQuality: 'Q0', subjects: ['src/a.py'] }],
    },
    { workspaceRoot: workspace },
  )
  await store.evidence(runId, {
    claimId: 'AC-01',
    oracle: 'target_state',
    quality: 'Q0',
    subjects: ['src/a.py'],
    observed: { summary: '仅有低质量观察' },
  })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.claims[0].met, false)
  assert.equal(preview.verdict.verdict, 'FAIL')
})

test('无关对象的证据不能满足 Claim', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok', 'docs/other.md': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  await store.evidence(runId, {
    claimId: 'AC-01',
    oracle: 'target_state',
    quality: 'Q3',
    subjects: ['docs/other.md'],
    observed: { summary: '无关文件状态正确', independent: true },
  })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.claims[0].met, false)
  assert.equal(preview.verdict.verdict, 'FAIL')
  assert.match(preview.verdict.claims[0].reasons.join('；'), /subjects|不匹配/)
})

test('混合目标与无关对象的证据不能让 Claim PASS', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok', 'docs/other.md': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  await store.evidence(runId, {
    claimId: 'AC-01',
    oracle: 'target_state',
    quality: 'Q3',
    subjects: ['src/a.py', 'docs/other.md'],
    observed: { summary: '目标文件和无关文件均被检查', independent: true },
  })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.claims[0].met, false)
  assert.equal(preview.verdict.verdict, 'FAIL')
  assert.match(preview.verdict.claims[0].reasons.join('；'), /subjects|不匹配/)
})

test('完全无证据 → FAIL；finalize 拒绝假完成，承认缺口后放行', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  assert.equal((await store.preview(runId)).verdict.verdict, 'FAIL')
  await assert.rejects(() => store.finalize(runId, { summary: '做完了' }), /不能按“完成”收尾/)
  const result = await store.finalize(runId, {
    summary: '只完成了探索',
    acknowledgeGaps: true,
    knownGaps: '功能未实现',
  })
  assert.equal(result.verdict.verdict, 'FAIL')
  assert.equal(store.read(runId).state.status, 'finished')
})

test('显式 block 收尾 → BLOCKED', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace)
  const result = await store.finalize(runId, { blockedReason: '缺少依赖，无法继续' })
  assert.equal(result.verdict.verdict, 'BLOCKED')
  assert.equal(store.read(runId).state.status, 'blocked')
})

test('复核策略 independent：只有 peer 记录时 DEGRADED', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace, { policy: { review: 'independent' } })
  await supporting(store, runId, 'AC-01')
  await supporting(store, runId, 'AC-02')
  await store.evidence(runId, {
    oracle: 'review_record',
    quality: 'Q2',
    observed: { by: 'reviewer-1', summary: '看过一遍', independent: false },
  })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.verdict, 'DEGRADED')
  assert.match(preview.verdict.limitations.join('；'), /independent/)
})

test('复核记录必须是 supporting 且至少 Q2；inconclusive/Q1 不算复核完成', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const store = newStore()
  const { runId } = await start(store, workspace, { policy: { review: 'peer' } })
  await supporting(store, runId, 'AC-01')
  await supporting(store, runId, 'AC-02')
  await store.evidence(runId, {
    oracle: 'review_record',
    quality: 'Q1',
    observed: { by: 'reviewer-1', summary: '质量不足', independent: true },
  })
  await store.evidence(runId, {
    oracle: 'review_record',
    quality: 'Q2',
    status: 'inconclusive',
    observed: { by: 'reviewer-2', summary: '无法确认', independent: true },
  })
  const preview = await store.preview(runId)
  assert.equal(preview.verdict.review.satisfied, false)
  assert.match(preview.verdict.review.reason, /没有当前复核记录/)
})

test('computeVerdict 对空合同给出 NOT_READY 而不是 PASS', () => {
  const contract = {
    runId: 'run-x',
    version: 1,
    hash: 'h',
    goal: { statement: 'g' },
    goalEpoch: 0,
    claims: [],
    scope: { allow: [], protected: [] },
    policy: { review: 'none' },
  }
  const verdict = computeVerdict({
    contract,
    evidence: [],
    actions: [],
    notices: [],
    state: { status: 'active' },
    run: { workspaceRoot: '' },
    integrity: { problems: [] },
  })
  assert.equal(verdict.verdict, 'NOT_READY')
  assert.equal(verdict.passEligible, false)
})
