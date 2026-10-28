import test from 'node:test'
import assert from 'node:assert/strict'
import { gradeEvidence } from '../lib/evidence.js'
import { HostCaptureLog, captureFrom, parseTestCount } from '../lib/host.js'
import { bootPlugin, callTool, hostCaptureFor, makeAgent, makeWorkspace, tempDir } from './helpers.js'

const claim = () => ({ id: 'AC-01', oracle: ['tests_pass', 'command_output'], minQuality: 'Q2', subjects: ['src/a.py'], hash: 'h' })
const selfReported = { command: 'node --test', exitCode: 0, tests: 5, summary: '5 pass', declaredEffects: true }

function bashResult(exitCode, stdout = '', kind = 'foreground') {
  return { isError: false, content: [], value: { kind, cwd: '/w', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } } }
}

test('模型自报的命令型证据最高 Q1', () => {
  const ws = makeWorkspace({ 'src/a.py': 'x' })
  const graded = gradeEvidence({ oracle: 'tests_pass', quality: 'Q3', subjects: ['src/a.py'], observed: selfReported, assurance: { backend: 'host' } }, claim(), { workspaceRoot: ws })
  assert.equal(graded.quality, 'Q1')
  assert.equal(graded.observed.source, 'self-reported')
  assert.match(graded.reasons.join('；'), /模型自报/)
})

test('宿主采集覆盖模型填写的退出码与测试数', () => {
  const ws = makeWorkspace({ 'src/a.py': 'x' })
  const lie = gradeEvidence(
    { oracle: 'tests_pass', quality: 'Q2', subjects: ['src/a.py'], observed: selfReported, assurance: { backend: 'host' }, hostCapture: hostCaptureFor('node --test', { exitCode: 1 }) },
    claim(), { workspaceRoot: ws },
  )
  assert.equal(lie.quality, 'Q0')
  assert.equal(lie.observed.exitCode, 1)
  assert.equal(lie.observed.source, 'host')
  const ok = gradeEvidence(
    { oracle: 'tests_pass', quality: 'Q2', subjects: ['src/a.py'], observed: selfReported, assurance: { backend: 'host' }, hostCapture: hostCaptureFor('node --test', { tests: 7 }) },
    claim(), { workspaceRoot: ws },
  )
  assert.equal(ok.quality, 'Q2')
  assert.equal(ok.observed.tests, 7)
  assert.equal(ok.observed.captureId, 'HX-1')
})

test('宿主输出解析不到测试数时 tests_pass 不能支撑通过', () => {
  const ws = makeWorkspace({ 'src/a.py': 'x' })
  const graded = gradeEvidence(
    { oracle: 'tests_pass', quality: 'Q2', subjects: ['src/a.py'], observed: selfReported, assurance: { backend: 'host' }, hostCapture: hostCaptureFor('node --test', { tests: null }) },
    claim(), { workspaceRoot: ws },
  )
  assert.equal(graded.quality, 'Q0')
  assert.match(graded.reasons.join('；'), /未解析到测试数量/)
})

test('parseTestCount 识别常见测试输出，识别不了返回 null', () => {
  assert.equal(parseTestCount('ℹ tests 48\nℹ pass 48'), 48)
  assert.equal(parseTestCount('==== 12 passed in 0.3s ===='), 12)
  assert.equal(parseTestCount('Tests:       4 passed, 4 total'), 4)
  assert.equal(parseTestCount('Ran 3 tests in 0.001s'), 3)
  assert.equal(parseTestCount('hello'), null)
})

test('captureFrom 只采集完成的前台 bash 结果', () => {
  const exec = { name: 'bash', callId: 'c1', arguments: { command: '  node   --test ' } }
  const cap = captureFrom(exec, bashResult(0, 'ℹ tests 2'))
  assert.equal(cap.command, 'node --test')
  assert.equal(cap.tests, 2)
  assert.equal(captureFrom({ ...exec, name: 'read' }, bashResult(0)), null)
  assert.equal(captureFrom(exec, bashResult(0, '', 'promoted')), null)
  assert.equal(captureFrom(exec, { isError: true, content: [], error: {} }), null)
  const log = new HostCaptureLog({ max: 2 })
  log.add('s', cap); log.add('s', cap); log.add('s', { ...cap, command: 'x' })
  assert.equal(log.list('s').length, 2)
  assert.equal(log.resolve('s', { command: 'node --test' }).id, 'HX-2')
  assert.equal(log.resolve('other', { command: 'node --test' }), null)
})

test('插件注册 tools/post-execute：采集后原样放行，证据按命令匹配升级', async () => {
  const workspace = makeWorkspace({ 'src/a.py': 'ok' })
  const plugin = bootPlugin({ home: tempDir('workloop-home-') })
  const agent = makeAgent(workspace)
  const hook = plugin.hooks.get('tools/post-execute')
  assert.equal(typeof hook, 'function')
  const sentinel = { kind: 'accept' }
  const decision = await hook({ name: 'bash', callId: 'c1', arguments: { command: 'node --test' }, agent }, bashResult(0, 'ℹ tests 4'), async () => sentinel)
  assert.equal(decision, sentinel)

  const listed = await callTool(plugin.byName, 'work_evidence', { action: 'captures' }, agent)
  assert.equal(listed.captures.length, 1)
  assert.equal(listed.captures[0].exitCode, 0)

  await callTool(plugin.byName, 'work_contract', { action: 'start', goal: 'g', claims: [{ id: 'AC-01', statement: 's', oracle: ['tests_pass'], minQuality: 'Q2', subjects: ['src/a.py'] }] }, agent)
  const host = await callTool(plugin.byName, 'work_evidence', { action: 'record', claimId: 'AC-01', oracle: 'tests_pass', quality: 'Q2', subjects: ['src/a.py'], observed: { command: 'node --test', exitCode: 0, tests: 99, summary: 'ok', declaredEffects: true }, assurance: { backend: 'host' } }, agent)
  assert.equal(host.evidence.quality, 'Q2')
  assert.equal(host.evidence.observed.tests, 4)
  const forged = await callTool(plugin.byName, 'work_evidence', { action: 'record', claimId: 'AC-01', oracle: 'tests_pass', quality: 'Q2', subjects: ['src/a.py'], observed: { command: 'npm test', exitCode: 0, tests: 9, summary: 'ok', declaredEffects: true }, assurance: { backend: 'host' } }, agent)
  assert.equal(forged.evidence.quality, 'Q1')
})

test('hostEvidence=false 时不注册 post-execute 钩子', () => {
  const plugin = bootPlugin({ home: tempDir('workloop-home-'), config: { hostEvidence: false } })
  assert.equal(plugin.hooks.has('tools/post-execute'), false)
})
