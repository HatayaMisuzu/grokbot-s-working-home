/**
 * DSH host plugin: work-loop state and verdict guard.
 *
 * Two contributions, both owned by this plugin's context:
 *  1. seven `work_*` tools that hold the state prompts cannot hold
 *     (contract, claims, evidence fingerprints, notices, verdict);
 *  2. one compact system-prompt section plus a bounded per-turn summary of the
 *     active run in the current workspace.
 *
 * The plugin imports nothing from the Harness packages, so it works as a
 * linked local bundle. Orchestration (subagents, teams, workflows, todos,
 * planning, permissions, sandbox, approval) stays with the host; this plugin
 * only records, judges and reports.
 */
import { WorkloopStore } from './store.js'
import { buildTools, isReadOnly } from './tools.js'
import { defaultWorkHome } from './util.js'
import { guidanceText } from './guidance.js'

export const name = 'workloop'
export const inject = ['tools', 'systemPrompt']
export const defaultHome = () => process.env.WORKLOOP_HOME || defaultWorkHome()

const ACCESS_LEVELS = ['off', 'read', 'collaborate', 'write']

function readConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const integer = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.floor(value)))
  }
  const subagentAccess = ACCESS_LEVELS.includes(config.subagentAccess) ? config.subagentAccess : 'collaborate'
  return {
    home: config.home || defaultHome(),
    tools: config.tools !== false,
    prompt: config.prompt !== false,
    activeContext: config.activeContext !== false,
    activeContextMax: integer(config.activeContextMax, 700, 200, 2000),
    subagentAccess,
    maxNotices: integer(config.maxNotices, 50, 10, 200),
    noticeDedupeSeconds: integer(config.noticeDedupeSeconds, 1800, 60, 86_400),
  }
}

function sessionHeaderOf(agent) {
  return agent?.session?.header && typeof agent.session.header === 'object' ? agent.session.header : {}
}

export function sessionIdOf(agent) {
  const header = sessionHeaderOf(agent)
  return String(agent?.session?.id || header.id || agent?.id || agent?.sessionId || '')
}

export function isSubagent(agent) {
  const header = sessionHeaderOf(agent)
  return header.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession.length > 0
}

export function workspaceOf(agent) {
  const header = sessionHeaderOf(agent)
  return String(header.cwd || header.project || process.cwd())
}

export function runtimeIdentity(agent) {
  const session = sessionIdOf(agent)
  const parentSession = isSubagent(agent) ? sessionHeaderOf(agent).parentSession : ''
  return {
    session,
    ownerSession: String(parentSession || session),
    parentSession: String(parentSession || ''),
    agent: String(agent?.id || session),
    entry: isSubagent(agent) ? 'subagent' : 'dsh',
  }
}

/**
 * Read the current Agent preset without making the optional projection a hard
 * dependency.  Real DSH agents expose it through ctx.sessionProjections;
 * linked/offline tests and older hosts only have the session header.
 */
function agentPresetOf(agent, ctx, cache = null) {
  const session = agent?.session
  const key = sessionIdOf(agent)
  // Cordis guards undeclared service properties.  Its get() API is the
  // supported way to read an optional service without a hard dependency.
  const projectionCandidates = [agent, agent?.ctx, ctx].map((source) => {
    try {
      return typeof source?.get === 'function' ? source.get('sessionProjections') : source?.sessionProjections
    } catch {
      return undefined
    }
  })
  for (const projections of projectionCandidates) {
    if (!projections || typeof projections.stateOf !== 'function' || !session) continue
    try {
      const value = projections.stateOf(session, 'agentPreset')
      if (typeof value === 'string' && value.trim() !== '') {
        const normalized = value.trim().toLowerCase()
        cache?.set(key, normalized)
        return normalized
      }
    } catch {
      // Optional service; fall back to the immutable header below.
    }
  }
  const header = sessionHeaderOf(agent)
  const fallback = header.agentPreset ?? header.preset ?? header.agent_preset
  if (typeof fallback === 'string' && fallback.trim() !== '') {
    const normalized = fallback.trim().toLowerCase()
    cache?.set(key, normalized)
    return normalized
  }
  return cache?.get(key) || ''
}

function isMaoqiuPreset(agent, ctx, cache = null) {
  const preset = agentPresetOf(agent, ctx, cache).replace(/[_\s-]+/g, '')
  return preset === 'maoqiu' || preset === 'presetmaoqiu'
}

/**
 * Subagent access:
 *  - off:         no work tools at all
 *  - read:        read-only actions
 *  - collaborate: also post/ack notices and record evidence (default)
 *  - write:       same as parent except contract/finalize/learning stay parent-only
 */
export function accessFor(agent, config, tool, action) {
  if (!isSubagent(agent)) return 'ok'
  const level = config.subagentAccess
  if (level === 'off') return 'deny'
  if (isReadOnly(tool, { action })) return 'ok'
  if (level === 'read') return 'deny'
  if (level === 'collaborate') {
    if (tool === 'work_notice' || tool === 'work_evidence') return 'ok'
    return 'deny'
  }
  if (tool === 'work_learn') return 'deny'
  return 'ok'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} rawConfig row config from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const presetCache = new Map()
  const store = new WorkloopStore(config.home, {
    maxNotices: config.maxNotices,
    dedupeSeconds: config.noticeDedupeSeconds,
  })

  const enrich = (args, execution, tool) => {
    execution?.signal?.throwIfAborted()
    const agent = execution?.agent
    if (!agent) throw new Error('workloop 工具需要 DSH agent 上下文')
    const action = String(args.action ?? '')
    const access = accessFor(agent, config, tool, action)
    if (access === 'deny') {
      if (config.subagentAccess === 'off') throw new Error('子 agent 的 workloop 访问已关闭')
      if (config.subagentAccess === 'read') throw new Error('子 agent 默认只读：把发现交给父会话，或显式配置 subagentAccess=collaborate/write')
      if (tool === 'work_learn') throw new Error('经验候选只能由主会话提出：子 agent 不写长期材料')
      throw new Error('子 agent 不能修改合同、Claim、动作或完成判定：交由父会话处理')
    }
    return {
      ...args,
      workspaceRoot: workspaceOf(agent),
      actor: runtimeIdentity(agent),
    }
  }

  if (config.tools) {
    for (const tool of buildTools(store, { enrich })) {
      ctx.effect(() => ctx.tools.register(tool))
    }
  }

  if (config.prompt) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'workloop:guidance',
        order: 10360,
        interpolate: false,
        text: ({ agent }) => (agent && !isMaoqiuPreset(agent, ctx, presetCache) ? guidanceText() : ''),
      }),
    )
  }

  if (config.activeContext) {
    // DSH context providers are synchronous; prepare I/O in the async step hook.
    const summaryByAgent = new WeakMap()
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!agent || signal?.aborted) {
        if (agent) summaryByAgent.set(agent, '')
        return next()
      }
      if (isMaoqiuPreset(agent, ctx, presetCache)) {
        summaryByAgent.set(agent, '')
        return next()
      }
      try {
        const workspaceRoot = workspaceOf(agent)
        const ownerSession = runtimeIdentity(agent).ownerSession
        const active = store.activeRun(workspaceRoot, ownerSession)
        if (active === null) {
          summaryByAgent.set(agent, '')
          return next()
        }
        // File fingerprints are dynamic.  Recompute on every accepted turn so
        // an external edit cannot leave the prompt claiming an old PASS merely
        // because the run revision did not change.
        summaryByAgent.set(agent, store.activeSummary(workspaceRoot, config.activeContextMax, ownerSession))
      } catch {
        summaryByAgent.set(agent, '## 当前工作闭环（workloop）\n读取失败：请调用 work_verdict(action="preview") 重新检查。')
      }
      return next()
    })
    ctx.effect(() =>
      ctx.systemPrompt.context({
        name: 'workloop:active',
        order: 10370,
        interpolate: false,
        text: ({ agent, signal }) => (agent && !signal?.aborted ? summaryByAgent.get(agent) || '' : ''),
      }),
    )
  }

  return { store, config }
}
