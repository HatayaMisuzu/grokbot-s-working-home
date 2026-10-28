/** Lightweight profile bridge. Drawing code and kaomoji data load only in chat agents. */
import { fileURLToPath } from 'node:url'

export const name = 'kaomoji-pool'
export const inject = ['tools']
export const SKILL_NAME = 'text-art-freehand'
const DESCRIPTION = '轻松聊天时自由创作、修改 ASCII / Unicode 字符画。学习构图、轮廓、动作、空间和明暗，用自绘文字或通用画布完成作品；没有预制角色图库。'

export function readConfig(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const integer = (key, fallback, min, max) => Number.isSafeInteger(value[key])
    ? Math.max(min, Math.min(max, value[key])) : fallback
  return {
    ...value,
    enabled: value.enabled !== false,
    activation: value.activation === 'scoped' ? 'scoped' : 'auto',
    chatPresets: Array.isArray(value.chatPresets)
      ? value.chatPresets.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : ['maoqiu'],
    includeSubagents: value.includeSubagents === true,
    art: value.art !== false,
    tool: value.tool !== false,
    prompt: value.prompt !== false,
    maxWidth: integer('maxWidth', 120, 16, 240),
    maxHeight: integer('maxHeight', 80, 8, 160),
    historySize: integer('historySize', 8, 1, 32),
  }
}

export function presetOf(ctx, agent) {
  const header = agent?.session?.header || {}
  let projected
  try { projected = ctx.get?.('sessionProjections')?.stateOf?.(agent?.session, 'agentPreset') } catch { /* optional service */ }
  return [projected, header.agentPreset, header.preset]
    .find(value => typeof value === 'string' && value.trim())?.trim() || ''
}

export function eligibleAgent(ctx, agent, config) {
  if (!agent?.ctx) return false
  if (!config.includeSubagents && (agent.session?.header?.parentSession || agent.session?.header?.origin === 'subagent')) return false
  return config.chatPresets.includes(presetOf(ctx, agent))
}

function registerSkill(ctx) {
  const skillPath = new URL('./skills/text-art-freehand/SKILL.md', import.meta.url)
  const resourceBase = { kind: 'directory', path: fileURLToPath(new URL('./skills/text-art-freehand/', import.meta.url)) }
  const candidate = {
    name: SKILL_NAME, description: DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-text-art-freehand', source: 'bundled',
    rank: 100, locator: skillPath, resourceBase,
  }
  ctx.inject(['skills'], scope => {
    scope.skills.registerProvider(() => ({
      name: candidate.provider,
      list: async () => [candidate],
      async get(_candidate, options = {}) {
        const { readGuide } = await import('./art/guides.js')
        return { ...candidate, content: await readGuide('basics', options.signal) }
      },
    }))
  })
}

/** Explicit scoped entry also works in custom leisure presets without the profile bridge. */
export async function mountChat(ctx, config) {
  if (config.art) {
    const { createArtTool } = await import('./art/tool.js')
    ctx.effect(() => ctx.tools.register(createArtTool(config)))
    registerSkill(ctx)
  }
  if (config.tool) {
    const kaomoji = await import('./kaomoji.js')
    kaomoji.apply(ctx, { ...config, prompt: false })
  }
  if (config.prompt && (config.art || config.tool)) {
    ctx.inject(['systemPrompt'], scope => {
      scope.effect(() => scope.systemPrompt.section({
        name: 'text-art:chat', order: 10300, interpolate: false,
        text: [
          '## 轻松聊天的字符创作',
          config.art ? '需要字符画时，先加载 text-art-freehand 技能；没有 skill 工具可用 text_art(action="guide")。自己构图和绘制，用 text_art 保存、组合或局部修改，自由题材不限。成品按工具返回的空格换行原样展示。' : '',
          config.tool ? '颜文字可用 kaomoji 按情绪取样。' : '',
          '只在轻松聊天、毛球来访或创作时使用；正事、严肃话题和工作输出不要装饰。是否画、画多大跟随当前交流，不必每轮画。',
        ].filter(Boolean).join('\n'),
      }))
    })
  }
}

export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  if (!config.enabled || (!config.art && !config.tool)) return
  if (config.activation === 'scoped') return mountChat(ctx, config)

  // Same child-fiber lifecycle as the host's file-reference-local plugin.
  ctx.inject(['agents'], bridge => {
    const fibers = new Map()
    const pendingDisposals = new Set()
    let closing = false
    const install = agent => {
      if (closing || !eligibleAgent(bridge, agent, config)) return
      if (fibers.has(agent)) return fibers.get(agent)
      const fiber = agent.ctx.inject(['tools'], scope => mountChat(scope, config))
      fibers.set(agent, fiber)
      return fiber
    }
    const dispose = agent => {
      const fiber = fibers.get(agent)
      if (!fiber) return
      fibers.delete(agent)
      const task = Promise.resolve(fiber.dispose())
      pendingDisposals.add(task)
      void task.then(() => pendingDisposals.delete(task), error => {
        pendingDisposals.delete(task)
        bridge.logger?.warn(`text-art: cleanup failed: ${String(error)}`)
      })
      return task
    }
    for (const agent of bridge.agents.list()) install(agent)
    bridge.on('agent/created', async ({ agent }) => { await install(agent) })
    bridge.on('agent/disposed', ({ agent }) => { dispose(agent) })
    // rc.3 allows changing the preset of a blank session before its first turn.
    bridge.on('agent-preset/selected', async sessionId => {
      const agent = bridge.agents.get(sessionId)
      if (!agent || closing) return
      if (!eligibleAgent(bridge, agent, config)) return dispose(agent)
      await Promise.all([...pendingDisposals])
      if (eligibleAgent(bridge, agent, config)) await install(agent)
    })
    bridge.effect(() => async () => {
      closing = true
      const children = [...fibers.values()]
      fibers.clear()
      await Promise.all([...children.map(fiber => fiber.dispose()), ...pendingDisposals])
    })
  })
}
