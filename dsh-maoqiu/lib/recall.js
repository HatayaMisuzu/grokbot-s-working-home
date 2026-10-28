import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_QUERY_LENGTH = 1000
const MAX_LIMIT = 10
const MAX_MATERIALS = 3
const PREVIEW_LENGTH = 64 * 1024
const MAX_RECENT_MATERIALS = 3
const MAX_RECENT_EXCERPT = 240
const MAX_PENDING_ACTIVITIES = 3
const MAX_ACTIVITY_SUMMARY = 300
const PENDING_ACTIVITY_STATUSES = new Set(['planned', 'paused', 'failed'])

// Keep this deliberately small. The aim is to remove conversational glue,
// rather than to build a language model or a general Chinese segmenter.
const CJK_STOPWORDS = new Set([
  '今天', '现在', '刚刚', '有点', '一些', '这个', '那个', '这些', '那些', '需要', '可以',
  '可能', '已经', '还是', '然后', '如果', '因为', '所以', '我们', '你们', '他们', '自己',
  '项目', '问题', '事情', '内容', '时间', '部分', '方面', '进行', '相关', '当前', '之后',
  '这里', '那里', '什么', '怎么', '如何', '是否', '以及', '并且', '还有', '没有', '不是',
  '一个', '一种', '一点', '一些', '继续', '查看', '记录', '经验', '空间',
])

const latinStopwords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of',
  'on', 'or', 'that', 'the', 'this', 'to', 'with', 'you', 'we', '的', '了', '和', '与',
])

const interestCursors = new WeakMap()

export async function recallFromStore(store, args = {}) {
  if (!store || typeof store !== 'object') throw new TypeError('recallFromStore 需要 store')
  if (!args || typeof args !== 'object') args = {}
  const query = normalizeQuery(args.query)
  const mode = ['work', 'chat', 'visit', 'activity'].includes(args.mode) ? args.mode : 'work'
  const scopes = normalizeScopes(args.scope)
  const requestedScopeMode = args.scope_mode || args.scopeMode
  const scopeMode = requestedScopeMode === 'loose' ? 'loose' : 'strict'
  const strictScope = scopeMode !== 'loose'
  const limit = clampLimit(args.limit)
  const scope = outputScope(scopes, args.scope)

  const warnings = []
  if (!query && mode === 'work') {
    const empty = { ok: true, query, mode, scope, scope_mode: scopeMode, experiences: [], materials: [], recent: [], activities: [], interests: [], commitments: [], warnings }
    return empty
  }

  const experiences = await readExperiences(store, warnings, query, scopes, strictScope, limit)
  const materials = query
    ? await readMaterials(store, warnings, query, scopes, strictScope, limit)
    : []
  // Chat, visits and self-directed activity need a way to pick up unfinished
  // writing without guessing exact keywords. Work recall stays query-only so
  // unrelated personal material does not leak into task context.
  const recent = (['visit', 'activity'].includes(mode) || (mode === 'chat' && args.include_recent === true))
    ? await readRecentMaterials(store, warnings, limit, new Set(materials.map((item) => item.path)))
    : []
  const activities = mode === 'activity'
    ? await readPendingActivities(store, warnings, limit)
    : []
  const interestResult = await readInterests(store, warnings, query, mode, limit, args.include_recent === true)
  replaceWarnings(store, warnings)
  return {
    ok: true,
    query,
    mode,
    scope,
    scope_mode: scopeMode,
    experiences,
    materials,
    recent,
    activities,
    interests: interestResult.interests,
    commitments: interestResult.commitments,
    warnings,
  }
}

async function readExperiences(store, warnings, query, scopes, strictScope, limit) {
  let records
  try {
    records = await store._experienceRecords(warnings, { preview: true })
    if (!Array.isArray(records)) throw new Error('经验读取结果不是数组')
  } catch (error) {
    warnings.push(warningFor(store, 'evolution/experiences', error))
    return []
  }
  const ranked = []
  for (const record of records) {
    try {
      const meta = record?.meta && typeof record.meta === 'object' && !Array.isArray(record.meta) ? record.meta : {}
      if (meta.status === 'withdrawn') continue
      const match = scoreRecord(query, meta, typeof record?.content === 'string' ? record.content : '')
      if (match.score <= 0) continue
      const boundary = scopeBoundary(meta, scopes)
      if (strictScope && scopes.length && boundary.known && !boundary.match) continue
      if (!strictScope && scopes.length && boundary.known && !boundary.match) match.score *= 0.55
      const value = store._publicExperience(record, false)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('经验摘要格式无效')
      if (!boundary.match && scopes.length && boundary.known) value.cross_scope = true
      ranked.push({ value, score: match.score, updated: meta.updated_at || meta.created_at || '' })
    } catch (error) {
      warnings.push(warningFor(store, record?.file || 'evolution/experiences', error))
    }
  }
  ranked.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)))
  return ranked.slice(0, limit).map((x) => x.value)
}

async function readMaterials(store, warnings, query, scopes, strictScope, limit) {
  let entries
  try {
    entries = await store._spaceFiles(warnings)
    if (!Array.isArray(entries)) throw new Error('材料列表结果不是数组')
  } catch (error) {
    warnings.push(warningFor(store, 'space', error))
    return []
  }
  const ranked = []
  for (const entry of entries) {
    let parsed
    try {
      const path = typeof entry?.path === 'string' ? entry.path : ''
      if (!path) continue
      const file = resolve(store.spaceDir, path)
      parsed = await store._readSpaceParsed(file, { preview: true })
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('材料解析结果无效')
      const content = typeof parsed.content === 'string' ? parsed.content.slice(0, PREVIEW_LENGTH) : ''
      const meta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? parsed.meta : {}
      const match = scoreText(query, [path, meta.title, content], meta.title)
      if (match.score <= 0) continue
      const boundary = scopeBoundary({ ...entry, ...meta }, scopes)
      if (strictScope && scopes.length && boundary.known && !boundary.match) continue
      if (!strictScope && scopes.length && boundary.known && !boundary.match) match.score *= 0.55
      const publicEntry = { ...entry }
      delete publicEntry.file
      ranked.push({
        value: {
          ...publicEntry,
          ...(typeof meta.title === 'string' && meta.title ? { title: store._excerpt(meta.title, 160) } : {}),
          excerpt: store._excerpt(content, 360),
          ...(boundary.match || !scopes.length || !boundary.known ? {} : { cross_scope: true }),
        },
        score: match.score,
        updated: entry.updated_at || meta.updated_at || '',
      })
    } catch (error) {
      warnings.push(warningFor(store, entry?.path || 'space', error))
    }
  }
  ranked.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)))
  return ranked.slice(0, Math.min(MAX_MATERIALS, limit)).map((x) => x.value)
}

async function readRecentMaterials(store, warnings, limit, excludePaths) {
  let entries
  try {
    entries = await store._spaceFiles(warnings)
    if (!Array.isArray(entries)) throw new Error('材料列表结果不是数组')
  } catch (error) {
    warnings.push(warningFor(store, 'space', error))
    return []
  }
  const ordered = entries
    .filter((entry) => typeof entry?.path === 'string' && entry.path && !excludePaths.has(entry.path))
    .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
      || left.path.localeCompare(right.path))
  const recent = []
  const cap = Math.min(MAX_RECENT_MATERIALS, limit)
  for (const entry of ordered) {
    if (recent.length >= cap) break
    try {
      const file = resolve(store.spaceDir, entry.path)
      const parsed = await store._readSpaceParsed(file, { preview: true })
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('材料解析结果无效')
      const meta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? parsed.meta : {}
      const content = typeof parsed.content === 'string' ? parsed.content : ''
      const fallbackTitle = entry.path.split('/').pop().replace(/\.(?:md|txt)$/i, '')
      const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : fallbackTitle
      recent.push({
        path: entry.path,
        category: entry.path.split('/')[0],
        title: store._excerpt(title, 160),
        ...(entry.updated_at ? { updated_at: entry.updated_at } : {}),
        excerpt: store._excerpt(content, MAX_RECENT_EXCERPT),
      })
    } catch (error) {
      warnings.push(warningFor(store, entry?.path || 'space', error))
    }
  }
  return recent
}

async function readPendingActivities(store, warnings, limit) {
  let items
  try {
    items = await store._readJson(store.activitiesFile, [])
    if (!Array.isArray(items)) throw new Error('活动列表结果不是数组')
  } catch (error) {
    warnings.push(warningFor(store, 'space/activities.json', error))
    return []
  }
  return items
    .filter((item) => item && PENDING_ACTIVITY_STATUSES.has(item.status))
    .sort((left, right) => String(right.updated_at || right.created_at || '')
      .localeCompare(String(left.updated_at || left.created_at || ''))
      || String(left.id || '').localeCompare(String(right.id || '')))
    .slice(0, Math.min(MAX_PENDING_ACTIVITIES, limit))
    .map((item) => ({
      id: String(item.id || ''),
      status: String(item.status || ''),
      ...(item.title ? { title: store._excerpt(item.title, 160) } : {}),
      ...(item.summary ? { summary: store._excerpt(item.summary, MAX_ACTIVITY_SUMMARY) } : {}),
      ...(item.interest_id ? { interest_id: item.interest_id } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
    }))
}

async function readInterests(store, warnings, query, mode, limit, includeRecent) {
  let items
  try {
    items = await store._readJson(store.interestsFile, [])
    if (!Array.isArray(items)) throw new Error('顶层必须是数组')
  } catch (error) {
    warnings.push(warningFor(store, 'space/active_interests.json', error))
    return { interests: [], commitments: [] }
  }
  const active = items.filter((item) => item && item.status === 'active')
  const ranked = active.map((item) => ({
    item,
    match: query
      ? scoreText(query, [item.title, item.reason, item.progress, item.next_step, ...(Array.isArray(item.materials) ? item.materials : [])])
      : { score: 1 },
  }))
  const relatedOnly = mode === 'work' || (mode === 'chat' && query && !includeRecent)
  ranked.sort((a, b) => (relatedOnly ? b.match.score - a.match.score : 0)
    || String(b.item.updated_at || b.item.created_at || '').localeCompare(String(a.item.updated_at || a.item.created_at || '')))
  const relevantSorted = relatedOnly ? ranked.filter((x) => x.match.score > 0) : ranked
  const shown = relatedOnly
    ? relevantSorted
    : [
      ...rotateInterests(store, relevantSorted.filter((x) => x.item.kind !== 'commitment'), mode, 'interests', limit),
      ...rotateInterests(store, relevantSorted.filter((x) => x.item.kind === 'commitment'), mode, 'commitments', limit),
    ]
  const interests = []
  const commitments = []
  for (const item of shown) {
    try {
      const value = store._publicInterest(item.item)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('关注点摘要格式无效')
      const target = item.item.kind === 'commitment' ? commitments : interests
      if (target.length < limit) target.push(value)
    } catch (error) {
      warnings.push(warningFor(store, 'space/active_interests.json', error))
    }
  }
  return { interests, commitments }
}

function rotateInterests(store, ranked, mode, kind, limit) {
  if (ranked.length <= 1) return ranked
  let cursors = interestCursors.get(store)
  if (!cursors) {
    cursors = new Map()
    interestCursors.set(store, cursors)
  }
  const key = `interest:${mode}:${kind}`
  const cursor = Number(cursors.get(key) || 0) % ranked.length
  cursors.set(key, (cursor + Math.max(1, limit)) % ranked.length)
  return ranked.slice(cursor).concat(ranked.slice(0, cursor))
}

function scoreRecord(query, meta, content) {
  const title = typeof meta.title === 'string' ? meta.title : ''
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : []
  const match = scoreText(query, [title, content.slice(0, 500), ...keywords], title)
  return match
}

export function scoreText(query, fields, title = '') {
  const q = normalizeQuery(query).toLowerCase()
  if (!q) return { score: 0, matched: [] }
  const fieldValues = fields.flatMap((x) => Array.isArray(x) ? x : [x]).filter((x) => typeof x === 'string')
  const all = fieldValues.join(' ').toLowerCase()
  if (!all) return { score: 0, matched: [] }
  const titleText = String(title || '').toLowerCase()
  let score = 0
  const matched = []
  if (all.includes(q)) {
    score += 8
    matched.push('exact')
  }
  const latin = q.match(/[a-z0-9][a-z0-9._/-]*/g) || []
  for (const word of new Set(latin)) {
    if (word.length <= 1 || latinStopwords.has(word)) continue
    if (all.includes(word)) {
      score += titleText.includes(word) ? 4 : 2
      matched.push(word)
    }
  }
  const cjkUnits = meaningfulCjkUnits(q)
  const cjkOnly = /[\u3400-\u9fff]/.test(q) && latin.length === 0
  if (cjkOnly && cjkUnits.length === 0) return { score: 0, matched: [] }
  const cjkMatches = new Set(cjkUnits.filter((unit) => all.includes(unit)))
  if (cjkMatches.size) {
    score += cjkMatches.size * 2
    if (cjkMatches.size >= 2 || cjkUnits.length <= 1 || all.includes(q)) matched.push(...cjkMatches)
  }
  // A long CJK query with only one generic bigram is noise. Exact phrases,
  // Latin tokens, and two distinct meaningful bigrams remain sufficient.
  if (cjkOnly && !all.includes(q) && cjkUnits.length > 1 && cjkMatches.size < 2) return { score: 0, matched: [] }
  return matched.length ? { score, matched } : { score: 0, matched: [] }
}

function meaningfulCjkUnits(query) {
  const runs = query.match(/[\u3400-\u9fff]+/g) || []
  const units = []
  for (const run of runs) {
    if (run.length === 1) {
      if (!CJK_STOPWORDS.has(run)) units.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const unit = run.slice(i, i + 2)
      if (!CJK_STOPWORDS.has(unit)) units.push(unit)
    }
  }
  return [...new Set(units)]
}

function scopeBoundary(meta, scopes) {
  if (!scopes.length) return { match: true, known: false, kind: 'none' }
  const projects = scopeValues(meta.project)
  const textScopes = scopeValues(meta.scope)
  if (!projects.length && !textScopes.length) return { match: true, known: false, kind: 'unscoped' }
  const match = scopes.some((scope) => {
    if (pathLike(scope)) {
      const paths = projects.length ? projects : textScopes.filter(pathLike)
      return paths.some((path) => pathMatches(path, scope))
    }
    return [...textScopes, ...projects].some((value) => equalsFold(value, scope))
  })
  return { match, known: true, kind: projects.length ? 'project' : 'text' }
}

function pathMatches(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
}

function pathLike(value) {
  return /[\\/]/.test(value) || /^[a-z]:$/i.test(value) || value.startsWith('.')
}

function normalizeQuery(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
}

function normalizeScopes(value) {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))]
}

function outputScope(scopes, original) {
  if (Array.isArray(original)) return scopes
  return scopes[0] || ''
}

function clampLimit(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(number))) : 3
}

function warningFor(store, path, error) {
  let safe = String(path || 'space')
  if (isAbsolute(safe) && store.home) {
    safe = relative(resolve(store.home), resolve(safe)).split(sep).join('/')
  }
  if (!safe || safe.startsWith('..')) safe = 'space'
  return { path: safe, message: shortError(error) }
}

function replaceWarnings(store, warnings) {
  const seen = new Set()
  const normalized = []
  for (const item of warnings) {
    const path = typeof item === 'object' ? item?.path : 'space'
    const message = typeof item === 'object' ? item?.message : item
    const warning = warningFor(store, path || 'space', message || '读取失败')
    const key = `${warning.path}\0${warning.message}`
    if (!seen.has(key)) {
      seen.add(key)
      normalized.push(warning)
    }
  }
  warnings.splice(0, warnings.length, ...normalized)
}

function shortError(error) {
  const message = String(error?.message || error || '读取失败')
    .replace(/[A-Za-z]:[\\/][^"'<>|\r\n]*/g, '文件')
    .replace(/\\\\[^"'<>|\r\n]*/g, '文件')
  return message.length > 180 ? `${message.slice(0, 177)}…` : message
}

function scopeValues(value) {
  return Array.isArray(value)
    ? value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : typeof value === 'string' && value.trim() ? [value.trim()] : []
}

function equalsFold(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}


