import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

export const name = 'text-art-smoke-probe'
export const inject = ['agents', 'sessionController', 'tools', 'systemPrompt', 'skills', 'agentPresets']
const textOf = value => (value.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')

export function apply(ctx, config) {
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(String(error?.stack || error)))
  const report = { ok: false, checks: [], errors }
  async function run() {
    async function create(id, preset) {
      await ctx.sessionController.create({ sessionId: id, cwd: config.workspace, agentPreset: preset })
      const resolved = await ctx.sessionController.resolveAgent(id)
      assert.ok(resolved.agent, `agent resolution failed: ${JSON.stringify(resolved.error)}`)
      return resolved.agent
    }
    const work = await create('text-art-work', 'standard')
    const names = agent => ctx.tools.schemas(agent).map(schema => schema.name)
    assert.ok(!names(work).includes('text_art'))
    assert.ok(!names(work).includes('kaomoji'))
    assert.ok(!(await ctx.skills.list({ scope: work, cwd: config.workspace })).some(skill => skill.name === 'text-art-freehand'))
    const workAssembly = await ctx.systemPrompt.assemble({ agent: work, scope: work })
    assert.ok(!workAssembly.sections.some(section => section.name === 'text-art:chat'))
    report.checks.push('工作 agent 无 text_art/kaomoji schema、原生技能或提示段')

    const chat = await create('text-art-chat', 'maoqiu')
    assert.ok(names(chat).includes('text_art'))
    assert.ok(names(chat).includes('kaomoji'))
    const definition = ctx.tools.get('text_art', chat)
    assertSupportedJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
    const skill = await ctx.skills.get('text-art-freehand', { scope: chat, cwd: config.workspace })
    assert.match(skill.content, /你是画面的作者/)
    report.checks.push('毛球 agent 工具和原生按需技能可用；schema 通过真实宿主校验')

    const switched = await create('text-art-blank-switch', 'maoqiu')
    const waitFor = async predicate => {
      const start = Date.now()
      while (!predicate()) {
        if (Date.now() - start > 5000) throw new Error('preset contribution did not settle')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    await ctx.agentPresets.select(switched, 'standard')
    await waitFor(() => !names(switched).includes('text_art'))
    await ctx.agentPresets.select(switched, 'maoqiu')
    await waitFor(() => names(switched).includes('text_art'))
    report.checks.push('首轮前切换 preset 时自动移除或恢复字符画贡献')

    const chatAssembly = await ctx.systemPrompt.assemble({ agent: chat, scope: chat })
    assert.ok(chatAssembly.sections.some(section => section.name === 'text-art:chat'))
    const follow = async (agent, marker) => {
      agent.followup({ id: 'user-' + marker, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: marker }] })
      await agent.whenIdle()
      assert.equal(errors.length, 0, errors.join('\n'))
      const messages = agent.session.deriveMessages()
      const i = messages.findLastIndex(message => message.role === 'user' && textOf(message) === marker)
      return messages.slice(i + 1).filter(message => message.role === 'tool').map(textOf).join('\n')
    }
    assert.match(await follow(chat, 'ART_GUIDE'), /主语和动词|主语/)
    const original = await follow(chat, 'ART_DRAW')
    assert.match(original, /art-1/)
    assert.doesNotMatch(original, /^Error:/m)
    const edited = await follow(chat, 'ART_EDIT')
    assert.match(edited, /art-2/)
    assert.match(edited, /\{\{\}\}/)
    assert.notEqual(edited, original)
    const raw = await follow(chat, 'ART_RAW')
    assert.match(raw, /````/)
    assert.ok(raw.includes('\n  /\\  \n ( o )\n  ``` '))
    report.checks.push('真实 Agent 循环完成 guide → 自定义图层 draw → 局部 edit → 原文画，并保留空白和围栏')
    await follow(work, 'ART_WORK')
    assert.ok(!names(work).includes('text_art'))
    assert.ok(!(await ctx.skills.list({ scope: work, cwd: config.workspace })).some(skill => skill.name === 'text-art-freehand'))
    report.checks.push('同一 Host 中聊天启用后，工作 agent 仍无字符画贡献')
    await writeFile(config.original, original + '\n')
    await writeFile(config.edited, edited + '\n')
    report.ok = true
  }
  Promise.resolve().then(run).catch(error => { report.error = String(error?.stack || error) }).finally(async () => {
    await writeFile(config.report, JSON.stringify(report, null, 2) + '\n')
    await writeFile(config.done, 'done\n')
  })
}
