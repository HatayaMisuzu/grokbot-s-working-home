/**
 * Action declaration and a record-level risk gate.
 *
 * v0.1 does not intercept the host's tool pipeline. It records what the agent
 * says it is about to do, checks it against the frozen scope, and refuses to
 * authorize obviously unsafe or undeclared actions. The record is what a later
 * pre-execute hook (v0.2) can enforce against; today's honesty level is
 * "recorded", never "host-enforced".
 */
import { compileScope, matchesAny, normalizeRel, unique } from './util.js'

export const ACTION_KINDS = ['read', 'write', 'create', 'delete', 'execute', 'network', 'external']

const KIND_DEFAULT_RISK = {
  read: 'low',
  write: 'medium',
  create: 'medium',
  delete: 'high',
  execute: 'medium',
  network: 'high',
  external: 'high',
}

const EFFECT_KEYS = ['write', 'create', 'delete', 'network', 'external']

/** Effects are declared, never guessed from a command string. */
export function normalizeEffects(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const effects = {
    write: Array.isArray(input.write) ? input.write.map(normalizeRel).filter(Boolean) : [],
    create: Array.isArray(input.create) ? input.create.map(normalizeRel).filter(Boolean) : [],
    delete: Array.isArray(input.delete) ? input.delete.map(normalizeRel).filter(Boolean) : [],
    network: input.network === true,
    external: input.external === true,
  }
  const declared = EFFECT_KEYS.some((key) =>
    typeof effects[key] === 'boolean' ? effects[key] : effects[key].length > 0,
  )
  return { effects, declared }
}

/**
 * Decide whether an action may proceed.
 *
 * Returns `authorized` (with the record to append), `confirmation_required`,
 * or `denied` (with findings). Denials are recorded too: an attempted
 * out-of-scope action is itself a limitation in the final verdict.
 */
export function gateAction(input, { contract }) {
  const kind = String(input.kind ?? '').toLowerCase()
  if (!ACTION_KINDS.includes(kind)) {
    throw new Error(`action.kind 必须是 ${ACTION_KINDS.join('/')}`)
  }
  const intent = String(input.intent ?? '').trim()
  if (intent === '') throw new Error('action.intent 不能为空：先写清这次动作要达到什么')
  const targets = unique((Array.isArray(input.targets) ? input.targets : []).map(normalizeRel).filter(Boolean))
  const { effects, declared: effectsDeclared } = normalizeEffects(input.effects)
  const findings = []

  // Derived effects: a write of X implies write scope X, and so on.
  if (['write', 'create', 'delete'].includes(kind)) {
    for (const target of targets) {
      if (kind === 'write' && !effects.write.includes(target)) effects.write.push(target)
      if (kind === 'create' && !effects.create.includes(target)) effects.create.push(target)
      if (kind === 'delete' && !effects.delete.includes(target)) effects.delete.push(target)
    }
  }

  if (kind === 'execute' && !effectsDeclared) {
    return {
      decision: 'denied',
      reason: 'execute 动作必须声明完整副作用（effects.write/create/delete/network/external）；Runtime 不从命令字符串猜测副作用',
      findings: ['execute 未声明副作用'],
      action: null,
    }
  }

  const allow = compileScope(contract.scope?.allow || [])
  const protect = compileScope(contract.scope?.protected || [])
  const protectedHits = targets.filter((target) => matchesAny(target, protect))
  if (protectedHits.length > 0) {
    return {
      decision: 'denied',
      reason: `目标命中受保护资源：${protectedHits.join('、')}`,
      findings: [`受保护资源被触碰：${protectedHits.join('、')}`],
      action: null,
    }
  }

  if (kind !== 'read') {
    const outside = targets.filter((target) => !matchesAny(target, allow))
    if (outside.length > 0) {
      return {
        decision: 'denied',
        reason:
          allow.length === 0
            ? '合同的 scope.allow 为空：任何写入/创建/删除/外部动作都不被允许'
            : `目标不在允许范围：${outside.join('、')}（allow=${(contract.scope?.allow || []).join('、') || '空'}）`,
        findings: [`越界目标：${outside.join('、')}`],
        action: null,
      }
    }
  } else {
    const outsideReads = targets.filter((target) => !matchesAny(target, allow))
    if (outsideReads.length > 0 && allow.length > 0) {
      findings.push(`读取了范围外对象：${outsideReads.join('、')}`)
    }
  }

  const declaredRisk = String(input.risk ?? '').toLowerCase()
  const risk = ['low', 'medium', 'high'].includes(declaredRisk)
    ? declaredRisk
    : ['delete', 'network', 'external'].includes(kind)
      ? 'high'
      : KIND_DEFAULT_RISK[kind]

  if (risk === 'high') {
    const confirmation = input.confirmation && typeof input.confirmation === 'object' ? input.confirmation : {}
    const by = String(confirmation.by ?? '').trim()
    const note = String(confirmation.note ?? '').trim()
    if (by === '' || note === '') {
      return {
        decision: 'confirmation_required',
        reason: `高风险动作（${kind}/${risk}）必须先向用户确认，并给出确认人 by 与 note；确认只对当前合同版本与本次目标有效`,
        findings: ['高风险动作缺少确认'],
        action: null,
      }
    }
    findings.push('确认由调用方声明，宿主未认证：报告中必须如实标注')
  }

  return {
    decision: 'authorized',
    reason: '在合同范围内',
    findings,
    action: {
      kind,
      intent,
      targets,
      effects,
      risk,
      confirmation:
        risk === 'high' && input.confirmation && typeof input.confirmation === 'object'
          ? {
              by: String(input.confirmation.by).trim(),
              note: String(input.confirmation.note).trim(),
            }
          : null,
      contractHash: contract.hash,
      contractVersion: contract.version,
    },
  }
}
