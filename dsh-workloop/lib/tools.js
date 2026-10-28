/**
 * The seven `work_*` tool definitions: contract, claim, action, evidence,
 * verdict, notice, learn.
 *
 * Schemas are plain JSON Schema; execution delegates to the store. Mutating
 * calls return enough state that the model can see whether a claim actually
 * became verifiable, and read-only calls are marked concurrency-safe.
 */
import { describeVerdict, evaluateClaim } from './verdict.js'
import { describeEvidence, stalenessOf } from './evidence.js'
import { qualityRank } from './util.js'

const string = (description) => ({ type: 'string', description })
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description })
const enumeration = (values, description) => ({ type: 'string', enum: values, description })

const claimSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: string('稳定 ID，如 AC-01；省略时自动分配'),
    statement: string('这条 Claim 要证明什么；必须可被 Oracle 检验'),
    oracle: { type: 'array', items: { type: 'string' }, description: '允许的 Oracle 名称' },
    minQuality: enumeration(['Q0', 'Q1', 'Q2', 'Q3'], '最低证据质量，默认 Q2；Q0 永不能满足完成'),
    subjects: strings('绑定的对象路径（工作区相对路径），用于指纹'),
    required: { type: 'boolean', description: '是否是完成必过 Claim，默认 true' },
  },
  required: ['statement', 'oracle'],
}

const scopeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    allow: strings('允许写入的路径/glob；空数组表示不允许任何写入'),
    protected: strings('受保护路径，优先级高于 allow'),
  },
}

const policySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    review: enumeration(['none', 'self', 'peer', 'independent'], '复核策略'),
    maxCycles: { type: 'integer', minimum: 1, description: '循环上限，仅作记录与提醒' },
  },
}

const observedSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    summary: string('观察到什么，以及期望/实际的关键差异'),
    command: string('真实执行的命令（非占位命令）'),
    exitCode: { type: 'integer', description: '命令退出码；单独出现不能作为完成证据' },
    expected: string('期望值/期望状态'),
    actual: string('实际观察值/状态'),
    by: string('声明型证据的来源：用户或复核者'),
    independent: { type: 'boolean', description: '复核是否来自独立上下文；声明而已也要如实写' },
    tests: { type: 'integer', description: '实际执行的测试数量；0 不算通过' },
    declaredEffects: { type: 'boolean', description: '命令副作用是否已完整声明' },
  },
}

const assuranceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    backend: enumeration(['host', 'workspace-write', 'danger-full-access', 'guarded_copy', 'unknown'], '执行后端'),
    isolated: { type: 'boolean', description: '是否真正隔离；不要仅因沙箱预设就写 true' },
  },
}

const confirmationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    by: string('确认人，通常是用户'),
    note: string('确认内容摘要，绑定当前合同版本与动作范围'),
  },
  required: ['by', 'note'],
}

const sourceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: enumeration(['user', 'inference', 'tool', 'external', 'creation'], '来源类型'),
    ref: string('可核对来源：命令、文件、URL、用户原话'),
  },
}

function jsonOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: value?.text ?? JSON.stringify(value, null, 2) }],
  }
}

const READ_ONLY_ACTIONS = new Set(['show', 'list', 'preview', 'verify'])

/** True when a call cannot mutate run state. */
export function isReadOnly(tool, args) {
  return READ_ONLY_ACTIONS.has(String(args?.action ?? ''))
}

export function buildTools(store, { enrich }) {
  const tools = []

  tools.push({
    name: 'work_contract',
    description:
      '工作闭环的合同与生命周期。start 冻结目标/交付物/范围/Claim；amend 修改合同（改变 Claim 定义会使对应旧证据失效，改变目标只会要求重新评估）；show/list 查看；block/resume/abandon 处理阻塞与终止。**只在确实需要跨步骤验收时开 Run**：解释、闲聊、一步能做完的小任务不需要。合同记录意图与边界，不记录执行计划。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['start', 'amend', 'show', 'list', 'block', 'resume', 'abandon'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        goal: string('start 必填；amend 时表示新目标'),
        deliverables: strings('交付物列表'),
        claims: { type: 'array', items: claimSchema, description: '验收 Claim 列表' },
        scope: scopeSchema,
        profile: enumeration(
          [
            'audit_inspection',
            'small_repair',
            'project_creation',
            'research_synthesis',
            'ideation_design',
            'project_iteration',
            'non_programming_delivery',
            'mixed_project',
          ],
          '任务类型，仅作默认行为提示',
        ),
        risk: enumeration(['low', 'medium', 'high'], '任务风险等级'),
        policy: policySchema,
        reason: string('amend/block/abandon 的原因'),
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_contract', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_contract')
      const action = String(input.action ?? '')
      if (action === 'start') {
        const result = await store.start(input, { workspaceRoot: input.workspaceRoot, actor: input.actor })
        return {
          runId: result.runId,
          contract: result.contract,
          text: [
            `已冻结合同 v1：${result.runId}`,
            `目标：${result.contract.goal.statement}`,
            `Profile：${result.contract.profile}｜风险：${result.contract.risk}｜必过 Claim：${
              result.contract.claims.filter((claim) => claim.required).map((claim) => claim.id).join('、') || '无'
            }`,
            '下一步：按 Claim 记录证据（work_evidence record）；不要先宣布完成。',
          ].join('\n'),
        }
      }
      if (action === 'list') {
        const runs = store.listRuns()
        return {
          runs,
          text: runs.length
            ? runs
                .slice(0, 20)
                .map((run) => `${run.runId}｜${run.status}｜${run.goal.slice(0, 60)}${run.verdict ? `｜结论 ${run.verdict}` : ''}`)
                .join('\n')
            : '还没有任何工作 Run。',
        }
      }
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      if (action === 'show') {
        const run = store.read(runId)
        const { verdict } = await store.preview(runId)
        return {
          runId,
          contract: run.contract,
          state: run.state,
          claims: run.contract.claims,
          evidenceCount: run.evidence.length,
          actionCount: run.actions.length,
          noticeCount: run.notices.length,
          learningCount: run.learning.length,
          verdict,
          text: [
            `Run ${runId}｜${run.state.status}｜合同 v${run.contract.version}`,
            `目标：${run.contract.goal.statement}`,
            `必过 Claim：${run.contract.claims.filter((claim) => claim.required).map((claim) => claim.id).join('、') || '无'}`,
            `证据 ${run.evidence.length} 条｜动作 ${run.actions.length} 条｜通知 ${run.notices.length} 条｜经验候选 ${run.learning.length} 条`,
            describeVerdict(verdict),
          ].join('\n'),
        }
      }
      if (action === 'amend') {
        const result = await store.amend(runId, {
          reason: input.reason || '合同修改',
          changes: {
            goal: input.goal,
            deliverables: input.deliverables,
            scope: input.scope,
            policy: input.policy,
            risk: input.risk,
            profile: input.profile,
          },
        })
        return {
          runId,
          contract: result.contract,
          diff: result.diff,
          invalidated: result.invalidated.map((record) => record.id),
          text: [
            `合同已升级到 v${result.contract.version}：${runId}（goalEpoch ${result.contract.goalEpoch}）`,
            `影响：${result.diff.reasons.join('；') || '无边界变化'}`,
            result.invalidated.length ? `已失效证据：${result.invalidated.map((record) => record.id).join('、')}` : '没有证据被强制失效',
            result.diff.goalChanged ? '目标已变：旧证据仍保留，但会在结论中标记为待重新评估。' : '',
            result.diff.scopeExpanded ? '新增范围的动作需要重新授权。' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }
      if (action === 'block') {
        const result = await store.block(runId, input.reason || '未说明原因')
        return { runId, state: result.state, text: `Run ${runId} 已标记 blocked：${input.reason || '未说明原因'}` }
      }
      if (action === 'resume') {
        const result = await store.resume(runId)
        return { runId, state: result.state, text: `Run ${runId} 已恢复 active。` }
      }
      if (action === 'abandon') {
        const result = await store.abandon(runId, input.reason || '未说明原因')
        return { runId, state: result.state, text: `Run ${runId} 已放弃。原因：${input.reason || '未说明原因'}` }
      }
      throw new Error(`未知 action：${action}`)
    },
  })

  tools.push({
    name: 'work_claim',
    description:
      '增删改查验收 Claim。Claim 是完成判定的最小单位：必须有可检验的 Oracle 与最低证据质量。修改 Claim 定义会生成新合同版本，并使绑定旧定义的历史证据失效——这是有意为之，不是噪声。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['add', 'update', 'remove', 'list'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        claim: claimSchema,
        id: string('remove 时必填；update 时可用它指定目标 Claim'),
        reason: string('变更原因（默认“Claim 变更”）'),
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_claim', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_claim')
      const action = String(input.action ?? '')
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      if (action === 'list') {
        const run = store.read(runId)
        const lines = run.contract.claims.map((claim) => {
          const count = run.evidence.filter((record) => record.claimId === claim.id).length
          return `${claim.id}｜${claim.required ? '必过' : '可选'}｜≥${claim.minQuality}｜${claim.oracle.join('/')}｜证据 ${count} 条｜${claim.statement}`
        })
        return { runId, claims: run.contract.claims, text: lines.join('\n') || '还没有 Claim。' }
      }
      if (action === 'add') {
        if (input.claim === undefined) throw new Error('add 需要 claim')
        const result = await store.amend(runId, {
          reason: input.reason || '新增 Claim',
          claimOps: [{ action: 'add', claim: input.claim }],
        })
        const added = result.contract.claims[result.contract.claims.length - 1]
        return {
          runId,
          claim: added,
          text: `已加入 ${added.id}，合同升级到 v${result.contract.version}。记得为它记录证据。`,
        }
      }
      if (action === 'update') {
        if (input.claim === undefined) throw new Error('update 需要 claim')
        const claim = { ...input.claim, id: input.claim.id || input.id }
        if (!claim.id) throw new Error('update 需要 claim.id 或 id')
        const result = await store.amend(runId, {
          reason: input.reason || `更新 ${claim.id}`,
          claimOps: [{ action: 'update', claim }],
        })
        return {
          runId,
          contract: result.contract,
          text: `已更新 ${claim.id}，合同升级到 v${result.contract.version}；旧证据失效：${result.invalidated.map((record) => record.id).join('、') || '无'}`,
        }
      }
      if (action === 'remove') {
        const id = String(input.id ?? input.claim?.id ?? '')
        if (id === '') throw new Error('remove 需要 id')
        const result = await store.amend(runId, {
          reason: input.reason || `移除 ${id}`,
          claimOps: [{ action: 'remove', id }],
        })
        return { runId, contract: result.contract, text: `已移除 ${id}，合同升级到 v${result.contract.version}。` }
      }
      throw new Error(`未知 action：${action}`)
    },
  })

  tools.push({
    name: 'work_action',
    description:
      '在执行写入/删除/命令/联网/外部操作前声明动作，由合同范围做记录级门禁。execute 必须声明完整副作用；高风险动作必须带用户确认。**强制力仅为记录级**：插件不拦截宿主工具调用，也不宣称沙箱隔离；真正的权限边界仍由 DSH 权限/审批/沙箱负责。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['declare', 'list'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        kind: enumeration(['read', 'write', 'create', 'delete', 'execute', 'network', 'external'], '动作类型'),
        intent: string('这次动作要达到什么（会被记录）'),
        targets: strings('目标路径/对象（工作区相对路径）'),
        effects: {
          type: 'object',
          additionalProperties: false,
          properties: {
            write: strings('预计写入路径'),
            create: strings('预计创建路径'),
            delete: strings('预计删除路径'),
            network: { type: 'boolean', description: '是否联网' },
            external: { type: 'boolean', description: '是否有外部副作用' },
          },
        },
        risk: enumeration(['low', 'medium', 'high'], '风险等级；不填按动作类型推导'),
        confirmation: confirmationSchema,
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_action', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_action')
      const action = String(input.action ?? '')
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      if (action === 'list') {
        const run = store.read(runId)
        const lines = run.actions.map(
          (record) =>
            `${record.id}｜${record.kind}｜${record.decision}｜${record.intent}${record.targets?.length ? `｜${record.targets.join('、')}` : ''}`,
        )
        return { runId, actions: run.actions, text: lines.join('\n') || '还没有动作记录。' }
      }
      if (action !== 'declare') throw new Error(`未知 action：${action}`)
      const result = await store.action(runId, {
        kind: input.kind,
        intent: input.intent,
        targets: input.targets,
        effects: input.effects,
        risk: input.risk,
        confirmation: input.confirmation,
        actor: input.actor,
      })
      const gate = result.gate
      const text =
        gate.decision === 'authorized'
          ? `已授权 ${result.action.id}（${result.action.kind}/${result.action.risk}）：${result.action.intent}`
          : gate.decision === 'confirmation_required'
            ? `需要用户确认后才能执行：${gate.reason}`
            : `已拒绝并记录：${gate.reason}`
      return { runId, action: result.action, gate, text }
    },
  })

  tools.push({
    name: 'work_evidence',
    description:
      '记录/查看证据。Oracle 决定比较什么：file_exists/file_contains/file_equals/target_state/tests_pass/command_output/artifact_exists/document_rubric/citation_trace/user_acceptance/review_record。声明质量只是上限，插件只会下调：占位命令、非零退出码、0 个测试或 inconclusive 不能支撑通过；证据对象必须落在 Claim subjects 内，缺对象指纹或缺观察摘要最高 Q1，Q3 需独立来源。复核用 oracle=review_record（claimId 省略）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['record', 'list', 'verify'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        claimId: string('证据要支撑的 Claim；record 必填（review_record 除外）'),
        oracle: enumeration(
          [
            'file_exists',
            'file_contains',
            'file_equals',
            'target_state',
            'tests_pass',
            'command_output',
            'artifact_exists',
            'document_rubric',
            'citation_trace',
            'user_acceptance',
            'review_record',
          ],
          '比较方式',
        ),
        quality: enumeration(['Q0', 'Q1', 'Q2', 'Q3'], '声明质量（会被下调，不会上调）'),
        status: enumeration(['supporting', 'refuting', 'inconclusive'], '证据对 Claim 的作用'),
        subjects: strings('绑定的对象路径（工作区相对路径），记录时取指纹'),
        observed: observedSchema,
        assurance: assuranceSchema,
        limitations: strings('已知限制，会传递到最终结论'),
        id: string('verify 时可选：只检查某条证据'),
        source: sourceSchema,
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_evidence', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_evidence')
      const action = String(input.action ?? '')
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      const run = store.read(runId)
      if (action === 'list') {
        const records = input.claimId ? run.evidence.filter((record) => record.claimId === input.claimId) : run.evidence
        const lines = records.map((record) => {
          const staleInfo = stalenessOf(record, { workspaceRoot: run.contract.workspaceRoot })
          return `${describeEvidence(record)}${staleInfo.stale ? `｜失效：${staleInfo.reasons.join('；')}` : ''}`
        })
        return { runId, evidence: records, text: lines.join('\n') || '还没有证据。' }
      }
      if (action === 'verify') {
        const records = input.id ? run.evidence.filter((record) => record.id === input.id) : run.evidence
        const checked = records.map((record) => {
          const staleInfo = stalenessOf(record, { workspaceRoot: run.contract.workspaceRoot })
          return { id: record.id, claimId: record.claimId, quality: record.quality, stale: staleInfo.stale, reasons: staleInfo.reasons }
        })
        return {
          runId,
          checked,
          text: checked
            .map((item) => `${item.id}｜${item.stale ? '已失效' : '当前有效'}${item.reasons.length ? `：${item.reasons.join('；')}` : ''}`)
            .join('\n'),
        }
      }
      if (action !== 'record') throw new Error(`未知 action：${action}`)
      const result = await store.evidence(runId, {
        claimId: input.claimId,
        oracle: input.oracle,
        quality: input.quality,
        status: input.status,
        subjects: input.subjects,
        observed: input.observed,
        assurance: input.assurance,
        limitations: input.limitations,
        source: input.source,
        actor: input.actor,
      })
      const record = result.evidence
      let claimLine = ''
      if (record.claimId && record.claimId !== '@review') {
        const runAfter = store.read(runId)
        const claim = runAfter.contract.claims.find((item) => item.id === record.claimId)
        if (claim) {
          const evaluated = evaluateClaim(claim, runAfter.evidence, {
            workspaceRoot: runAfter.contract.workspaceRoot,
          }, runAfter.contract.goalEpoch ?? 0)
          claimLine = `${claim.id} 现在${evaluated.met ? '已满足' : '仍未满足'}（有效证据 ${evaluated.current.join('、') || '无'}）`
        }
      }
      const downgraded = qualityRank(record.quality) < qualityRank(record.declaredQuality)
      return {
        runId,
        evidence: record,
        text: [
          `已记录 ${record.id}：${record.claimId ?? '复核'}｜声明 ${record.declaredQuality} → 有效 ${record.quality}｜${record.status}`,
          record.reasons.length ? `下调原因：${record.reasons.join('；')}` : '',
          record.limitations.length ? `限制：${record.limitations.join('；')}` : '',
          downgraded ? '注意：声明质量未被接受，最终判定按有效质量计算。' : '',
          claimLine,
        ]
          .filter(Boolean)
          .join('\n'),
      }
    },
  })

  tools.push({
    name: 'work_verdict',
    description:
      '计算完成判定。preview 只预览；finalize 收尾并写入 verdict.json。判定只由当前合同、当前对象指纹与有效证据算出：必过 Claim 未满足不会 PASS；有限制最多 DEGRADED；非 PASS 收尾必须显式 acknowledgeGaps+knownGaps 或 block。工具层能保证「调用了 finalize 就出不了假 PASS」，但不能阻止模型完全不调用工具直接宣称完成。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['preview', 'finalize'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        summary: string('交付摘要（finalize 时记录）'),
        blockedReason: string('收尾时标记阻塞原因'),
        acknowledgeGaps: { type: 'boolean', description: '明确承认还有缺口后再收尾' },
        knownGaps: string('已知缺口；与 acknowledgeGaps 一起使用'),
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_verdict', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_verdict')
      const action = String(input.action ?? '')
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      if (action === 'preview') {
        const { verdict } = await store.preview(runId)
        return { runId, verdict, text: describeVerdict(verdict) }
      }
      if (action !== 'finalize') throw new Error(`未知 action：${action}`)
      const result = await store.finalize(runId, {
        summary: input.summary,
        blockedReason: input.blockedReason,
        acknowledgeGaps: input.acknowledgeGaps === true,
        knownGaps: input.knownGaps,
      })
      return {
        runId,
        verdict: result.verdict,
        state: result.state,
        text: [describeVerdict(result.verdict), result.verdict.summary ? `摘要：${result.verdict.summary}` : '']
          .filter(Boolean)
          .join('\n'),
      }
    },
  })

  tools.push({
    name: 'work_notice',
    description:
      '协作感知台账：记录对当前任务有影响的新发现、冲突、阻塞、请求、建议或质疑，并按主题去重、限制噪声。post 只写入本 Run 的台账，**不代表已送达或对方已读**；实际投递仍用 DSH 原生消息/团队任务，收到方用 ack 明确确认，resolve 表示已处理。未确认的 blocker 会进入最终结论的限制项。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['post', 'list', 'ack', 'resolve'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        kind: enumeration(['discovery', 'conflict', 'blocker', 'request', 'suggestion', 'challenge'], '通知类型'),
        topic: string('短主题，用于去重与合并'),
        summary: string('具体内容：新事实、冲突点、阻塞原因或请求'),
        recipients: strings('应看到这条信息的 Agent/session 标识（声明，未认证）'),
        id: string('ack/resolve 时必填'),
        by: string('ack/resolve 时必填：谁确认/处理'),
        note: string('处理说明'),
        state: enumeration(['recorded', 'acked', 'resolved'], 'list 时可过滤'),
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_notice', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_notice')
      const action = String(input.action ?? '')
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      if (action === 'list') {
        const run = store.read(runId)
        const notices = input.state ? run.notices.filter((notice) => notice.state === input.state) : run.notices
        return {
          runId,
          notices,
          text:
            notices
              .map(
                (notice) =>
                  `${notice.id}｜${notice.kind}｜${notice.state}｜${notice.topic}｜${notice.summary.slice(0, 120)}${notice.ackedBy ? `｜ack:${notice.ackedBy}` : ''}`,
              )
              .join('\n') || '还没有通知。',
        }
      }
      if (action === 'post') {
        const result = await store.postNotice(runId, {
          kind: input.kind,
          topic: input.topic,
          summary: input.summary,
          recipients: input.recipients,
          actor: input.actor,
        })
        return {
          runId,
          notice: result.notice,
          deduped: result.deduped,
          text: result.deduped
            ? `重复通知已抑制：${result.notice.id}（${result.notice.topic}），同一主题 ${Math.round(store.dedupeSeconds / 60)} 分钟内不重复记录。`
            : `已记录 ${result.notice.id}（${result.notice.kind}）：${result.notice.topic}。记录不代表送达；请用 DSH 原生消息/团队任务实际投递，收到方 work_notice ack 才算确认。`,
        }
      }
      if (action === 'ack' || action === 'resolve') {
        const id = String(input.id ?? '')
        if (id === '') throw new Error(`${action} 需要 id`)
        const result = await store.setNoticeState(runId, {
          id,
          state: action === 'ack' ? 'acked' : 'resolved',
          by: input.by,
          note: input.note,
        })
        return {
          runId,
          notice: result.notice,
          text:
            action === 'ack'
              ? `已确认收到 ${id}（by ${result.notice.ackedBy}）。这只证明有人明确确认，不证明对方已理解或已处理。`
              : `已标记解决 ${id}。`,
        }
      }
      throw new Error(`未知 action：${action}`)
    },
  })

  tools.push({
    name: 'work_learn',
    description:
      '从已完成的工作中提出经验候选（可复用的排查路线、验证方法、兼容性陷阱、协作冲突处理），附适用范围、来源与验证程度。propose 只写入本 Run 的候选文件，**不写毛球空间**；由主会话确认后用 maoqiu_experience 手动沉淀。子 agent 不得调用 propose。没有新知识、缺乏依据或只与单次环境有关的内容，宁可不提。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: enumeration(['propose', 'list'], '操作'),
        runId: string('Run ID；省略时使用当前工作区最新的 active Run'),
        title: string('经验标题'),
        content: string('具体做法 + 证据局限；不要写成语录'),
        scope: string('适用范围：项目路径、话题或任务类型'),
        source: sourceSchema,
        evidenceIds: strings('支撑这条经验的证据 ID（EV-*），用于判断验证程度'),
      },
    },
    output: jsonOutput(),
    isConcurrencySafe: (args) => isReadOnly('work_learn', args),
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, 'work_learn')
      const action = String(input.action ?? '')
      const runId = resolveRunId(store, input.runId, input.workspaceRoot, input.actor)
      if (action === 'list') {
        const run = store.read(runId)
        return {
          runId,
          learning: run.learning,
          text:
            run.learning
              .map(
                (item) =>
                  `${item.id}｜${item.verification}｜${item.scope}｜${item.title}\n  交接：maoqiu_experience(action="save", title=${JSON.stringify(item.title)}, content=${JSON.stringify(item.content)}, scope=${JSON.stringify(item.scope)}, status="candidate", source={"kind":"${item.source.kind}","ref":${JSON.stringify(item.source.ref)}})`,
              )
              .join('\n') || '还没有经验候选。',
        }
      }
      if (action !== 'propose') throw new Error(`未知 action：${action}`)
      const result = await store.proposeLearning(runId, {
        title: input.title,
        content: input.content,
        scope: input.scope,
        source: input.source,
        evidenceIds: input.evidenceIds,
        actor: input.actor,
      })
      const item = result.learning
      return {
        runId,
        learning: item,
        text: [
          `已记录候选 ${item.id}（${item.verification}）：${item.title}`,
          '尚未写入毛球空间；由主会话确认是否用 maoqiu_experience 沉淀为 candidate。',
        ].join('\n'),
      }
    },
  })

  return tools
}

/** Resolve the run a tool call targets. */
export function resolveRunId(store, runId, workspaceRoot, actor = null) {
  if (runId !== undefined && runId !== null && String(runId).trim() !== '') return String(runId).trim()
  const ownerSession = actor && typeof actor === 'object' ? actor.ownerSession || actor.session : ''
  const active = store.activeRun(workspaceRoot, ownerSession)
  if (active === null) {
    throw new Error(
      ownerSession
        ? '没有 active 的 Run（当前会话没有属于自己的 active Run）：先 work_contract start，或显式传入 runId；闲聊或一步能做完的小任务不需要开 Run。'
        : '没有 active 的 Run：先 work_contract start；闲聊或一步能做完的小任务不需要开 Run。',
    )
  }
  return active.runId
}

export { READ_ONLY_ACTIONS }
