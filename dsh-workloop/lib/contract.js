/**
 * Task contract: the frozen truth source for a run.
 *
 * A contract is deliberately small — goal, deliverables, scope, claims and
 * policy. It never stores the current plan, subagent count or temporary
 * assumptions; those belong in the conversation, not in the record.
 */
import { hashOf, nowIso, qualityRank, QUALITIES, unique } from './util.js'
import { ORACLES } from './evidence.js'

export const PROFILES = [
  'audit_inspection',
  'small_repair',
  'project_creation',
  'research_synthesis',
  'ideation_design',
  'project_iteration',
  'non_programming_delivery',
  'mixed_project',
]

export const RISKS = ['low', 'medium', 'high']
export const REVIEW_LEVELS = ['none', 'self', 'peer', 'independent']

export const PROFILE_HINTS = {
  audit_inspection: '只读检查；审计完成 ≠ 对象健康，结论用 PASS_WITH_FINDINGS 语义写进 Claim。',
  small_repair: '小范围修复；默认 direct，不强制拆分。',
  project_creation: '从零创建；按里程碑循环，每轮一个可验证交付。',
  research_synthesis: '研究综合；Claim 状态用 confirmed/supported/probable/conflicting/unverified。',
  ideation_design: '构思设计；证据来自 rubric/权衡，不伪装成可执行测试。',
  project_iteration: '持续迭代；每轮记录保留行为、变化、回归风险与范围漂移。',
  non_programming_delivery: '报告/计划/内容交付；Oracle 用 document_rubric / artifact_integrity / citation_trace。',
  mixed_project: '阶段化混合项目；共享同一合同与事件链。',
}

const CLAIM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

function fail(message) {
  throw new Error(message)
}

/** Normalize a string list; non-string entries are rejected instead of coerced. */
function stringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`${field} 必须是字符串数组`)
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') fail(`${field} 不能包含空字符串`)
    return item.trim()
  })
}

export function claimHash(claim) {
  return hashOf({
    statement: claim.statement,
    required: claim.required,
    oracle: claim.oracle,
    minQuality: claim.minQuality,
    subjects: claim.subjects,
  })
}

/** Auto-assign the next stable claim id (AC-01, AC-02, …). */
export function nextClaimId(claims) {
  const used = new Set((claims || []).map((claim) => claim.id))
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `AC-${String(index).padStart(2, '0')}`
    if (!used.has(candidate)) return candidate
  }
  fail('Claim 数量超出上限（999）')
}

/** Validate and normalize one claim. */
export function normalizeClaim(raw, existing = []) {
  if (raw === null || typeof raw !== 'object') fail('claim 必须是对象')
  const statement = String(raw.statement ?? '').trim()
  if (statement === '') fail('claim.statement 不能为空')
  const id = raw.id === undefined ? nextClaimId(existing) : String(raw.id).trim()
  if (!CLAIM_ID_PATTERN.test(id)) fail(`claim.id ${JSON.stringify(id)} 不合法：需以字母开头，只含字母/数字/_/-，最长 32`)
  const oracle = unique(stringList(raw.oracle, 'claim.oracle'))
  if (oracle.length === 0) fail(`claim ${id} 必须声明至少一个 Oracle（可用：${Object.keys(ORACLES).join('、')}）`)
  const unknown = oracle.filter((name) => ORACLES[name] === undefined)
  if (unknown.length > 0) fail(`claim ${id} 使用了未知 Oracle：${unknown.join('、')}；可用：${Object.keys(ORACLES).join('、')}`)
  const minQuality = String(raw.minQuality ?? 'Q2').toUpperCase()
  if (!QUALITIES.includes(minQuality)) fail(`claim ${id} 的 minQuality 必须是 ${QUALITIES.join('/')}`)
  const subjects = stringList(raw.subjects, 'claim.subjects')
  const required = raw.required === undefined ? true : raw.required === true
  return { id, statement, required, oracle, minQuality, subjects, hash: claimHash({ statement, required, oracle, minQuality, subjects }) }
}

/** Validate and normalize a contract body (without version/hash metadata). */
export function buildContractBody(input = {}, { workspaceRoot = '' } = {}) {
  const goalText = String(input.goal ?? input.statement ?? '').trim()
  if (goalText === '') fail('goal 不能为空：合同必须包含用户可理解的目标')
  const profile = String(input.profile ?? 'small_repair')
  if (!PROFILES.includes(profile)) fail(`未知 profile：${profile}；可用：${PROFILES.join('、')}`)
  const risk = String(input.risk ?? 'low').toLowerCase()
  if (!RISKS.includes(risk)) fail(`risk 必须是 ${RISKS.join('/')}`)
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {}
  const allow = stringList(scope.allow, 'scope.allow')
  const protectedPaths = stringList(scope.protected, 'scope.protected')
  const policyInput = input.policy && typeof input.policy === 'object' ? input.policy : {}
  const review = String(policyInput.review ?? 'none').toLowerCase()
  if (!REVIEW_LEVELS.includes(review)) fail(`policy.review 必须是 ${REVIEW_LEVELS.join('/')}`)
  const claimsInput = Array.isArray(input.claims) ? input.claims : []
  const claims = []
  for (const raw of claimsInput) {
    const claim = normalizeClaim(raw, claims)
    if (claims.some((existing) => existing.id === claim.id)) fail(`claim id 重复：${claim.id}`)
    claims.push(claim)
  }
  return {
    goal: { statement: goalText },
    deliverables: stringList(input.deliverables, 'deliverables'),
    profile,
    risk,
    scope: { allow, protected: protectedPaths },
    claims,
    policy: {
      review,
      maxCycles: Number.isSafeInteger(policyInput.maxCycles) && policyInput.maxCycles > 0 ? policyInput.maxCycles : 20,
    },
    workspaceRoot: String(workspaceRoot ?? ''),
  }
}

/** Attach version metadata and a content hash. */
export function freeze(body, { version = 1, parent = null, goalEpoch = 0 } = {}) {
  const draft = {
    version,
    frozenAt: nowIso(),
    parent,
    goalEpoch,
    ...body,
  }
  return { ...draft, hash: hashOf(draft) }
}

/**
 * What an amendment means for existing evidence.
 *
 * v0.3 alignment: a changed goal does *not* mechanically void every piece of
 * evidence. It raises the goal epoch so older evidence is flagged for
 * re-evaluation (a limitation on the verdict) while evidence for unchanged
 * claims stays usable. A changed claim, by contrast, really does invalidate the
 * evidence bound to its old definition.
 */
export function diffContracts(previous, next) {
  const reasons = []
  const goalChanged =
    previous.goal.statement !== next.goal.statement ||
    hashOf(previous.deliverables) !== hashOf(next.deliverables)
  if (previous.goal.statement !== next.goal.statement) reasons.push('目标文本变化：旧证据需要重新评估')
  if (hashOf(previous.deliverables) !== hashOf(next.deliverables)) reasons.push('交付物变化：旧证据需要重新评估')

  const previousClaims = new Map((previous.claims || []).map((claim) => [claim.id, claim]))
  const claimsInvalidated = []
  const claimsAdded = []
  const claimsRemoved = []
  for (const claim of next.claims || []) {
    const before = previousClaims.get(claim.id)
    if (before === undefined) {
      claimsAdded.push(claim.id)
      continue
    }
    if (claimHash(before) !== claimHash(claim)) {
      claimsInvalidated.push(claim.id)
      reasons.push(`Claim ${claim.id} 定义变化：它的历史证据失效`)
    }
  }
  for (const claim of previous.claims || []) {
    if (!(next.claims || []).some((item) => item.id === claim.id)) {
      claimsRemoved.push(claim.id)
      claimsInvalidated.push(claim.id)
      reasons.push(`Claim ${claim.id} 被移除：它的历史证据失效`)
    }
  }

  const previousAllow = previous.scope?.allow || []
  const nextAllow = next.scope?.allow || []
  const scopeExpanded = nextAllow.some((pattern) => !previousAllow.includes(pattern))
  const scopeShrunk = previousAllow.some((pattern) => !nextAllow.includes(pattern))
  const protectedAdded = (next.scope?.protected || []).some(
    (pattern) => !(previous.scope?.protected || []).includes(pattern),
  )
  if (scopeExpanded) reasons.push('允许范围扩大：已有证据保留，但新增范围的动作需要重新授权')
  if (scopeShrunk) reasons.push('允许范围收缩：已授权的动作需要按新范围复核')
  if (protectedAdded) reasons.push('保护范围增加：涉及新增保护的证据与动作需要复核')
  const reviewRaised = qualityRank(reviewRank(next.policy?.review)) > qualityRank(reviewRank(previous.policy?.review))
  if (reviewRaised) reasons.push('复核要求提高：已有证据保留，复核记录必须重做')
  if (JSON.stringify(previous.policy) !== JSON.stringify(next.policy) && !reviewRaised) {
    reasons.push('策略变化：完成报告需重新生成')
  }

  return {
    goalChanged,
    claimsInvalidated,
    claimsAdded,
    claimsRemoved,
    scopeExpanded,
    scopeShrunk,
    protectedAdded,
    reviewRaised,
    reasons,
  }
}

function reviewRank(level) {
  return { none: 'Q0', self: 'Q0', peer: 'Q1', independent: 'Q2' }[level] ?? 'Q0'
}

/** Human-readable one-line contract summary used by tool output and context. */
export function describeContract(contract) {
  const required = (contract.claims || []).filter((claim) => claim.required)
  return [
    `目标：${contract.goal.statement}`,
    `Profile：${contract.profile}｜风险：${contract.risk}｜合同 v${contract.version}（${String(contract.hash).slice(0, 12)}）`,
    `交付物：${contract.deliverables.length ? contract.deliverables.join('；') : '未声明'}`,
    `范围：allow=${contract.scope.allow.length ? contract.scope.allow.join('、') : '（空=不允许任何写入）'}${contract.scope.protected.length ? `｜protected=${contract.scope.protected.join('、')}` : ''}`,
    `必过 Claim：${required.length ? required.map((claim) => `${claim.id}（≥${claim.minQuality}）`).join('、') : '无（仅记录）'}`,
    `复核策略：${contract.policy.review}`,
  ].join('\n')
}
