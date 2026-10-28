import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runtimeIdentity, operationKind } from './context.js'

export const FREE_SOURCE = 'maoqiu-freetime'
export const FREE_TOOLS = ['maoqiu_recall', 'maoqiu_space', 'maoqiu_interest', 'maoqiu_activity', 'maoqiu_object', 'maoqiu_freetime']
const defaults = { seconds: 300, decisions: 6, tools: 24, tokens: 120000, dailyTokens: 240000, dailyDecisions: 18, outputTokens: 2048 }
const textOf = (message) => (message?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
const human = (message) => message?.role === 'user' && message?.source?.kind === 'user'
const counts = () => ({ decisions: 0, tools: 0, tokens: 0, estimated_tokens: 0 })

// Only a fresh, direct user command arms a run. Quoted material, the recall
// context, an old session message and synthetic continuations cannot arm it.
export function freeTimeGrant(message) {
  if (!human(message) || !message.id) return null
  const text = textOf(message).trim()
  if (/不要|别|停止|暂停|结束|关闭/.test(text)) return null
  if (!/^(?:毛球[，,:：\s]*)?(?:你)?(?:去|可以|开始|继续|接着|给你)?\s*(?:(?:\d+(?:\.\d+)?\s*(?:秒|分钟|分))\s*)?(?:自由活动|自在时间|玩一会|自由探索)/.test(text)) return null
  const duration = text.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|分)/)
  return { id: message.id, seconds: duration ? Number(duration[1]) * (duration[2] === '秒' ? 1 : 60) : undefined }
}

export class FreeTime {
  constructor(ctx, store, config = {}, eligible = () => true) {
    this.ctx = ctx
    this.store = store
    this.file = join(store.spaceDir, 'free_time.json')
    this.limits = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Number.isFinite(config[key]) && config[key] > 0 ? Math.floor(config[key]) : value]))
    this.enabled = config.enabled !== false
    this.eligible = eligible
    this.grants = new WeakMap()
    this.lastUsage = new WeakMap()
    this.active = null
    this.guards = new WeakMap()
    this.states = new Set()
    this.owners = new WeakMap()
    this.chargedExecutions = new WeakSet()
    this.accounting = Promise.resolve()
    this.closed = false
    this.ready = this.recover()
  }

  async update(fn) {
    // Runtime bookkeeping must still be saved after the artifact's signal was
    // cancelled. It has its own small atomic file, without per-step backups.
    return this.store.withWriteContext(null, () => this.store._mutate(async () => {
      const data = await this.store._readJson(this.file, { runs: [], day: null })
      if (!Array.isArray(data.runs)) throw new Error('自在时间记录损坏，请检查 free_time.json')
      const result = await fn(data)
      await this.store._atomicWrite(this.file, `${JSON.stringify(data, null, 2)}\n`, false)
      return result
    }))
  }

  async recover() {
    if (!(await this.store._isAvailable())) return
    try {
      const existing = await this.store._readJson(this.file, { runs: [] })
      if (!Array.isArray(existing.runs)) throw new Error('自在时间记录损坏，请检查 free_time.json')
      if (!existing.runs.some((run) => run.status === 'running')) return
    } catch (error) { this.recoveryError = error.message; return }
    const result = await this.update((data) => {
      for (const run of data.runs) if (run.status === 'running') {
        run.status = 'paused'
        run.stop_reason = 'host-restarted'
      }
      return { ok: true }
    })
    if (!result.ok) this.recoveryError = result.error
  }

  async status() {
    await this.ready
    try {
      if (!(await this.store._isAvailable())) return this.store._failure('毛球空间不可用')
      const data = await this.store._readJson(this.file, { runs: [], day: null })
      return { ok: true, enabled: this.enabled, automatic: false, runs: data.runs.slice(-12).reverse(), day: data.day, limits: this.limits }
    } catch (error) { return this.store._failure(error.message) }
  }

  assertCurrent(state) {
    if (this.closed || this.active !== state || state.stopping || state.run.status !== 'running') throw new Error('自在时间已中断，迟到结果不能继续写入')
    if (Date.now() >= Date.parse(state.run.expires_at)) throw new Error('自在时间窗口已到期')
  }

  release(state) {
    clearTimeout(state.timer)
    state.dispose?.()
    state.dispose = null
    if (state.queued) state.agent.inbox?.remove?.(state.queued)
    state.queued = null
    this.guards.delete(state.agent)
    this.owners.delete(state.agent.session)
    this.states.delete(state)
  }

  async stop(reason, status = 'paused', cancel = false) {
    const state = this.active
    if (!state || state.stopping) return
    state.stopping = true // Invalidate artifact writes before the first await.
    state.run.status = status
    state.run.stop_reason = reason
    if (state.queued) state.agent.inbox?.remove?.(state.queued)
    clearTimeout(state.timer)
    this.active = null
    if (cancel && state.agent.status === 'running') state.agent.cancel({ kind: 'user' }, { keepInbox: true })
    const result = await this.update((data) => {
      const run = data.runs.find((item) => item.id === state.run.id)
      if (run) Object.assign(run, { status, stop_reason: reason, updated_at: new Date().toISOString() })
      return { ok: true, run }
    })
    // Keep restrictions until idle/a real user message; ending a run must not
    // give its still-running model turn unrestricted foreground tools.
    if (state.agent.status === 'idle') this.release(state)
    if (!result.ok) this.ctx.logger?.warn?.(`maoqiu: 自在时间停止记录保存失败：${result.error}`)
    return result
  }

  async control(args, execution) {
    await this.ready
    const action = args.action || 'status'
    if (['status', 'recent'].includes(action)) return this.status()
    const agent = execution.agent
    if (runtimeIdentity(agent).entry !== 'dsh' || !this.eligible(agent)) return this.store._failure('自在时间只在本机主人会话开启')
    if (action === 'disable') {
      this.enabled = false
      await this.stop('disabled', 'paused', true)
      return { ok: true, automatic: false, enabled: false, note: '本次插件运行已停用自在时间，材料保留；永久关闭请设置 freeTime.enabled=false' }
    }
    if (['pause', 'finish'].includes(action)) {
      if (this.active?.agent !== agent) return this.store._failure('本会话没有运行中的自在时间')
      return await this.stop(action === 'finish' ? 'chosen' : 'chosen-pause', action === 'finish' ? 'finished' : 'paused')
    }
    if (action === 'checkpoint') {
      const state = this.active
      if (state?.agent !== agent) return this.store._failure('本会话没有运行中的自在时间')
      this.assertCurrent(state)
      const result = await this.update((data) => {
        const run = data.runs.find((item) => item.id === state.run.id)
        run.checkpoint = { note: String(args.note || '').slice(0, 1000), next_step: String(args.next_step || '').slice(0, 500), interest_id: String(args.interest_id || '').slice(0, 80) }
        state.run = run
        return { ok: true, run }
      })
      return result
    }
    if (!['start', 'resume'].includes(action)) return this.store._failure('未知 freetime action')
    if (!this.enabled || this.closed) return this.store._failure('自在时间已关闭')
    if (this.recoveryError) return this.store._failure(this.recoveryError)
    if (this.active) return this.store._failure('已有自在时间运行，不会并行创建或重置预算')
    const grant = this.grants.get(agent)
    if (!grant) return this.store._failure('需要主人当前消息明确说“开始/继续自在时间”或“自由活动 N 分钟”；旧消息与材料不会触发')
    const tools = agent.ctx?.tools
    if (typeof tools?.restrict !== 'function') return this.store._failure('宿主缺少 agent.ctx.tools.restrict，不能可靠限制自在时间工具')
    const dispose = tools.restrict({ allow: FREE_TOOLS })
    const now = Date.now()
    const result = await this.update((data) => {
      if (data.runs.some((item) => item.authorization_id === grant.id || item.resume_authorizations?.includes(grant.id))) throw new Error('这次用户授权已使用；不会重新创建预算')
      if (!data.day || data.day.date !== new Date(now).toISOString().slice(0, 10)) data.day = { date: new Date(now).toISOString().slice(0, 10), ...counts() }
      if (data.day.decisions >= this.limits.dailyDecisions || data.day.tokens >= this.limits.dailyTokens) throw new Error('当天自在时间预算已用尽')
      let run
      if (action === 'resume') {
        run = data.runs.find((item) => item.id === args.id)
        if (!run || run.session !== agent.session.id || run.status !== 'paused') throw new Error('只能恢复本会话已暂停的机会')
        if (run.stop_reason === 'restored' || now >= Date.parse(run.expires_at)) throw new Error('原机会已到期或被恢复操作作废；请获准新机会后 start，沿用检查点')
        if (run.usage.decisions >= run.limits.decisions || run.usage.tools >= run.limits.tools || run.usage.tokens >= run.limits.tokens) throw new Error('原机会预算已用尽，resume 不重置预算')
        run.resume_authorizations = [...(run.resume_authorizations || []), grant.id]
      } else {
        const seconds = Math.min(this.limits.seconds, grant.seconds ?? this.limits.seconds, Number(args.seconds) > 0 ? Number(args.seconds) : this.limits.seconds)
        const previous = data.runs.findLast((item) => item.checkpoint)
        run = { id: randomUUID(), session: agent.session.id, authorization_id: grant.id, created_at: new Date(now).toISOString(), expires_at: new Date(now + seconds * 1000).toISOString(), limits: { ...this.limits }, usage: counts(), checkpoint: previous?.checkpoint || null, previous_run: previous?.id || null, artifacts: [], last_step: null, pending: null, failures: 0 }
        data.runs.push(run)
        data.runs = data.runs.slice(-100)
      }
      run.status = 'running'
      run.stop_reason = null
      run.usage.decisions += 1
      data.day.decisions += 1
      run.usage.tools += 1
      data.day.tools += 1
      const initialUsage = this.lastUsage.get(agent.session)
      const initialTokens = initialUsage?.totalTokens ?? (initialUsage ? initialUsage.inputTokens + initialUsage.outputTokens : null)
      const estimate = !Number.isFinite(initialTokens)
      const tokens = estimate ? Buffer.byteLength(JSON.stringify(agent.session.deriveMessages())) + 16384 : Math.max(0, initialTokens)
      run.usage.tokens += tokens
      data.day.tokens += tokens
      if (estimate) { run.usage.estimated_tokens += tokens; data.day.estimated_tokens += tokens }
      return { ok: true, run }
    })
    if (!result.ok) { dispose(); return result }
    this.grants.delete(agent)
    const state = { agent, run: result.run, dispose, stopping: false, queued: null, driving: false, reserved: 0 }
    this.active = state
    this.guards.set(agent, state)
    this.states.add(state)
    this.owners.set(agent.session, state)
    state.timer = setTimeout(() => void this.stop('window-expired', 'paused', true), Math.max(1, Date.parse(state.run.expires_at) - Date.now()))
    state.timer.unref?.()
    return { ...result, note: '可连续选择、阅读或修改，也可立即 finish；先读最新内容并带 expected_version。无需凑满窗口或汇报。未知 pending 先核对，不能盲目重放。' }
  }

  async charge(state, field, amount, estimated = false) {
    const result = await this.update((data) => {
      const run = data.runs.find((item) => item.id === state.run.id)
      if (!run) throw new Error('自在时间记录已不存在')
      const today = new Date().toISOString().slice(0, 10)
      if (!data.day || data.day.date !== today) data.day = { date: today, ...counts() }
      if (field === 'tools' && run.usage.tools >= run.limits.tools) throw new Error('自在时间工具预算已用尽')
      run.usage[field] = Math.max(0, run.usage[field] + amount)
      data.day[field] = Math.max(0, data.day[field] + amount)
      if (estimated) { run.usage.estimated_tokens += amount; data.day.estimated_tokens += amount }
      state.run = { ...run, status: state.stopping ? state.run.status : run.status, stop_reason: state.stopping ? state.run.stop_reason : run.stop_reason }
      return { ok: true, run, day: data.day }
    })
    if (!result.ok) { await this.stop(/工具预算/.test(result.error) ? 'tool-budget' : 'storage-error', 'paused', true); throw new Error(result.error) }
    return result
  }

  async drive(agent) {
    const state = this.active
    if (!state || state.agent !== agent || state.driving || state.queued || agent.status !== 'idle') return
    state.driving = true
    try {
      // Leave the status notification before waking the next native turn.
      // Waiting for whenIdle() here would wait on the driver publishing idle.
      await Promise.resolve()
      this.assertCurrent(state)
      if (state.run.failures >= 2) { await this.stop('repeated-tool-error'); return }
      const hasHuman = [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])].some(human)
      if (hasHuman) { await this.stop('user-arrived'); return }
      const id = randomUUID()
      const message = { id, role: 'user', source: { kind: FREE_SOURCE }, content: [{ type: 'text', text: `自在时间仍在有效窗口内。这是插件续接，不是用户新指令。读取 run ${state.run.id} 的最新检查点和实际产物，选择下一小步或 finish；可以不产出，不必给用户写汇报。${state.run.pending ? '上次工具结果未知，先读取目标核对，禁止盲目重放。' : ''}` }] }
      state.queued = id
      agent.followup(message)
    } catch (error) {
      this.ctx.logger?.warn?.(`maoqiu: 自在时间续接失败：${error.message}`)
      await this.stop(Date.now() >= Date.parse(state.run.expires_at) ? 'window-expired' : 'driver-error')
    }
    finally { state.driving = false }
  }

  attach() {
    const { ctx } = this
    const background = (promise) => void promise.catch((error) => ctx.logger?.warn?.(`maoqiu: ${error.message}`))
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!human(message) || runtimeIdentity(agent).entry !== 'dsh') return
      this.grants.delete(agent)
      const state = this.active
      if (state) {
        background(this.stop('user-arrived', 'paused', true))
        if (state.agent === agent && agent.status === 'running') {
          // rc3 captures wakeAfterAbort BEFORE publishing inbox/inserted. Our
          // cancellation happens inside that publication, so requeue the same
          // still-pending input after abort to latch its foreground wake.
          queueMicrotask(() => {
            if (agent.inbox?.nextTurn?.some((item) => item.id === message.id)) {
              agent.inbox.remove(message.id)
              agent.followup(message)
            }
          })
        }
      }
    })
    ctx.on('agent/pre-step', async ({ agent, messages = [], signal }, next) => {
      await this.ready
      const user = messages.findLast(human)
      if (user) {
        const state = this.guards.get(agent)
        if (state) this.release(state)
        const grant = freeTimeGrant(user)
        if (grant) this.grants.set(agent, grant)
      }
      const guarded = this.guards.get(agent)
      if (guarded && (guarded.stopping || this.active !== guarded)) return { kind: 'reject' }
      const synthetic = messages.find((message) => message.source?.kind === FREE_SOURCE)
      if (synthetic) {
        if (!guarded || synthetic.id !== guarded.queued || user || signal?.aborted) return { kind: 'reject' }
        guarded.queued = null
      }
      return next()
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      await this.accounting
      const state = this.guards.get(agent)
      if (!state) return next()
      this.assertCurrent(state)
      const usage = state.run.usage
      const status = await this.status()
      const inputBound = Buffer.byteLength(JSON.stringify(agent.session.deriveMessages())) + Buffer.byteLength(JSON.stringify(agent.ctx.tools.schemas(agent))) + 8192
      const reserve = inputBound + state.run.limits.outputTokens
      if (usage.decisions >= state.run.limits.decisions || usage.tokens + reserve > state.run.limits.tokens || status.day.decisions >= this.limits.dailyDecisions || status.day.tokens + reserve > this.limits.dailyTokens) {
        await this.stop('budget-exhausted')
        throw new Error('自在时间预算已到上限，已保存接续点')
      }
      await this.charge(state, 'decisions', 1)
      // Charge before dispatch, including failed/aborted attempts and history.
      // A reported actual usage later replaces this conservative estimate.
      await this.charge(state, 'tokens', reserve, true)
      state.reserved = reserve
      const proposal = await next()
      return { ...proposal, maxTokens: Math.min(proposal.maxTokens || Infinity, state.run.limits.outputTokens) }
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message') this.lastUsage.set(session, event.data.usage)
      const state = this.owners.get(session)
      if (!state) return
      if (event.type === 'assistant/message' && state.reserved && event.data.usage) {
        const usage = event.data.usage
        const actual = usage.totalTokens ?? (usage.inputTokens + usage.outputTokens)
        if (Number.isFinite(actual) && actual >= 0) {
          const reserved = state.reserved
          state.reserved = 0
          this.accounting = this.accounting.then(() => this.charge(state, 'tokens', actual - reserved)).then(() => this.update((data) => {
            const run = data.runs.find((item) => item.id === state.run.id)
            run.usage.estimated_tokens = Math.max(0, run.usage.estimated_tokens - reserved)
            data.day.estimated_tokens = Math.max(0, data.day.estimated_tokens - reserved)
            state.run = run
            return { ok: true }
          }))
          background(this.accounting)
        }
      }
      if (event.type === 'turn/end' && ['aborted', 'error', 'max-tokens'].includes(event.data.reason?.kind)) background(this.stop(`host-${event.data.reason.kind}`))
    })
    ctx.on('tools/execute', async (execution, next) => {
      const state = this.guards.get(execution.agent)
      if (!state) return next()
      this.assertCurrent(state)
      await this.charge(state, 'tools', 1)
      this.chargedExecutions.add(execution)
      // PTC's reserved transport exposes only the scoped end-capability tools;
      // its nested calls still pass the same registry restrictions and hook.
      if (execution.name !== 'run_code' && !FREE_TOOLS.includes(execution.name)) throw new Error('自在时间只允许毛球空间工具')
      const result = await next()
      if (result?.isError && this.active === state) {
        await this.update((data) => {
          const run = data.runs.find((item) => item.id === state.run.id)
          run.failures += 1
          state.run = run
          return { ok: true }
        })
        if (state.run.failures >= 2) await this.stop('repeated-tool-error')
      }
      return result
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const state = this.guards.get(agent)
      if (state?.stopping) this.release(state)
      else background(ctx.agents?.withoutInitiator ? ctx.agents.withoutInitiator(() => this.drive(agent)) : this.drive(agent))
    })
    ctx.on('agent/error', ({ agent }) => { if (this.active?.agent === agent) background(this.stop('host-error')) })
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.active?.agent === agent) background(this.stop('agent-disposed'))
      const state = this.guards.get(agent)
      if (state) this.release(state)
    })
    ctx.effect(() => () => {
      this.closed = true
      const state = this.active
      if (state) background(this.stop('plugin-unloaded', 'paused', true))
      for (const guarded of this.states) {
        if (guarded !== state && guarded.agent.status === 'running') guarded.agent.cancel({ kind: 'user' }, { keepInbox: true })
        this.release(guarded)
      }
    })
  }

  async execute(method, args, execution, body) {
    await this.accounting
    if (method === 'freetime') {
      const current = this.active
      if (current?.agent === execution.agent && !this.chargedExecutions.has(execution) && !['finish', 'pause', 'disable'].includes(args.action)) await this.charge(current, 'tools', 1)
      return this.control(args, execution)
    }
    if (method === 'history' && args.action === 'restore') await this.stop('restored', 'paused', true)
    const state = this.guards.get(execution.agent)
    if (!state) return this.store.withWriteContext({ signal: execution.signal }, body)
    this.assertCurrent(state)
    if (state.run.usage.tools >= state.run.limits.tools) { await this.stop('tool-budget'); throw new Error('自在时间工具预算已用尽') }
    const write = operationKind(method, args) === 'write'
    if (write) {
      if (!['space', 'interest', 'activity', 'object'].includes(method)) throw new Error('自在时间不能执行这个写入操作')
      if (state.run.pending) throw new Error('上次写入结果未知；请先读取该目标核对，不会自动重放')
      if (['interest', 'activity'].includes(method) && ['save', 'plan'].includes(args.action) && !args.id) args.id = `free-${randomUUID()}`
      if (method === 'interest') {
        const previous = args.action === 'update' ? await this.store.interest({ action: 'read', id: args.id }) : null
        if (args.kind === 'commitment' || previous?.interest?.kind === 'commitment') throw new Error('自在时间不能自行新增或修改对用户的承诺')
      }
      const needsVersion = method === 'object' || (method === 'space' && (['write', 'append'].includes(args.action) || args.scene))
      if (needsVersion && typeof args.expected_version !== 'string') throw new Error('自在时间修改前须先 read 并传 expected_version；新文件或物品用 missing')
      if (method === 'interest' && args.action === 'update' && typeof args.expected_version !== 'string') throw new Error('自在时间修改关注点前须 read 并传 expected_version')
      if (method === 'activity' && args.action === 'run') {
        const planned = await this.store.activity({ action: 'read', id: args.id })
        if (planned.activity?.status !== 'completed' && typeof planned.activity?.expected_version !== 'string') throw new Error('旧活动缺少目标版本；请读目标后 revise expected_version 再 run')
      }
    }
    if (!this.chargedExecutions.has(execution)) await this.charge(state, 'tools', 1)
    if (write) {
      const result = await this.update((data) => {
        const run = data.runs.find((item) => item.id === state.run.id)
        run.pending = { call_id: execution.callId || randomUUID(), method, action: args.action, path: args.path, id: args.id, at: new Date().toISOString(), outcome: 'unknown' }
        state.run = run
        return { ok: true }
      })
      if (!result.ok) throw new Error(result.error)
    }
    let result
    try {
      result = await this.store.withWriteContext({ signal: execution.signal, operationId: execution.callId, assertCurrent: () => this.assertCurrent(state) }, body)
    } catch (error) {
      // Preserve pending on an unknown outcome. No retry loop is started.
      await this.stop('tool-outcome-unknown')
      throw error
    }
    await this.update((data) => {
      const run = data.runs.find((item) => item.id === state.run.id)
      const pending = run.pending
      if ((write && result.ok) || (pending && (result.ok || result.exists === false) && pending.method === method && ((pending.path && pending.path === args.path) || (pending.id && pending.id === args.id)) && args.action === 'read')) run.pending = null
      run.failures = result.ok ? 0 : run.failures + 1
      if (write && result.ok && result.verified !== false) {
        const path = result.path || (result.activity?.status === 'completed' ? result.activity.result?.path : undefined)
        run.last_step = { tool: `maoqiu_${method}`, action: args.action, at: new Date().toISOString(), path, id: result.object?.id || result.activity?.id || result.interest?.id }
        if (path && !run.artifacts.includes(path)) run.artifacts.push(path)
        if (result.object?.id && !run.artifacts.includes(`object:${result.object.id}`)) run.artifacts.push(`object:${result.object.id}`)
      }
      state.run = { ...run, status: state.stopping ? state.run.status : run.status, stop_reason: state.stopping ? state.run.stop_reason : run.stop_reason }
      return { ok: true }
    })
    if (state.run.failures >= 2 && this.active === state) await this.stop('repeated-tool-error')
    return result
  }
}
