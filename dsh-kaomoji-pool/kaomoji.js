/**
 * Kaomoji Pool — widen the assistant's kaomoji repertoire.
 *
 * Two contributions, both owned by this plugin's context:
 *
 * 1. `kaomoji` tool: samples fresh candidates from the categorized pool, with
 *    mood filtering (one or more categories), a count cap, a width/space
 *    insensitive `exclude` list, per-draw visual dedupe, and a soft
 *    "recently drawn" memory so repeated calls keep offering new faces.
 * 2. `kaomoji:pool` system-prompt section: a compact set of favourites plus
 *    usage discipline and category hints, so the larger pool is visible
 *    without paying the token cost of the whole library on every request.
 *
 * The plugin imports nothing from the Harness packages (so it works as a
 * linked local bundle) and registers plain tool definitions; only the public
 * `ctx.tools.register` / `ctx.systemPrompt.section` contracts are used.
 */
import { KAOMOJI_CATEGORIES, KAOMOJI_POOL } from './pool.js'
import { readConfig as readSharedConfig, KAOMOJI_RULES } from './config.js'

export const name = 'kaomoji-pool'
export const inject = ['tools']

const SECTION_NAME = 'kaomoji:pool'
const INVISIBLE = /[\u200B-\u200D\u2060\uFE00-\uFE0F]/g

const CATEGORY_BY_KEY = new Map(KAOMOJI_CATEGORIES.map((meta) => [meta.key, meta]))
const ALL_CATEGORY_KEYS = KAOMOJI_CATEGORIES.map((meta) => meta.key)
const TOTAL_KAOMOJI = ALL_CATEGORY_KEYS.reduce((total, key) => total + KAOMOJI_POOL[key].length, 0)

/**
 * Comparison key for "is this the same face": NFKC folds full-width and
 * half-width variants (ﾟ/゜, ﾉ/ノ), whitespace and invisible selectors are
 * dropped. The pool still stores and returns the original text.
 * @param {unknown} value raw kaomoji text.
 */
export function normalizeEntry(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, '').replace(INVISIBLE, '')
}

const POOL_BY_KEY = new Map(
  ALL_CATEGORY_KEYS.map((key) => [
    key,
    KAOMOJI_POOL[key].map((entry) => ({ entry, key: normalizeEntry(entry) })),
  ]),
)

/**
 * Keep soft recency per agent, with an instance-local fallback for hosts that
 * do not pass an execution context. The WeakMap is deliberately created per
 * plugin mount so no state leaks between agents or plugin instances.
 */
function createRecentStore() {
  const byAgent = new WeakMap()
  const fallback = []
  const stateFor = (execution) => {
    const agent = execution !== null && execution !== undefined ? execution.agent : undefined
    if (agent !== null && (typeof agent === 'object' || typeof agent === 'function')) {
      let state = byAgent.get(agent)
      if (state === undefined) {
        state = []
        byAgent.set(agent, state)
      }
      return state
    }
    return fallback
  }
  return { stateFor }
}

/** Shared reader plus kaomoji-specific category filtering. */
function readConfig(raw) {
  const config = readSharedConfig(raw)
  const inlineCategories = (config.inlineCategories ?? ALL_CATEGORY_KEYS).filter((key) => CATEGORY_BY_KEY.has(key))
  return { ...config, inlineCategories: inlineCategories.length > 0 ? inlineCategories : ALL_CATEGORY_KEYS }
}

/** FNV-1a, used only to pick stable prompt favourites (no runtime randomness). */
function hashString(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Deterministic favourites: the same category and entry always rank the same,
 * so the prompt section stays byte-stable (KV-cache friendly) across restarts.
 */
function stableFavourites(entries, count, seed) {
  if (count <= 0) return []
  return entries
    .map((entry) => ({ entry, rank: hashString(`${seed}\u0000${entry}`) }))
    .sort((left, right) => left.rank - right.rank)
    .slice(0, count)
    .map((candidate) => candidate.entry)
}

/** Random shuffle in place. */
function shuffle(entries) {
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    const value = entries[index]
    entries[index] = entries[swap]
    entries[swap] = value
  }
  return entries
}

/** Human-readable category directory shared by the description and errors. */
const CATEGORY_DIRECTORY = KAOMOJI_CATEGORIES.map((meta) => `${meta.key}（${meta.label}）`).join('、')

/** Build the system-prompt section text from the configured inline size. */
function buildSectionText(config) {
  const lines = [
    '## 颜文字池（kaomoji pool）',
    `本部署装有颜文字池插件：共 ${TOTAL_KAOMOJI} 个颜文字，按 ${KAOMOJI_CATEGORIES.length} 类情绪组织。`,
    '',
    '使用规则：',
    ...KAOMOJI_RULES.map((rule) => `- ${rule}`),
    '- 可用 category、count 和 exclude（全角/半角、空格差异会自动归一化）。',
    '',
    '常用储备（每类若干，可直接取用；括号里是调用工具时的 category 名与适用情绪）：',
  ]
  for (const key of config.inlineCategories) {
    const meta = CATEGORY_BY_KEY.get(key)
    const favourites = stableFavourites(KAOMOJI_POOL[key], config.inlinePerCategory, key)
    if (favourites.length > 0) lines.push(`- ${meta.label}（${key}；${meta.hint}）：${favourites.join(' ')}`)
  }
  return lines.join('\n')
}

/**
 * Resolve one model-supplied category to a pool key, accepting the ASCII key,
 * the English label, or the Chinese label.
 */
function resolveCategoryName(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('category 里只能放字符串')
  const candidate = raw.trim()
  if (candidate === '') return undefined
  const exact = CATEGORY_BY_KEY.get(candidate)
  if (exact !== undefined) return exact.key
  const lowered = candidate.toLowerCase()
  const matched = KAOMOJI_CATEGORIES.find(
    (meta) => meta.key === lowered || String(meta.en).toLowerCase() === lowered || meta.label === candidate,
  )
  if (matched !== undefined) return matched.key
  throw new Error(`未知分类 ${JSON.stringify(candidate)}；可用分类：${CATEGORY_DIRECTORY}`)
}

/**
 * Resolve the tool's `category` argument: a single name, several names, or
 * nothing (all categories). An empty array is treated as "no filter".
 */
function resolveCategories(raw) {
  if (raw === undefined || raw === null) return ALL_CATEGORY_KEYS
  if (typeof raw === 'string') {
    const key = resolveCategoryName(raw)
    return key === undefined ? ALL_CATEGORY_KEYS : [key]
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return ALL_CATEGORY_KEYS
    const keys = []
    for (const item of raw) {
      if (typeof item !== 'string') throw new Error('category 数组里只能放字符串')
      const key = resolveCategoryName(item)
      if (key !== undefined && !keys.includes(key)) keys.push(key)
    }
    return keys.length > 0 ? keys : ALL_CATEGORY_KEYS
  }
  throw new Error('category 必须是字符串或字符串数组')
}

/** Clamp the requested candidate count into the configured range. */
function resolveCount(raw, config) {
  if (raw === undefined || raw === null) return Math.min(config.defaultCount, config.maxCount)
  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) throw new Error('count 必须是整数')
  const count = Math.floor(numeric)
  if (count < 1) throw new Error('count 至少为 1')
  return Math.min(count, config.maxCount)
}

/**
 * Normalize the optional exclusion list into normalized comparison keys.
 * A single string is accepted as a convenience.
 */
function resolveExclude(raw) {
  if (raw === undefined || raw === null) return new Set()
  const values = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(values)) throw new Error('exclude 必须是字符串或字符串数组')
  const excluded = new Set()
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') excluded.add(normalizeEntry(value))
  }
  return excluded
}

/** Remember recently drawn keys so a later call can prefer other faces. */
function rememberRecent(keys, limit, recentlyDrawn) {
  if (limit <= 0) return
  for (const key of keys) {
    const index = recentlyDrawn.indexOf(key)
    if (index >= 0) recentlyDrawn.splice(index, 1)
    recentlyDrawn.push(key)
  }
  while (recentlyDrawn.length > limit) recentlyDrawn.shift()
}

/**
 * Draw `count` candidates, spreading picks across the requested categories
 * (round-robin). Faces already drawn in this call are never repeated, even
 * when they live in two categories as width variants. Recently drawn faces
 * are only used when there are not enough fresh ones.
 */
function drawCandidates(categoryKeys, count, excluded, recentlyDrawn) {
  const recent = new Set(recentlyDrawn)
  const seen = new Set()
  const buckets = categoryKeys.map((key) => {
    const fresh = []
    const stale = []
    for (const item of POOL_BY_KEY.get(key)) {
      if (excluded.has(item.key)) continue
      if (recent.has(item.key)) stale.push(item)
      else fresh.push(item)
    }
    return { key, fresh: shuffle(fresh), stale: shuffle(stale) }
  })
  const kaomoji = []
  const categories = []
  const drawnKeys = []
  const push = (bucket, item) => {
    seen.add(item.key)
    drawnKeys.push(item.key)
    kaomoji.push(item.entry)
    if (!categories.includes(bucket.key)) categories.push(bucket.key)
  }
  const pull = (field) => {
    let progressed = true
    while (kaomoji.length < count && progressed) {
      progressed = false
      for (const bucket of buckets) {
        if (kaomoji.length >= count) break
        let item
        while (bucket[field].length > 0) {
          const candidate = bucket[field].shift()
          if (seen.has(candidate.key)) continue
          item = candidate
          break
        }
        if (item === undefined) continue
        push(bucket, item)
        progressed = true
      }
    }
  }
  pull('fresh')
  pull('stale')
  return { kaomoji: shuffle(kaomoji), categories, drawnKeys }
}

/** Count entries still available after exclusions across the whole pool. */
function countRemaining(excluded) {
  let remaining = 0
  for (const key of ALL_CATEGORY_KEYS) {
    for (const item of POOL_BY_KEY.get(key)) {
      if (!excluded.has(item.key)) remaining += 1
    }
  }
  return remaining
}

const CATEGORY_ARGUMENT_DESCRIPTION =
  '情绪分类，可用 key 或中文名；可传单个字符串或多个分类的数组；省略或空数组时从全部分类均衡抽取。'
  + `可用：${CATEGORY_DIRECTORY}`

/** Build the plain `ToolDefinition` the registry accepts. */
function buildTool(config, recentStore) {
  return {
    name: 'kaomoji',
    description:
      '按情绪分类从颜文字池取样，支持多个分类、数量上限和 exclude 排除最近用过的结果；'
      + 'exclude 会归一化比较，全角/半角与空格差异视为同一条。'
      + `分类：${CATEGORY_DIRECTORY}。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: {
          description: CATEGORY_ARGUMENT_DESCRIPTION,
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        count: {
          type: 'integer',
          description: `返回多少条候选，默认 ${config.defaultCount}，上限 ${config.maxCount}。`,
        },
        exclude: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: '已经用过或不想再要的颜文字，可传单个字符串或字符串数组；归一化后精确排除。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kaomoji', 'categories', 'remaining'],
        properties: {
          kaomoji: { type: 'array', items: { type: 'string' }, description: '随机抽取的颜文字候选' },
          categories: { type: 'array', items: { type: 'string' }, description: '候选涉及的分类 key' },
          remaining: { type: 'integer', description: '排除后全池剩余可选条数' },
        },
      },
      render(_args, value) {
        const candidates = Array.isArray(value?.kaomoji) ? value.kaomoji : []
        if (candidates.length === 0) {
          return [{
            type: 'text',
            text: '颜文字池里没有更多未排除的候选了：可以清空 exclude，或换一个 category 再试。',
          }]
        }
        const labels = (Array.isArray(value?.categories) ? value.categories : [])
          .map((key) => {
            const meta = CATEGORY_BY_KEY.get(key)
            return meta === undefined ? key : `${meta.label}（${key}）`
          })
          .join('、')
        const lines = candidates.map((entry, index) => `${index + 1}. ${entry}`)
        return [{
          type: 'text',
          text: `从颜文字池取到 ${candidates.length} 个候选（${labels}，全池剩余 ${value.remaining} 个）：\n`
            + `${lines.join('\n')}\n`
            + '挑 1–2 个最贴合当前情绪的自然点缀，不要堆砌；不要换成彩色 Emoji。',
        }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args, execution) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const categoryKeys = resolveCategories(input.category)
      const count = resolveCount(input.count, config)
      const excluded = resolveExclude(input.exclude)
      const recentlyDrawn = recentStore.stateFor(execution)
      const drawn = drawCandidates(categoryKeys, count, excluded, recentlyDrawn)
      rememberRecent(drawn.drawnKeys, config.avoidRecent, recentlyDrawn)
      return Promise.resolve({
        kaomoji: drawn.kaomoji,
        categories: drawn.categories,
        remaining: countRemaining(excluded),
      })
    },
  }
}

/**
 * Register the sampling tool and, when its service is available, the prompt
 * section. Both registrations live on this plugin's context, so unloading the
 * plugin removes them.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} rawConfig row config from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const recentStore = createRecentStore()

  if (config.tool) {
    ctx.effect(() => ctx.tools.register(buildTool(config, recentStore)))
  }

  if (config.prompt) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() =>
        promptCtx.systemPrompt.section({
          name: SECTION_NAME,
          order: config.sectionOrder,
          text: buildSectionText(config),
          interpolate: false,
        }),
      )
    })
  }
}
