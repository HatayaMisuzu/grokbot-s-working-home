import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPlugin, callTool, makeAgent, makeWorkspace, tempDir } from './helpers.js'

const claims = [
  { id: 'AC-01', statement: '功能可用', oracle: ['target_state'], minQuality: 'Q2', subjects: ['src/a.py'] },
]

async function bootWithWorkspace(config = {}) {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const plugin = bootPlugin({ home: tempDir('workloop-home-'), config })
  const agent = makeAgent(workspace)
  return { workspace, agent, ...plugin }
}

test('注册 7 个工具、系统提示段与活动上下文钩子', () => {
  const plugin = bootPlugin({ home: tempDir('workloop-home-') })
  const names = plugin.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'work_action',
    'work_claim',
    'work_contract',
    'work_evidence',
    'work_learn',
    'work_notice',
    'work_verdict',
  ])
  for (const tool of plugin.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(Array.isArray(tool.parameters.required))
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.description.length > 30)
  }
  assert.equal(plugin.sections.length, 1)
  assert.equal(plugin.sections[0].name, 'workloop:guidance')
  assert.equal(plugin.contexts.length, 1)
  assert.ok(plugin.hooks.has('agent/pre-step'))
})

test('完整流程：合同 → 动作 → 证据 → 判定 → 收尾', async () => {
  const { agent, byName } = await bootWithWorkspace()
  const started = await callTool(
    byName,
    'work_contract',
    { action: 'start', goal: '修复功能', claims, scope: { allow: ['src/**'] } },
    agent,
  )
  assert.match(started.runId, /^run-/)
  assert.equal(started.contract.claims[0].id, 'AC-01')

  const declared = await callTool(
    byName,
    'work_action',
    { action: 'declare', kind: 'write', intent: '改 src/a.py', targets: ['src/a.py'] },
    agent,
  )
  assert.equal(declared.gate.decision, 'authorized')

  const recorded = await callTool(
    byName,
    'work_evidence',
    {
      action: 'record',
      claimId: 'AC-01',
      oracle: 'target_state',
      quality: 'Q2',
      subjects: ['src/a.py'],
      observed: { summary: '内容为 ok' },
    },
    agent,
  )
  assert.equal(recorded.evidence.quality, 'Q2')
  assert.match(recorded.text, /已满足/)

  const preview = await callTool(byName, 'work_verdict', { action: 'preview' }, agent)
  assert.equal(preview.verdict.verdict, 'PASS')

  const finished = await callTool(byName, 'work_verdict', { action: 'finalize', summary: '完成' }, agent)
  assert.equal(finished.state.status, 'finished')
})

test('默认 Run 解析与缺失提示', async () => {
  const { agent, byName } = await bootWithWorkspace()
  await assert.rejects(() => callTool(byName, 'work_claim', { action: 'list' }, agent), /没有 active 的 Run/)
  await callTool(byName, 'work_contract', { action: 'start', goal: '解析' }, agent)
  const listed = await callTool(byName, 'work_claim', { action: 'list' }, agent)
  assert.deepEqual(listed.claims, [])
})

test('子 agent 默认协作只读：可记证据/发通知，不能改合同或收尾', async () => {
  const { workspace, byName } = await bootWithWorkspace()
  const parent = makeAgent(workspace)
  const started = await callTool(byName, 'work_contract', { action: 'start', goal: '协作', claims }, parent)
  const child = makeAgent(workspace, { subagent: true, id: 'child-1', session: 'session-child', parentSession: parent.session.id })

  await assert.rejects(
    () => callTool(byName, 'work_contract', { action: 'amend', goal: '改目标' }, child),
    /子 agent 不能修改合同/,
  )
  await assert.rejects(() => callTool(byName, 'work_verdict', { action: 'finalize' }, child), /子 agent 不能修改合同/)
  await assert.rejects(() => callTool(byName, 'work_learn', { action: 'propose', title: 't', content: 'c', scope: 's' }, child), /只能由主会话提出/)

  const notice = await callTool(
    byName,
    'work_notice',
    { action: 'post', kind: 'discovery', topic: '发现', summary: '子 agent 发现一个兼容性问题' },
    child,
  )
  assert.equal(notice.notice.state, 'recorded')

  const evidence = await callTool(
    byName,
    'work_evidence',
    {
      action: 'record',
      claimId: 'AC-01',
      oracle: 'target_state',
      quality: 'Q2',
      subjects: ['src/a.py'],
      observed: { summary: '子 agent 观察' },
    },
    child,
  )
  assert.equal(evidence.evidence.actor.entry, 'subagent')
  assert.equal(evidence.evidence.runId, started.runId)

  const readOnly = bootPlugin({ home: tempDir('workloop-home-'), config: { subagentAccess: 'read' } })
  const readOnlyAgent = makeAgent(workspace, { subagent: true, id: 'child-2', session: 'session-child-2' })
  await assert.rejects(
    () => callTool(readOnly.byName, 'work_notice', { action: 'post', kind: 'discovery', topic: 't', summary: 's' }, readOnlyAgent),
    /默认只读/,
  )
})

test('通知去重与 ack 语义', async () => {
  const { agent, byName } = await bootWithWorkspace()
  await callTool(byName, 'work_contract', { action: 'start', goal: '通知' }, agent)
  const first = await callTool(
    byName,
    'work_notice',
    { action: 'post', kind: 'conflict', topic: '写冲突', summary: '两个 worker 改同一个文件' },
    agent,
  )
  const second = await callTool(
    byName,
    'work_notice',
    { action: 'post', kind: 'conflict', topic: '写冲突', summary: '两个 worker 改同一个文件。' },
    agent,
  )
  assert.equal(first.deduped, false)
  assert.equal(second.deduped, true)
  assert.equal(second.notice.id, first.notice.id)

  await assert.rejects(
    () => callTool(byName, 'work_notice', { action: 'ack', id: first.notice.id }, agent),
    /需要 by/,
  )
  const acked = await callTool(byName, 'work_notice', { action: 'ack', id: first.notice.id, by: 'worker-2' }, agent)
  assert.equal(acked.notice.state, 'acked')
  const resolved = await callTool(byName, 'work_notice', { action: 'resolve', id: first.notice.id, by: 'worker-2' }, agent)
  assert.equal(resolved.notice.state, 'resolved')
})

test('经验候选的验证程度与证据校验', async () => {
  const { agent, byName } = await bootWithWorkspace()
  const started = await callTool(byName, 'work_contract', { action: 'start', goal: '学习', claims }, agent)
  const record = await callTool(
    byName,
    'work_evidence',
    {
      action: 'record',
      claimId: 'AC-01',
      oracle: 'target_state',
      quality: 'Q2',
      subjects: ['src/a.py'],
      observed: { summary: 'ok' },
    },
    agent,
  )

  const verified = await callTool(
    byName,
    'work_learn',
    {
      action: 'propose',
      title: '先看指纹再改文件',
      content: '改文件前记录指纹，改完复核能发现意外变更。',
      scope: '项目 C:/work',
      evidenceIds: [record.evidence.id],
      source: { kind: 'tool', ref: `run:${started.runId}` },
    },
    agent,
  )
  assert.equal(verified.learning.verification, 'verified')
  assert.equal(verified.learning.status, 'candidate')

  const inferred = await callTool(
    byName,
    'work_learn',
    { action: 'propose', title: '猜测', content: '可能是缓存问题', scope: '项目 C:/work', source: { kind: 'inference', ref: '推测' } },
    agent,
  )
  assert.equal(inferred.learning.verification, 'inferred')

  await assert.rejects(
    () =>
      callTool(
        byName,
        'work_learn',
        { action: 'propose', title: 't', content: 'c', scope: 's', evidenceIds: ['EV-99'] },
        agent,
      ),
    /不存在的证据/,
  )
  await assert.rejects(
    () => callTool(byName, 'work_learn', { action: 'propose', title: 't', content: 'c', scope: '' }, agent),
    /scope/,
  )
})

test('活动上下文钩子注入当前 Run 摘要且按 revision 复用', async () => {
  const { agent, byName, hooks, contexts } = await bootWithWorkspace()
  await callTool(byName, 'work_contract', { action: 'start', goal: '上下文', claims }, agent)

  const hook = hooks.get('agent/pre-step')
  await hook({ agent, signal: undefined }, async () => {})
  const text = contexts[0].text({ agent, signal: undefined })
  assert.match(text, /workloop/)
  assert.match(text, /必过 Claim 0\/1/)

  await callTool(
    byName,
    'work_evidence',
    {
      action: 'record',
      claimId: 'AC-01',
      oracle: 'target_state',
      quality: 'Q2',
      subjects: ['src/a.py'],
      observed: { summary: 'ok' },
    },
    agent,
  )
  await hook({ agent, signal: undefined }, async () => {})
  const updated = contexts[0].text({ agent, signal: undefined })
  assert.match(updated, /必过 Claim 1\/1/)
  assert.match(updated, /PASS/)
})

test('活动上下文每个新 turn 刷新文件指纹，外部变更不会继续显示旧 PASS', async () => {
  const { workspace, agent, byName, hooks, contexts } = await bootWithWorkspace()
  await callTool(byName, 'work_contract', { action: 'start', goal: '刷新指纹', claims }, agent)
  await callTool(
    byName,
    'work_evidence',
    {
      action: 'record',
      claimId: 'AC-01',
      oracle: 'target_state',
      quality: 'Q2',
      subjects: ['src/a.py'],
      observed: { summary: 'ok' },
    },
    agent,
  )
  const hook = hooks.get('agent/pre-step')
  await hook({ agent, signal: undefined }, async () => {})
  assert.match(contexts[0].text({ agent, signal: undefined }), /PASS/)

  writeFileSync(join(workspace, 'src/a.py'), 'changed', 'utf8')
  await hook({ agent, signal: undefined }, async () => {})
  const refreshed = contexts[0].text({ agent, signal: undefined })
  assert.doesNotMatch(refreshed, /PASS/)
  assert.match(refreshed, /对象已变化/)
})

test('同一工作区的自动 Run 选择按创建会话隔离，但显式 runId 仍可读取旧数据', async () => {
  const { workspace, byName } = await bootWithWorkspace()
  const first = makeAgent(workspace, { id: 'agent-a', session: 'session-a' })
  const second = makeAgent(workspace, { id: 'agent-b', session: 'session-b' })
  const started = await callTool(byName, 'work_contract', { action: 'start', goal: '会话绑定' }, first)
  await assert.rejects(() => callTool(byName, 'work_claim', { action: 'list' }, second), /没有属于自己的 active Run/)
  const explicit = await callTool(byName, 'work_contract', { action: 'show', runId: started.runId }, second)
  assert.equal(explicit.runId, started.runId)
})

test('毛球预设不注入工作闭环提示和活动上下文', async () => {
  const { workspace, agent, byName, hooks, contexts, sections } = await bootWithWorkspace()
  agent.session.header.agentPreset = 'standard'
  agent.sessionProjections = { stateOf: (_session, key) => (key === 'agentPreset' ? 'maoqiu' : undefined) }
  await callTool(byName, 'work_contract', { action: 'start', goal: '毛球不带工作提示', claims }, agent)
  assert.equal(sections[0].text({ agent }), '')
  await hooks.get('agent/pre-step')({ agent, signal: undefined }, async () => {})
  assert.equal(contexts[0].text({ agent, signal: undefined }), '')
})

test('可选预设服务使用 Cordis get 读取，不触发未声明属性访问', async () => {
  const { agent, ctx, hooks, contexts, sections } = await bootWithWorkspace()
  agent.session.header.agentPreset = 'standard'
  const guardedContext = new Proxy({}, {
    get(_target, key) {
      if (key === 'sessionProjections') throw new Error('cannot get property "sessionProjections" without inject')
      return undefined
    },
  })
  agent.ctx = guardedContext
  Object.defineProperty(ctx, 'sessionProjections', {
    get() { throw new Error('cannot get property "sessionProjections" without inject') },
  })
  ctx.get = (name) => name === 'sessionProjections'
    ? { stateOf: (_session, key) => key === 'agentPreset' ? 'maoqiu' : undefined }
    : undefined
  assert.equal(sections[0].text({ agent }), '')
  await hooks.get('agent/pre-step')({ agent }, async () => {})
  assert.equal(contexts[0].text({ agent }), '')
  ctx.get = () => undefined
  assert.match(sections[0].text({ agent }), /工作闭环/)
})
