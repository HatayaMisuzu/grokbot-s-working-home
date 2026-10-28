/**
 * Evidence: what counts as proof, and what only looks like proof.
 *
 * The quality a caller declares is an upper bound, never a fact. Every rule
 * below can only *lower* the effective quality, which is what makes the later
 * verdict trustworthy: `assert True`, an exit code, or a bare file read can
 * never be promoted by assertion.
 */
import { resolve } from 'node:path'
import {
  compileScope,
  fileSha256,
  isPlaceholderCommand,
  matchesAny,
  normalizeRel,
  qualityAt,
  qualityRank,
  unique,
} from './util.js'

/**
 * Return true when every fingerprinted evidence subject falls inside a subject
 * scope declared by the Claim. An empty Claim scope intentionally means that
 * the Claim has no subject binding; subject-requiring Oracles are still
 * rejected by their own rule below. A scoped Claim always needs at least one
 * matching evidence subject, so an empty evidence list cannot bypass scope.
 */
export function subjectsMatchClaim(evidenceSubjects, claimSubjects) {
  const patterns = compileScope(Array.isArray(claimSubjects) ? claimSubjects : [])
  if (patterns.length === 0) return true
  const subjects = Array.isArray(evidenceSubjects) ? evidenceSubjects : []
  if (subjects.length === 0) return false
  return subjects.every((subject) => {
    const path = normalizeRel(typeof subject === 'string' ? subject : subject?.path)
    return path !== '' && matchesAny(path, patterns)
  })
}

/**
 * Oracles describe what a piece of evidence compares.
 *
 * - requiresSubjects: proof must bind to concrete fingerprinted objects.
 * - commandBased: proof must include the real command and its exit code.
 * - attested: proof is a human/reviewer statement, not a machine comparison.
 */
export const ORACLES = {
  file_exists: {
    label: '目标文件存在',
    requiresSubjects: true,
    commandBased: false,
    attested: false,
    hint: 'fingerprint the file; existence alone is weak unless the claim is about existence',
  },
  file_contains: {
    label: '文件包含指定内容',
    requiresSubjects: true,
    commandBased: false,
    attested: false,
    hint: '记录 observed.expected / observed.actual 与行号',
  },
  file_equals: {
    label: '目标状态与期望一致',
    requiresSubjects: true,
    commandBased: false,
    attested: false,
    hint: '比较前做换行归一化，记录期望与实际的差异位置',
  },
  target_state: {
    label: '对象当前状态符合目标',
    requiresSubjects: true,
    commandBased: false,
    attested: false,
    hint: '最常用的修复类 Oracle：绑定文件指纹 + 期望内容/结构',
  },
  tests_pass: {
    label: '测试实际执行并通过',
    requiresSubjects: true,
    commandBased: true,
    attested: false,
    hint: '必须给真实命令、退出码、测试数量；0 个测试的“通过”不算',
  },
  command_output: {
    label: '命令输出与期望一致',
    requiresSubjects: true,
    commandBased: true,
    attested: false,
    hint: '记录命令、退出码与关键输出片段，不要把退出码当唯一证据',
  },
  artifact_exists: {
    label: '产物存在且可校验',
    requiresSubjects: true,
    commandBased: false,
    attested: false,
    hint: '产物路径 + 指纹；非文本产物可用大小/哈希',
  },
  document_rubric: {
    label: '按 rubric 检查交付文档',
    requiresSubjects: false,
    commandBased: false,
    attested: false,
    hint: '逐条列出 rubric 项与结论，不伪装成可执行测试',
  },
  citation_trace: {
    label: '引用可追溯',
    requiresSubjects: true,
    commandBased: false,
    attested: false,
    hint: 'Claim 里的每个事实都要能落到来源',
  },
  user_acceptance: {
    label: '用户明确接受',
    requiresSubjects: false,
    commandBased: false,
    attested: true,
    hint: 'record observed.by 与用户原话摘要；这是声明，不是系统认证',
  },
  review_record: {
    label: '复核记录',
    requiresSubjects: false,
    commandBased: false,
    attested: true,
    hint: '记录 reviewer、session 差异与是否只读；独立复核需独立上下文',
  },
}

const STATUSES = ['supporting', 'refuting', 'inconclusive']
const BACKENDS = ['host', 'workspace-write', 'danger-full-access', 'guarded_copy', 'unknown']

function cap(current, ceiling, reason, reasons) {
  const next = Math.min(current, ceiling)
  if (next < current) reasons.push(reason)
  return next
}

/**
 * Grade one evidence record.
 *
 * @param {object} input caller-supplied evidence fields.
 * @param {object} claim the claim this evidence is offered for.
 * @param {object} run context with workspaceRoot.
 */
export function gradeEvidence(input, claim, run) {
  const reasons = []
  const oracleName = String(input.oracle ?? '').trim()
  const oracle = ORACLES[oracleName]
  let rank = qualityRank(input.quality ?? 'Q0')
  const declared = qualityAt(rank)
  const limitations = unique(Array.isArray(input.limitations) ? input.limitations.map(String) : [])

  const status = STATUSES.includes(input.status) ? input.status : 'supporting'

  // Fingerprint every declared subject under the run workspace.
  const workspaceRoot = String(run?.workspaceRoot ?? '')
  const suppliedSubjects = Array.isArray(input.subjects) ? input.subjects : []
  const subjects = []
  for (const value of suppliedSubjects) {
    const rel = normalizeRel(value)
    if (rel === '') continue
    const absolute = resolve(workspaceRoot || '.', rel)
    const current = fileSha256(absolute)
    subjects.push({ path: rel, sha256: current, exists: current !== null })
  }
  if (suppliedSubjects.length > 0 && subjects.length === 0) {
    reasons.push('subjects 全部为空，证据未绑定对象')
  }
  const missing = subjects.filter((subject) => !subject.exists)
  if (missing.length > 0) {
    limitations.push(`对象不存在：${missing.map((subject) => subject.path).join('、')}`)
  }

  // Backend assurance is recorded first so command rules can use it.
  const assuranceInput = input.assurance && typeof input.assurance === 'object' ? input.assurance : {}
  const backend = BACKENDS.includes(assuranceInput.backend) ? assuranceInput.backend : 'unknown'
  const assurance = {
    backend,
    isolated: assuranceInput.isolated === true,
  }

  if (oracle === undefined) {
    rank = 0
    reasons.push(`未知 Oracle ${JSON.stringify(oracleName)}，只能算 Q0`)
  } else {
    if (!(claim.oracle || []).includes(oracleName)) {
      rank = cap(rank, 1, `Oracle ${oracleName} 不在 Claim 允许列表内，最高 Q1`, reasons)
    }
    const observed = input.observed && typeof input.observed === 'object' ? input.observed : {}
    const command = String(observed.command ?? '').trim()
    if (oracle.commandBased) {
      if (command === '') {
        rank = cap(rank, 1, '命令型证据缺少真实命令，最高 Q1', reasons)
      } else if (isPlaceholderCommand(command)) {
        rank = 0
        reasons.push(`占位/恒真命令（${command}）只产生执行观察，不能支撑完成 Claim`)
      } else if (!Number.isInteger(observed.exitCode)) {
        rank = cap(rank, 1, '命令型证据缺少退出码，最高 Q1', reasons)
      }
      // A non-zero command may be useful as an explicit refutation, but it
      // can never support a passing Claim.
      if (status === 'supporting' && Number.isInteger(observed.exitCode) && observed.exitCode !== 0) {
        rank = 0
        reasons.push(`命令退出码为 ${observed.exitCode}，不能支撑通过 Claim`)
      }
      if (oracleName === 'tests_pass' && status === 'supporting') {
        if (!Number.isInteger(observed.tests) || observed.tests <= 0) {
          rank = 0
          reasons.push('tests_pass 没有执行到至少 1 个测试，不能支撑通过 Claim')
        }
      }
      const declaredEffectsComplete = observed.declaredEffects === true
      if (!declaredEffectsComplete) {
        limitations.push('命令副作用未完整声明：功能结果成立不代表副作用边界被证明')
      }
      if (backend !== 'host') {
        limitations.push(`命令在 ${backend} 后端执行：只证明功能结果，不证明工作区外文件/网络/凭据未受影响`)
      }
    }
    if (oracle.requiresSubjects && subjects.length === 0) {
      rank = cap(rank, 1, '缺少绑定对象指纹，最高 Q1', reasons)
    }
    if (subjects.length > 0 && !subjectsMatchClaim(subjects, claim.subjects)) {
      rank = 0
      reasons.push('证据对象与 Claim subjects 不匹配，不能支撑该 Claim')
    }
    if (oracle.attested) {
      const by = String(observed.by ?? '').trim()
      if (by === '') {
        rank = cap(rank, 1, '声明型证据缺少来源（observed.by），最高 Q1', reasons)
        limitations.push('声明型证据没有可核对来源')
      }
    }
    const summary = String(observed.summary ?? '').trim()
    if (rank >= 2 && summary === '') {
      rank = cap(rank, 1, '缺少观察摘要（observed.summary），最高 Q1', reasons)
    }
    if (rank >= 3) {
      const independent = observed.independent === true
      if (!independent) {
        rank = cap(rank, 2, 'Q3 需要独立来源/交叉验证；未声明独立来源，最高 Q2', reasons)
      }
    }
  }

  if (status === 'inconclusive') {
    rank = 0
    reasons.push('inconclusive 证据只能记录不确定性，不能支撑完成 Claim')
  }

  // A claim's own minimum is a floor for use, not a promotion.
  const minRank = qualityRank(claim.minQuality)
  const quality = qualityAt(rank)
  if (rank < minRank) {
    reasons.push(`有效质量 ${quality} 低于 Claim ${claim.id} 的最低要求 ${claim.minQuality}`)
  }

  return {
    claimId: claim.id,
    claimHash: claim.hash,
    oracle: oracleName,
    quality,
    declaredQuality: declared,
    status,
    subjects,
    observed: sanitizeObserved(input.observed),
    assurance,
    limitations: unique(limitations),
    reasons,
  }
}

function sanitizeObserved(value) {
  if (value === null || typeof value !== 'object') return {}
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof item)) output[key] = typeof item === 'string' ? item.slice(0, 2000) : item
    else if (Array.isArray(item)) output[key] = item.slice(0, 20).map((entry) => String(entry).slice(0, 200))
  }
  return output
}

/**
 * Dynamic staleness: re-fingerprint subjects at read time.
 * Contract-driven staleness is written onto the record by the store when the
 * contract is amended; this function covers files that changed silently.
 */
export function stalenessOf(evidence, run) {
  const reasons = []
  if (evidence.stale === true) reasons.push(evidence.staleReason || '合同变更导致失效')
  const workspaceRoot = String(run?.workspaceRoot ?? '')
  for (const subject of evidence.subjects || []) {
    const absolute = resolve(workspaceRoot || '.', subject.path)
    const current = fileSha256(absolute)
    if (current === null) reasons.push(`对象已不存在：${subject.path}`)
    else if (subject.sha256 !== null && current !== subject.sha256) reasons.push(`对象已变化：${subject.path}`)
  }
  return { stale: reasons.length > 0, reasons: unique(reasons) }
}

/** One-line display for a stored evidence record. */
export function describeEvidence(evidence) {
  const subjectText = (evidence.subjects || []).map((subject) => subject.path).join('、')
  return `${evidence.id}｜${evidence.claimId}｜${evidence.quality}｜${evidence.oracle}｜${evidence.status}${subjectText ? `｜${subjectText}` : ''}`
}
