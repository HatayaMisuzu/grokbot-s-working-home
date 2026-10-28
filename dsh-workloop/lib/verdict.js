/**
 * Verdict: the only place a run may be called complete.
 *
 * A verdict is computed from the current contract, current fingerprints and
 * recorded evidence. The model can ask for a preview or finalize, but it can
 * never hand in a status of its own.
 *
 * v0.3 alignment: a changed goal does not silently void evidence — it flags
 * the affected evidence for re-evaluation and keeps the run honest through a
 * limitation rather than a mechanical reset.
 */
import { compileScope, matchesAny, nowIso, normalizeRel, qualityRank, unique } from './util.js'
import { stalenessOf, subjectsMatchClaim } from './evidence.js'

const REVIEW_RANK = { none: 0, self: 1, peer: 2, independent: 3 }

/**
 * Evaluate one claim against the evidence list.
 *
 * Evidence counts when it is current (not stale), bound to this claim version,
 * and at or above the claim's minimum quality. Evidence recorded before the
 * latest goal change still counts, but is reported as needing re-evaluation.
 */
export function evaluateClaim(claim, evidence, run, goalEpoch = 0) {
  const all = evidence.filter((record) => record.claimId === claim.id)
  const relevant = all.filter((record) => record.status === 'supporting')
  const stale = []
  const belowMinimum = []
  const current = []
  const subjectMismatch = []
  // Q0 is an observation/placeholder bucket.  Even a Claim that mistakenly
  // asks for Q0 must still have real, non-zero-quality support to pass.
  const minimumRank = Math.max(1, qualityRank(claim.minQuality))

  for (const record of relevant) {
    const staleInfo = stalenessOf(record, run)
    if (staleInfo.stale) {
      stale.push({ id: record.id, reasons: staleInfo.reasons })
      continue
    }
    if (record.claimHash !== null && record.claimHash !== claim.hash) {
      stale.push({ id: record.id, reasons: ['Claim 定义已变化，证据失效'] })
      continue
    }
    if (!subjectsMatchClaim(record.subjects, claim.subjects)) {
      subjectMismatch.push({ id: record.id })
      continue
    }
    if (qualityRank(record.quality) < minimumRank) {
      belowMinimum.push({ id: record.id, quality: record.quality })
      continue
    }
    current.push(record)
  }

  // A claim is re-evaluated once it has evidence recorded after the latest goal
  // change; older evidence alone keeps the claim met but flags the gap.
  const fresh = current.filter((record) => Number(record.goalEpoch ?? 0) >= goalEpoch)
  const needsReevaluation = fresh.length === 0 ? current.map((record) => record.id) : []

  const refuted = all.filter((record) => {
    if (record.status !== 'refuting') return false
    if (stalenessOf(record, run).stale) return false
    if (record.claimHash !== null && record.claimHash !== claim.hash) return false
    if (!subjectsMatchClaim(record.subjects, claim.subjects)) return false
    return qualityRank(record.quality) >= minimumRank
  })

  const reasons = []
  if (refuted.length > 0) reasons.push(`存在反驳证据：${refuted.map((record) => record.id).join('、')}`)
  if (all.length === 0) reasons.push('没有证据')
  else if (current.length === 0 && stale.length > 0) reasons.push('已有证据全部失效')
  else if (current.length === 0 && belowMinimum.length > 0) {
    reasons.push(`证据质量不足：${belowMinimum.map((item) => `${item.id}=${item.quality}`).join('、')}，需要至少 Q1 且满足 ${claim.minQuality}`)
  }
  if (current.length === 0 && subjectMismatch.length > 0) {
    reasons.push(`证据对象与 Claim subjects 不匹配：${subjectMismatch.map((item) => item.id).join('、')}`)
  }

  return {
    id: claim.id,
    statement: claim.statement,
    required: claim.required,
    minQuality: claim.minQuality,
    met: current.length > 0 && refuted.length === 0,
    current: current.map((record) => record.id),
    stale,
    belowMinimum,
    subjectMismatch,
    needsReevaluation,
    reasons,
  }
}

function evaluateReview(contract, evidence, run) {
  const level = contract.policy?.review ?? 'none'
  const required = level !== 'none'
  if (!required) return { required: false, satisfied: true, level: 'none', reason: '' }
  const goalEpoch = contract.goalEpoch ?? 0
  const records = evidence.filter((record) => record.oracle === 'review_record')
  const current = records.filter((record) => {
    if (stalenessOf(record, run).stale) return false
    if (Number(record.goalEpoch ?? 0) < goalEpoch) return false
    if (record.status !== 'supporting') return false
    if (qualityRank(record.quality) < REVIEW_RANK.peer) return false
    return record.claimId === null || record.claimId === undefined || record.claimId === '@review'
  })
  if (current.length === 0) {
    return {
      required: true,
      satisfied: false,
      level: 'none',
      reason: `合同要求 ${level} 复核，但没有当前复核记录（目标变更后需重做复核）`,
    }
  }
  const best = current.reduce(
    (winner, record) => {
      const rank = record.observed?.independent === true ? REVIEW_RANK.independent : REVIEW_RANK.peer
      return rank > (winner.rank ?? 0) ? { rank, record } : winner
    },
    { rank: 0, record: null },
  )
  if (level === 'independent' && best.rank < REVIEW_RANK.independent) {
    return {
      required: true,
      satisfied: false,
      level: 'peer',
      reason: '要求 independent，但现有复核声明为 peer/未证实独立上下文',
    }
  }
  return {
    required: true,
    satisfied: true,
    level: best.rank >= REVIEW_RANK.independent ? 'independent' : 'peer',
    reason: '',
  }
}

/**
 * Compute the verdict. Notices, scope findings and integrity issues add limits;
 * they never upgrade a result.
 */
export function computeVerdict({
  contract,
  evidence = [],
  actions = [],
  notices = [],
  state = {},
  run = null,
  integrity = null,
}) {
  const goalEpoch = contract.goalEpoch ?? 0
  const evaluated = (contract.claims || []).map((claim) => evaluateClaim(claim, evidence, run, goalEpoch))
  const required = evaluated.filter((claim) => claim.required)
  const metAll = required.every((claim) => claim.met)
  const metSome = evaluated.some((claim) => claim.met)
  const review = evaluateReview(contract, evidence, run)
  const limitations = []
  const warnings = []
  const next = []

  for (const claim of evaluated) {
    if (!claim.required || claim.met) continue
    const label = claim.reasons.length > 0 ? `（${claim.reasons.join('；')}）` : ''
    next.push(`为 ${claim.id} 补充当前、≥${claim.minQuality} 的支撑证据${label}`)
  }
  if (!review.satisfied) next.push(`补齐 ${contract.policy.review} 复核记录后再完成`)

  for (const record of evidence) {
    for (const limitation of record.limitations || []) limitations.push(limitation)
  }
  for (const claim of evaluated) {
    for (const item of claim.stale) limitations.push(`证据 ${item.id} 已失效：${item.reasons.join('；')}`)
  }
  if (!review.satisfied) limitations.push(review.reason)

  // Re-evaluation after a goal change: keep the evidence, report the gap.
  const reevaluation = evaluated.flatMap((claim) =>
    claim.needsReevaluation.map((id) => ({ claimId: claim.id, id })),
  )
  if (reevaluation.length > 0) {
    limitations.push(
      `目标/交付物已变更，${reevaluation.length} 条旧证据需要重新评估：${reevaluation
        .map((item) => `${item.id}(${item.claimId})`)
        .join('、')}`,
    )
    next.push('对目标变更前的关键证据做一次重新验证，或记录新的观察')
  }

  // Side-effect boundary is never implied by functional evidence; command
  // evidence already carries that limitation from grading.

  const denied = actions.filter((action) => action.decision === 'denied')
  if (denied.length > 0) {
    limitations.push(`存在越界动作尝试：${denied.map((action) => `${action.kind}:${action.intent}`).join('；')}`)
  }
  const staleConfirmations = actions.filter(
    (action) =>
      action.decision === 'authorized' &&
      action.risk === 'high' &&
      action.contractHash !== undefined &&
      action.contractHash !== contract.hash,
  )
  if (staleConfirmations.length > 0) {
    limitations.push('部分高风险动作的确认绑定在旧合同版本上，需重新确认')
  }

  // Actions authorized under a wider scope must be re-checked after a shrink.
  const allow = compileScope(contract.scope?.allow || [])
  const outsideScope = actions.filter(
    (action) =>
      action.decision === 'authorized' &&
      Array.isArray(action.targets) &&
      action.targets.some((target) => !matchesAny(normalizeRel(target), allow)),
  )
  if (outsideScope.length > 0) {
    limitations.push(`已有动作超出当前合同范围：${outsideScope.map((action) => action.id).join('、')}`)
  }

  // Collaboration notices: only explicit acknowledgement counts.
  const unackedBlockers = notices.filter((notice) => notice.state === 'recorded' && notice.kind === 'blocker')
  if (unackedBlockers.length > 0) {
    limitations.push(`存在未确认的阻塞通知：${unackedBlockers.map((notice) => notice.id).join('、')}`)
    next.push('处理或确认阻塞通知（work_notice ack），或说明为何可以忽略')
  }
  const unackedConflicts = notices.filter((notice) => notice.state === 'recorded' && notice.kind === 'conflict')
  if (unackedConflicts.length > 0) {
    warnings.push(`未确认的冲突通知：${unackedConflicts.map((notice) => notice.id).join('、')}`)
  }

  if (integrity && Array.isArray(integrity.problems) && integrity.problems.length > 0) {
    limitations.push(`事件链完整性问题：${integrity.problems.join('；')}`)
  }

  // Repeated dead ends are a planning signal, not a reason to keep retrying.
  for (const claim of evaluated) {
    const failures = evidence.filter(
      (record) =>
        record.claimId === claim.id &&
        record.status !== 'supporting' &&
        qualityRank(record.quality) >= qualityRank(claim.minQuality),
    )
    if (failures.length >= 2) {
      warnings.push(`${claim.id} 连续未通过（${failures.length} 条反驳/不确定证据）：换验证方式或重规划，不要机械重试`)
    }
  }
  const intents = new Map()
  for (const action of actions) {
    if (action.decision !== 'authorized') continue
    const key = `${action.kind}:${action.intent}`
    intents.set(key, (intents.get(key) || 0) + 1)
  }
  for (const [key, count] of intents) {
    if (count >= 3) warnings.push(`同一动作重复 ${count} 次（${key}）：确认是否卡住，必要时 block`)
  }
  const noticeTopics = new Map()
  for (const notice of notices) {
    const key = `${notice.kind}:${notice.topic}`
    noticeTopics.set(key, (noticeTopics.get(key) || 0) + 1)
  }
  for (const [key, count] of noticeTopics) {
    if (count >= 4) warnings.push(`同一主题通知重复 ${count} 次（${key}）：合并或解决，避免噪声`)
  }

  let verdict = 'FAIL'
  if (state.status === 'abandoned') verdict = 'CANCELLED'
  else if (state.status === 'blocked') verdict = 'BLOCKED'
  else if (required.length === 0) verdict = 'NOT_READY'
  else if (metAll) verdict = limitations.length > 0 || warnings.length > 0 ? 'DEGRADED' : 'PASS'
  else if (metSome) verdict = 'PARTIAL'

  const uniqueLimitations = unique(limitations)
  return {
    runId: contract.runId,
    at: nowIso(),
    contractVersion: contract.version,
    contractHash: contract.hash,
    goalEpoch,
    verdict,
    passEligible: verdict === 'PASS',
    enforcement: 'recorded',
    claims: evaluated,
    review,
    limitations: uniqueLimitations,
    warnings: unique(warnings),
    next: unique(next),
    missing: required.filter((claim) => !claim.met).map((claim) => claim.id),
    stale: evaluated.flatMap((claim) => claim.stale.map((item) => ({ claimId: claim.id, ...item }))),
    needsReevaluation: reevaluation,
  }
}

/** One-line verdict summary for tool output and the active-run context. */
export function describeVerdict(verdict) {
  const required = verdict.claims.filter((claim) => claim.required)
  const met = required.filter((claim) => claim.met).length
  return [
    `结论：${verdict.verdict}${verdict.passEligible ? '（可交付）' : '（不可宣称 PASS）'}`,
    `必过 Claim：${met}/${required.length}${verdict.missing.length ? `；缺：${verdict.missing.join('、')}` : ''}`,
    verdict.limitations.length ? `限制：${verdict.limitations.slice(0, 5).join('；')}` : '',
    verdict.next.length ? `下一步：${verdict.next.slice(0, 5).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
