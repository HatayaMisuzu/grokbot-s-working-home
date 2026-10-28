/**
 * Persistent storage for work runs.
 *
 * Layout (under `home`, default `$DSH_HOME/work`):
 *
 *   runs/<run-id>/contract.v{n}.json   immutable contract versions
 *   runs/<run-id>/current.json         copy of the current version (never a link)
 *   runs/<run-id>/state.json           lifecycle + revision for context caching
 *   runs/<run-id>/events.jsonl         append-only hash-chained event log
 *   runs/<run-id>/evidence/EV-*.json   one record per piece of evidence
 *   runs/<run-id>/actions.jsonl        declared actions, including denied attempts
 *   runs/<run-id>/notices.jsonl        collaboration notices (findings/conflicts/blockers)
 *   runs/<run-id>/learning/LX-*.json   experience candidates for the main session
 *   runs/<run-id>/verdict.json         last computed verdict
 *
 * Writes are serialized per store instance and use temp-file + rename, so a
 * crash cannot leave a half-written record. Cross-process writes are not
 * supported on purpose (one DSH host per work home).
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  atomicWriteJson,
  atomicWriteText,
  appendJsonl,
  compact,
  defaultWorkHome,
  nowIso,
  qualityRank,
  readJson,
  readJsonl,
  readText,
  sha256,
  stableJson,
  unique,
} from './util.js'
import {
  buildContractBody,
  claimHash,
  describeContract,
  diffContracts,
  freeze,
  normalizeClaim,
} from './contract.js'
import { describeEvidence, gradeEvidence, stalenessOf } from './evidence.js'
import { gateAction } from './actions.js'
import { computeVerdict, describeVerdict } from './verdict.js'

const EVENT_HASH_FIELDS = ['seq', 'at', 'type', 'data', 'prev']
const NOTICE_KINDS = ['discovery', 'conflict', 'blocker', 'request', 'suggestion', 'challenge']
const NOTICE_STATES = ['recorded', 'acked', 'resolved']

export class WorkloopStore {
  constructor(home, options = {}) {
    this.home = resolve(home || defaultWorkHome())
    this.runsDir = join(this.home, 'runs')
    this.maxNotices = Number.isSafeInteger(options.maxNotices) ? options.maxNotices : 50
    this.dedupeSeconds = Number.isSafeInteger(options.dedupeSeconds) ? options.dedupeSeconds : 1800
    this.queue = Promise.resolve()
  }

  /** Serialize a read-modify-write block. */
  serial(task) {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  runDir(runId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(runId ?? ''))) {
      throw new Error('runId 不合法')
    }
    return join(this.runsDir, runId)
  }

  /** List runs with a small summary, newest first. */
  listRuns() {
    let names = []
    try {
      names = readdirSync(this.runsDir).filter((name) => {
        try {
          return statSync(join(this.runsDir, name)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      return []
    }
    return names
      .map((name) => {
        const state = readJson(join(this.runsDir, name, 'state.json'), null)
        const contract = readJson(join(this.runsDir, name, 'current.json'), null)
        if (state === null || contract === null) return null
        return {
          runId: name,
          status: state.status,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          revision: state.revision,
          goal: contract.goal?.statement ?? '',
          workspaceRoot: state.workspaceRoot ?? contract.workspaceRoot ?? '',
          // Runs written before 0.1.1 do not have an owner.  Keep the field
          // absent/null so explicit runId access remains compatible, while
          // session-scoped auto-selection can safely ignore legacy records.
          creatorSession: state.creatorSession ?? null,
          verdict: state.verdict ?? null,
        }
      })
      .filter(Boolean)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  /** Read and assemble one run, verifying the event chain. */
  read(runId) {
    const dir = this.runDir(runId)
    const contract = readJson(join(dir, 'current.json'), null)
    const state = readJson(join(dir, 'state.json'), null)
    if (contract === null || state === null) throw new Error(`找不到 Run ${runId}`)
    const evidenceDir = join(dir, 'evidence')
    const evidenceFiles = (() => {
      try {
        return readdirSync(evidenceDir).filter((name) => name.endsWith('.json'))
      } catch {
        return []
      }
    })()
    const evidence = evidenceFiles
      .map((name) => readJson(join(evidenceDir, name), null))
      .filter((record) => record !== null)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    const actions = readJsonl(join(dir, 'actions.jsonl')).records
    const events = readJsonl(join(dir, 'events.jsonl')).records
    const notices = readJsonl(join(dir, 'notices.jsonl')).records
    const learning = listJson(join(dir, 'learning'))
    const integrity = checkEventChain(events)
    return { runId, dir, contract, state, evidence, actions, events, notices, learning, integrity }
  }

  preview(runId) {
    return this.serial(() => {
      const run = this.read(runId)
      const verdict = computeVerdict({
        contract: { ...run.contract, runId },
        evidence: run.evidence,
        actions: run.actions,
        notices: run.notices,
        state: run.state,
        run: { workspaceRoot: run.contract.workspaceRoot },
        integrity: run.integrity,
      })
      return { run, verdict }
    })
  }

  /** Create a run and freeze contract v1. */
  start(input, { workspaceRoot = '', runId = null, actor = null } = {}) {
    return this.serial(() => {
      const id =
        runId ||
        `run-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`
      const dir = this.runDir(id)
      if (readJson(join(dir, 'state.json'), null) !== null) throw new Error(`Run ${id} 已存在`)
      mkdirSync(dir, { recursive: true })
      const body = buildContractBody(input, { workspaceRoot })
      const contract = freeze(body, { version: 1, goalEpoch: 0 })
      contract.runId = id
      atomicWriteJson(join(dir, 'contract.v1.json'), contract)
      atomicWriteJson(join(dir, 'current.json'), contract)
      const state = {
        runId: id,
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        revision: 1,
        workspaceRoot,
        creatorSession:
          actor && typeof actor === 'object'
            ? String(actor.ownerSession || actor.session || '').trim() || null
            : null,
        creator: actor && typeof actor === 'object' ? actor : null,
        blockedReason: null,
        finishedAt: null,
        summary: null,
        verdict: null,
      }
      atomicWriteJson(join(dir, 'state.json'), state)
      this.appendEvent(dir, null, 'run_started', {
        goal: compact(body.goal.statement, 200),
        workspaceRoot,
        creatorSession: state.creatorSession,
      })
      this.appendEvent(dir, null, 'contract_frozen', { version: 1, hash: contract.hash, claims: contract.claims.length })
      return { runId: id, contract, state }
    })
  }

  /** Amend the contract; only evidence tied to changed claims is invalidated. */
  amend(runId, { reason, changes = {}, claimOps = [] }) {
    return this.serial(() => {
      const run = this.read(runId)
      const current = run.contract
      if (run.state.status !== 'active') throw new Error(`Run ${runId} 不是 active 状态，不能修改合同`)
      const nextBody = mergedBody(current, changes, claimOps)
      if (stableJson(nextBody) === stableJson(contractBodyOf(current))) {
        throw new Error('合同内容没有变化，未生成新版本')
      }
      const diff = diffContracts(current, nextBody)
      const goalEpoch = diff.goalChanged ? (current.goalEpoch ?? 0) + 1 : current.goalEpoch ?? 0
      const next = freeze(nextBody, { version: current.version + 1, parent: current.hash, goalEpoch })
      next.runId = runId
      const invalidated = this.invalidateEvidence(run, diff)
      atomicWriteJson(join(run.dir, `contract.v${next.version}.json`), next)
      atomicWriteJson(join(run.dir, 'current.json'), next)
      const state = { ...run.state, revision: run.state.revision + 1, updatedAt: nowIso() }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'contract_amended', {
        reason: compact(reason, 200),
        version: next.version,
        goalEpoch,
        diff: {
          goalChanged: diff.goalChanged,
          claimsInvalidated: diff.claimsInvalidated,
          claimsAdded: diff.claimsAdded,
          claimsRemoved: diff.claimsRemoved,
          scopeExpanded: diff.scopeExpanded,
          scopeShrunk: diff.scopeShrunk,
        },
        invalidatedEvidence: invalidated.map((record) => record.id),
      })
      return { runId, contract: next, diff, invalidated }
    })
  }

  invalidateEvidence(run, diff) {
    const invalidated = []
    for (const record of run.evidence) {
      const hit = record.claimId !== null && diff.claimsInvalidated.includes(record.claimId)
      if (!hit) continue
      const reason = `Claim ${record.claimId} 定义变化导致证据失效`
      const updated = { ...record, stale: true, staleReason: reason }
      atomicWriteJson(join(run.dir, 'evidence', `${record.id}.json`), updated)
      invalidated.push(updated)
    }
    return invalidated
  }

  /** Record evidence for a claim, or a review record when claimId is "@review". */
  evidence(runId, input) {
    return this.serial(() => {
      const run = this.read(runId)
      if (!['active', 'blocked'].includes(run.state.status)) {
        throw new Error(`Run ${runId} 已结束（${run.state.status}），不能再记录证据`)
      }
      const contract = run.contract
      const oracle = String(input.oracle ?? '').trim()
      let claim = null
      if (oracle === 'review_record') {
        claim = { id: '@review', oracle: ['review_record'], minQuality: 'Q2', hash: null }
      } else {
        const claimId = String(input.claimId ?? '').trim()
        if (claimId === '') throw new Error('非复核证据必须提供 claimId')
        claim = (contract.claims || []).find((item) => item.id === claimId)
        if (claim === undefined) throw new Error(`合同中没有 Claim ${claimId}；先 add 它或改用正确 id`)
      }
      const graded = gradeEvidence(input, claim, { workspaceRoot: contract.workspaceRoot })
      const id = `EV-${String(nextIndex(run.evidence, 'EV-')).padStart(2, '0')}`
      const record = {
        id,
        runId,
        claimId: claim.id,
        at: nowIso(),
        goalEpoch: contract.goalEpoch ?? 0,
        actor: input.actor ?? null,
        ...graded,
      }
      mkdirSync(join(run.dir, 'evidence'), { recursive: true })
      atomicWriteJson(join(run.dir, 'evidence', `${id}.json`), record)
      const state = { ...run.state, revision: run.state.revision + 1, updatedAt: nowIso() }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'evidence_recorded', {
        id,
        claimId: claim.id,
        oracle: record.oracle,
        quality: record.quality,
        status: record.status,
        goalEpoch: record.goalEpoch,
      })
      return { runId, evidence: record, claim }
    })
  }

  /** Declare an action; denied attempts are recorded as findings. */
  action(runId, input) {
    return this.serial(() => {
      const run = this.read(runId)
      if (run.state.status !== 'active') throw new Error(`Run ${runId} 不是 active 状态，不能声明动作`)
      const gate = gateAction(input, { contract: run.contract })
      const id = `AU-${String(nextIndex(run.actions, 'AU-')).padStart(2, '0')}`
      const record = {
        id,
        runId,
        at: nowIso(),
        kind: String(input.kind ?? '').toLowerCase(),
        intent: compact(input.intent, 200),
        targets: Array.isArray(input.targets) ? input.targets.map(String) : [],
        decision: gate.decision,
        reason: compact(gate.reason, 400),
        findings: gate.findings,
        actor: input.actor ?? null,
        ...(gate.action ?? {}),
      }
      appendJsonl(join(run.dir, 'actions.jsonl'), record)
      const state = { ...run.state, revision: run.state.revision + 1, updatedAt: nowIso() }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, `action_${gate.decision}`, {
        id,
        kind: record.kind,
        intent: record.intent,
        risk: record.risk ?? null,
        findings: record.findings,
      })
      return { runId, action: record, gate }
    })
  }

  /** Post a collaboration notice; deduplicates noise inside a time window. */
  postNotice(runId, input) {
    return this.serial(() => {
      const run = this.read(runId)
      const kind = String(input.kind ?? '').toLowerCase()
      if (!NOTICE_KINDS.includes(kind)) throw new Error(`notice.kind 必须是 ${NOTICE_KINDS.join('/')}`)
      const topic = String(input.topic ?? '').trim()
      const summary = String(input.summary ?? '').trim()
      if (topic === '' || summary === '') throw new Error('notice 需要 topic 与 summary')
      const recipients = unique((Array.isArray(input.recipients) ? input.recipients : []).map((item) => String(item).trim()))
      const dedupeKey = sha256(stableJson({ kind, topic: topic.toLowerCase(), summary: normalizeSummary(summary) }))
      const now = Date.now()
      const duplicate = run.notices.find(
        (notice) =>
          notice.dedupeKey === dedupeKey &&
          now - Date.parse(notice.at) < this.dedupeSeconds * 1000 &&
          notice.state !== 'resolved',
      )
      if (duplicate !== undefined) {
        return { runId, notice: duplicate, deduped: true, text: `重复通知已抑制：${duplicate.id}（${duplicate.topic}）` }
      }
      if (run.notices.filter((notice) => notice.state !== 'resolved').length >= this.maxNotices) {
        throw new Error(`本 Run 未解决通知已达 ${this.maxNotices} 条：先合并/解决旧通知，避免制造噪声`)
      }
      const notice = {
        id: `NT-${String(nextIndex(run.notices, 'NT-')).padStart(2, '0')}`,
        runId,
        at: nowIso(),
        kind,
        topic,
        summary: compact(summary, 600),
        recipients,
        state: 'recorded',
        ackedBy: null,
        ackedAt: null,
        resolvedAt: null,
        goalEpoch: run.contract.goalEpoch ?? 0,
        contractHash: run.contract.hash,
        actor: input.actor ?? null,
        dedupeKey,
      }
      appendJsonl(join(run.dir, 'notices.jsonl'), notice)
      const state = { ...run.state, revision: run.state.revision + 1, updatedAt: nowIso() }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'notice_posted', {
        id: notice.id,
        kind,
        topic,
        recipients,
      })
      return { runId, notice, deduped: false }
    })
  }

  setNoticeState(runId, { id, state: target, by = '', note = '' }) {
    return this.serial(() => {
      const run = this.read(runId)
      if (!NOTICE_STATES.includes(target)) throw new Error(`notice 状态必须是 ${NOTICE_STATES.join('/')}`)
      const existing = run.notices.find((notice) => notice.id === id)
      if (existing === undefined) throw new Error(`找不到通知 ${id}`)
      if (target === 'acked' && existing.state === 'resolved') throw new Error(`通知 ${id} 已解决，不能改为 acked`)
      if (target === 'acked' && by.trim() === '') throw new Error('ack 需要 by：写明是谁确认收到了')
      const notice = {
        ...existing,
        state: target,
        ackedBy: target === 'acked' ? by.trim() : existing.ackedBy,
        ackedAt: target === 'acked' ? nowIso() : existing.ackedAt,
        resolvedAt: target === 'resolved' ? nowIso() : existing.resolvedAt,
        note: note === '' ? existing.note : compact(note, 300),
      }
      rewriteJsonl(join(run.dir, 'notices.jsonl'), run.notices.map((item) => (item.id === id ? notice : item)))
      const nextState = { ...run.state, revision: run.state.revision + 1, updatedAt: nowIso() }
      atomicWriteJson(join(run.dir, 'state.json'), nextState)
      this.appendEvent(run.dir, run.events, `notice_${target}`, { id, by: compact(by, 80) })
      return { runId, notice }
    })
  }

  /** Propose an experience candidate; never writes the private space itself. */
  proposeLearning(runId, input) {
    return this.serial(() => {
      const run = this.read(runId)
      const title = String(input.title ?? '').trim()
      const content = String(input.content ?? '').trim()
      const scope = String(input.scope ?? '').trim()
      if (title === '' || content === '' || scope === '') throw new Error('经验候选需要 title、content、scope')
      const evidenceIds = unique((Array.isArray(input.evidenceIds) ? input.evidenceIds : []).map(String))
      const cited = run.evidence.filter((record) => evidenceIds.includes(record.id))
      const missing = evidenceIds.filter((id) => !cited.some((record) => record.id === id))
      if (missing.length > 0) throw new Error(`引用了不存在的证据：${missing.join('、')}`)
      const current = cited.filter(
        (record) =>
          !stalenessOf(record, { workspaceRoot: run.contract.workspaceRoot }).stale &&
          record.status === 'supporting' &&
          qualityRank(record.quality) >= 2,
      )
      const source = input.source && typeof input.source === 'object' ? input.source : {}
      const verification =
        evidenceIds.length > 0 && current.length === evidenceIds.length
          ? 'verified'
          : evidenceIds.length > 0
            ? 'observed'
            : source.kind === 'inference'
              ? 'inferred'
              : 'observed'
      const record = {
        id: `LX-${String(nextIndex(run.learning, 'LX-')).padStart(2, '0')}`,
        runId,
        at: nowIso(),
        title,
        content: compact(content, 2000),
        scope,
        source: {
          kind: ['user', 'inference', 'tool', 'external', 'creation'].includes(source.kind) ? source.kind : 'inference',
          ref: compact(source.ref ?? `run:${runId}`, 300),
        },
        evidenceIds,
        verification,
        status: 'candidate',
        goalEpoch: run.contract.goalEpoch ?? 0,
        runStatus: run.state.status,
        actor: input.actor ?? null,
      }
      mkdirSync(join(run.dir, 'learning'), { recursive: true })
      atomicWriteJson(join(run.dir, 'learning', `${record.id}.json`), record)
      const state = { ...run.state, revision: run.state.revision + 1, updatedAt: nowIso() }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'learning_proposed', {
        id: record.id,
        title: compact(title, 120),
        verification,
        evidenceIds,
      })
      return { runId, learning: record }
    })
  }

  /** Finalize a run. Refuses a silent "done" when required claims are unmet. */
  finalize(runId, { summary = '', blockedReason = '', acknowledgeGaps = false, knownGaps = '' } = {}) {
    return this.serial(() => {
      const run = this.read(runId)
      if (run.state.status === 'finished') throw new Error(`Run ${runId} 已经结束`)
      let state = run.state
      if (blockedReason !== '') {
        state = { ...state, status: 'blocked', blockedReason: compact(blockedReason, 400) }
      }
      const verdict = computeVerdict({
        contract: { ...run.contract, runId },
        evidence: run.evidence,
        actions: run.actions,
        notices: run.notices,
        state,
        run: { workspaceRoot: run.contract.workspaceRoot },
        integrity: run.integrity,
      })
      verdict.summary = compact(summary, 1000)
      const gapText = String(knownGaps ?? '').trim()
      if (!verdict.passEligible && state.status !== 'blocked' && !(acknowledgeGaps && gapText !== '')) {
        throw new Error(
          [
            '不能按“完成”收尾：当前结论不是 PASS。',
            describeVerdict(verdict),
            '请补齐证据，或显式 block，或调用 finalize 时带 acknowledgeGaps=true 与 knownGaps 说明缺什么。',
          ].join('\n'),
        )
      }
      const finishedAt = nowIso()
      atomicWriteJson(join(run.dir, 'verdict.json'), verdict)
      const nextState = {
        ...state,
        status: state.status === 'blocked' && !verdict.passEligible ? 'blocked' : 'finished',
        updatedAt: finishedAt,
        finishedAt,
        summary: compact(summary, 1000),
        verdict: verdict.verdict,
        revision: state.revision + 1,
      }
      atomicWriteJson(join(run.dir, 'state.json'), nextState)
      this.appendEvent(run.dir, run.events, 'run_finished', {
        verdict: verdict.verdict,
        summary: compact(summary, 300),
        knownGaps: compact(gapText, 300),
      })
      return { runId, verdict, state: nextState }
    })
  }

  abandon(runId, reason) {
    return this.serial(() => {
      const run = this.read(runId)
      if (run.state.status !== 'active') throw new Error(`Run ${runId} 不是 active 状态`)
      const state = {
        ...run.state,
        status: 'abandoned',
        blockedReason: null,
        updatedAt: nowIso(),
        finishedAt: nowIso(),
        revision: run.state.revision + 1,
      }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'run_abandoned', { reason: compact(reason, 300) })
      return { runId, state }
    })
  }

  block(runId, reason) {
    return this.serial(() => {
      const run = this.read(runId)
      if (!['active', 'blocked'].includes(run.state.status)) throw new Error(`Run ${runId} 已结束`)
      const state = {
        ...run.state,
        status: 'blocked',
        blockedReason: compact(reason, 400),
        updatedAt: nowIso(),
        revision: run.state.revision + 1,
      }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'run_blocked', { reason: compact(reason, 300) })
      return { runId, state }
    })
  }

  resume(runId) {
    return this.serial(() => {
      const run = this.read(runId)
      if (run.state.status !== 'blocked') throw new Error(`Run ${runId} 不是 blocked 状态`)
      const state = {
        ...run.state,
        status: 'active',
        blockedReason: null,
        updatedAt: nowIso(),
        revision: run.state.revision + 1,
      }
      atomicWriteJson(join(run.dir, 'state.json'), state)
      this.appendEvent(run.dir, run.events, 'run_resumed', {})
      return { runId, state }
    })
  }

  /**
   * Latest active run for a workspace and creator session.  When a session is
   * supplied, legacy unbound runs are deliberately excluded: callers can
   * still target those records explicitly with runId.
   */
  activeRun(workspaceRoot = '', creatorSession = '') {
    const runs = this.listRuns().filter((entry) => entry.status === 'active')
    if (runs.length === 0) return null
    const normalize = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    const target = normalize(workspaceRoot)
    const owner = String(creatorSession ?? '').trim()
    const scoped = owner === '' ? runs : runs.filter((entry) => entry.creatorSession === owner)
    if (scoped.length === 0) return null
    if (target === '') return scoped[0]
    return scoped.find((entry) => normalize(entry.workspaceRoot) === target) ?? null
  }

  /**
   * Bounded one-paragraph context for the current turn.
   * Returns '' when there is no active run in this workspace.
   */
  activeSummary(workspaceRoot = '', max = 700, creatorSession = '') {
    try {
      const entry = this.activeRun(workspaceRoot, creatorSession)
      if (entry === null) return ''
      const run = this.read(entry.runId)
      const verdict = computeVerdict({
        contract: { ...run.contract, runId: entry.runId },
        evidence: run.evidence,
        actions: run.actions,
        notices: run.notices,
        state: run.state,
        run: { workspaceRoot: run.contract.workspaceRoot },
        integrity: run.integrity,
      })
      const required = verdict.claims.filter((claim) => claim.required)
      const met = required.filter((claim) => claim.met).length
      const unacked = run.notices.filter((notice) => notice.state === 'recorded' && notice.kind === 'blocker')
      const lines = [
        '## 当前工作闭环（workloop）',
        `Run ${entry.runId}｜合同 v${run.contract.version}｜${run.contract.profile}｜状态 ${run.state.status}`,
        `必过 Claim ${met}/${required.length}${verdict.missing.length ? `；未过：${verdict.missing.join('、')}` : ''}｜当前结论：${verdict.verdict}${verdict.passEligible ? '（可交付）' : '（不可宣称完成）'}`,
      ]
      if (unacked.length > 0) lines.push(`未确认阻塞通知：${unacked.map((notice) => `${notice.id}(${notice.topic})`).join('、')}`)
      if (verdict.next.length > 0) lines.push(`下一步：${verdict.next.slice(0, 3).join('；')}`)
      if (verdict.limitations.length > 0) lines.push(`限制：${verdict.limitations.slice(0, 3).join('；')}`)
      const text = lines.join('\n')
      return text.length > max ? `${text.slice(0, max - 1)}…` : text
    } catch {
      // An empty string is indistinguishable from "no active run" and made
      // corrupted/stale state look healthy.  Keep the context bounded and
      // actionable without exposing internal paths or stack traces.
      return '## 当前工作闭环（workloop）\n读取失败：请调用 work_verdict(action="preview") 重新检查。'
    }
  }

  appendEvent(dir, events, type, data) {
    const list = events ?? readJsonl(join(dir, 'events.jsonl')).records
    const prev = list.length > 0 ? list[list.length - 1].hash : null
    const seq = list.length + 1
    const at = nowIso()
    const payload = { seq, at, type, data, prev }
    const record = { ...payload, hash: sha256(stableJson(payload)) }
    appendJsonl(join(dir, 'events.jsonl'), record)
    return record
  }

  /** Delete a run directory (maintenance only; not exposed as an agent tool). */
  remove(runId) {
    const dir = this.runDir(runId)
    rmSync(dir, { recursive: true, force: true })
  }
}

function contractBodyOf(contract) {
  const { version, frozenAt, parent, hash, runId, goalEpoch, ...body } = contract
  return body
}

function mergedBody(current, changes, claimOps) {
  const body = contractBodyOf(current)
  const next = {
    ...body,
    goal: changes.goal === undefined ? body.goal : { statement: String(changes.goal).trim() },
    deliverables: changes.deliverables === undefined ? body.deliverables : changes.deliverables,
    profile: changes.profile ?? body.profile,
    risk: changes.risk ?? body.risk,
    scope: {
      allow: changes.scope?.allow === undefined ? body.scope.allow : changes.scope.allow,
      protected: changes.scope?.protected === undefined ? body.scope.protected : changes.scope.protected,
    },
    policy: {
      ...body.policy,
      ...(changes.policy ?? {}),
    },
    claims: body.claims,
  }
  for (const op of claimOps) {
    const action = String(op?.action ?? '')
    const claim = op?.claim
    if (action === 'add') {
      const normalized = normalizeClaim(claim, next.claims)
      if (next.claims.some((existing) => existing.id === normalized.id)) {
        throw new Error(`Claim ${normalized.id} 已存在`)
      }
      next.claims = [...next.claims, normalized]
    } else if (action === 'update') {
      const id = String(claim?.id ?? '').trim()
      const index = next.claims.findIndex((existing) => existing.id === id)
      if (index < 0) throw new Error(`找不到 Claim ${id}`)
      const normalized = normalizeClaim(
        { ...next.claims[index], ...claim, id },
        next.claims.filter((existing) => existing.id !== id),
      )
      next.claims = next.claims.map((existing, position) => (position === index ? normalized : existing))
    } else if (action === 'remove') {
      const id = String(op?.id ?? '').trim()
      if (!next.claims.some((existing) => existing.id === id)) throw new Error(`找不到 Claim ${id}`)
      next.claims = next.claims.filter((existing) => existing.id !== id)
    } else {
      throw new Error(`未知 claim 操作：${action}`)
    }
  }
  return next
}

function listJson(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(join(dir, name), null))
      .filter((record) => record !== null)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  } catch {
    return []
  }
}

function rewriteJsonl(file, records) {
  const text = records.map((record) => JSON.stringify(record)).join('\n')
  atomicWriteText(file, text === '' ? '' : `${text}\n`)
}

function nextIndex(records, prefix) {
  let max = 0
  for (const record of records) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(String(record.id ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function normalizeSummary(summary) {
  return summary.toLowerCase().replace(/\s+/g, ' ').replace(/[。！？，、；：.!?,;:]/g, '').trim()
}

/** Recompute the event hash chain; problems are reported, never auto-repaired. */
function checkEventChain(events) {
  const problems = []
  let previous = null
  let expectedSeq = 1
  for (const event of events) {
    if (event.seq !== expectedSeq) problems.push(`事件序号不连续：期望 ${expectedSeq}，实际 ${event.seq}`)
    if (event.prev !== previous) problems.push(`事件 ${event.seq} 的 prev 不匹配`)
    const payload = {}
    for (const key of EVENT_HASH_FIELDS) payload[key] = event[key]
    if (sha256(stableJson(payload)) !== event.hash) problems.push(`事件 ${event.seq} 哈希不匹配`)
    previous = event.hash
    expectedSeq = event.seq + 1
  }
  return { problems: unique(problems), head: previous ?? null, count: events.length }
}

/** Re-exported so tools can describe runs without importing contract directly. */
export { describeContract, describeVerdict, describeEvidence, claimHash, qualityRank, readText }
