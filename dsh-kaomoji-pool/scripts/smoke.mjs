#!/usr/bin/env node
/**
 * Offline smoke test: mounts the plugin on a fake Cordis context so the tool
 * definition, the sampling logic, and the prompt section text can be checked
 * without installing it into the profile.
 *
 * Usage: node scripts/smoke.mjs
 * Exit code 1 when an assertion fails.
 */
import assert from 'node:assert/strict'
import { apply, normalizeEntry } from '../kaomoji.js'
import { KAOMOJI_CATEGORIES, KAOMOJI_POOL } from '../pool.js'

const registeredTools = []
const registeredSections = []

const disposable = () => {}

const fakeCtx = {
  effect(callback) {
    const result = callback()
    return typeof result === 'function' ? result : disposable
  },
  tools: {
    register(definition) {
      registeredTools.push(definition)
      return disposable
    },
  },
  inject(dependencies, callback) {
    assert.deepEqual(dependencies, ['systemPrompt'])
    callback({
      effect: fakeCtx.effect,
      systemPrompt: {
        section(section) {
          registeredSections.push(section)
          return disposable
        },
      },
    })
    return disposable
  },
}

/** Mount a tool-only instance with explicit lifecycle and registration hooks. */
function mountTool(config = {}) {
  const tools = []
  const effects = []
  let unregisterCount = 0
  const ctx = {
    effect(callback) {
      const result = callback()
      const disposer = typeof result === 'function' ? result : disposable
      effects.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => { unregisterCount += 1 }
      },
    },
    inject() {
      throw new Error('tool-only smoke mounts must not request systemPrompt')
    },
  }
  apply(ctx, { prompt: false, ...config })
  return {
    tool: tools[0],
    dispose() {
      for (const effect of effects) effect()
    },
    get unregisterCount() {
      return unregisterCount
    },
  }
}

apply(fakeCtx, {})

assert.equal(registeredTools.length, 1, 'expected exactly one tool registration')
assert.equal(registeredSections.length, 1, 'expected exactly one prompt section registration')

const tool = registeredTools[0]
assert.equal(tool.name, 'kaomoji')
assert.equal(typeof tool.description, 'string')
assert.ok(tool.description.includes('happy（开心）'), 'description lists category keys and labels')
assert.ok(tool.description.includes('全角/半角'), 'description explains normalized exclude')
assert.equal(tool.parameters.type, 'object')
assert.equal(tool.parameters.additionalProperties, false)

const categorySchema = tool.parameters.properties.category
assert.equal(Array.isArray(categorySchema.oneOf), true, 'category accepts a string or an array')
assert.equal(categorySchema.oneOf[0].type, 'string')
assert.equal(categorySchema.oneOf[1].type, 'array')
assert.equal(categorySchema.oneOf[1].items.type, 'string')
const excludeSchema = tool.parameters.properties.exclude
assert.equal(Array.isArray(excludeSchema.oneOf), true, 'exclude accepts a string or an array')
assert.equal(typeof tool.output.render, 'function')
assert.equal(tool.output.schema.type, 'object')

const total = KAOMOJI_CATEGORIES.reduce((sum, meta) => sum + KAOMOJI_POOL[meta.key].length, 0)

async function call(args, execution) {
  const value = await tool.execute(args, execution)
  const content = tool.output.render(args, value)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  return { value, text: content[0].text }
}

const inPool = (entry) => KAOMOJI_CATEGORIES.some((meta) => KAOMOJI_POOL[meta.key].includes(entry))

const all = await call({})
assert.equal(all.value.kaomoji.length, 8, 'default count is 8')
assert.equal(new Set(all.value.kaomoji).size, 8, 'candidates are distinct')
assert.equal(all.value.remaining, total)
for (const entry of all.value.kaomoji) assert.ok(inPool(entry), `candidate ${JSON.stringify(entry)} comes from the pool`)
assert.ok(all.text.includes('至多挑 1–2 个'))
assert.ok(all.text.includes('不要换成彩色 Emoji'))

// Single Chinese category name.
const happy = await call({ category: '开心', count: 5 })
assert.equal(happy.value.kaomoji.length, 5)
assert.deepEqual(happy.value.categories, ['happy'])
for (const entry of happy.value.kaomoji) assert.ok(KAOMOJI_POOL.happy.includes(entry))

// Several categories round-robin; empty array means "all categories".
const mixed = await call({ category: ['happy', '害羞'], count: 6 })
assert.equal(mixed.value.kaomoji.length, 6)
assert.deepEqual(new Set(mixed.value.categories), new Set(['happy', 'shy']))
const mixedPools = new Set([...KAOMOJI_POOL.happy, ...KAOMOJI_POOL.shy])
for (const entry of mixed.value.kaomoji) assert.ok(mixedPools.has(entry))
const unfiltered = await call({ category: [], count: 3 })
assert.equal(unfiltered.value.kaomoji.length, 3)

// Invalid input stays a readable error.
await assert.rejects(() => call({ category: 'nonsense' }), /未知分类/)
await assert.rejects(() => call({ category: ['happy', 'nonsense'] }), /未知分类/)
await assert.rejects(() => call({ category: 42 }), /category 必须是字符串或字符串数组/)
await assert.rejects(() => call({ exclude: 42 }), /exclude 必须是字符串或字符串数组/)

// Exclude is normalized: full-width / half-width / space variants match.
const variantExclude = await call({ category: 'greeting', count: 24, exclude: '(◕‿◕)ノ' })
const banned = normalizeEntry('(◕‿◕)ノ')
assert.ok(!variantExclude.value.kaomoji.some((entry) => normalizeEntry(entry) === banned), 'normalized exclude blocks width variants')
assert.equal(variantExclude.value.remaining, total - 2, 'both width variants count as excluded')

// Array exclude and normalized remaining count.
const first = await call({ category: 'happy', count: 5 })
const excludedKeys = new Set(first.value.kaomoji.map((entry) => normalizeEntry(entry)))
const second = await call({ category: 'happy', count: 5, exclude: first.value.kaomoji })
for (const entry of first.value.kaomoji) assert.ok(!second.value.kaomoji.includes(entry))
// remaining counts pool entries, and one excluded face can match several
// entries (cross-category width variants), so count matching entries.
const excludedEntries = KAOMOJI_CATEGORIES.reduce(
  (sum, meta) => sum + KAOMOJI_POOL[meta.key].filter((entry) => excludedKeys.has(normalizeEntry(entry))).length, 0)
assert.equal(second.value.remaining, total - excludedEntries)

// One response never repeats a face, even across categories.
const wide = await call({ count: 24 })
assert.equal(wide.value.kaomoji.length, 24)
assert.equal(new Set(wide.value.kaomoji.map((entry) => normalizeEntry(entry))).size, 24, 'no visual duplicates in one draw')

// Recent draws are softly avoided when the pool has enough alternatives.
const recentA = await call({ category: 'happy', count: 5 })
const recentB = await call({ category: 'happy', count: 5 })
const recentKeys = new Set(recentA.value.kaomoji.map((entry) => normalizeEntry(entry)))
assert.equal(recentB.value.kaomoji.filter((entry) => recentKeys.has(normalizeEntry(entry))).length, 0, 'second draw avoids recent faces')

// Count clamping.
const clamp = await call({ count: 999 })
assert.equal(clamp.value.kaomoji.length, 24, 'count is clamped to maxCount')
const happyOnly = await call({ category: 'happy', count: 30 })
assert.equal(happyOnly.value.kaomoji.length, 24, 'tool cap applies before the category pool')

// Prompt section: hints, discipline and deterministic bytes.
const section = registeredSections[0]
assert.equal(section.name, 'kaomoji:pool')
assert.equal(section.interpolate, false)
assert.ok(section.text.startsWith('## 颜文字池'))
assert.ok(section.text.includes(`共 ${total} 个颜文字`))
assert.ok(section.text.includes('kaomoji'))
assert.ok(section.text.includes('每条回复至多 1–2 个，可以不用'), 'usage discipline stays explicit')
assert.ok(!section.text.includes('连续两条回复都带'), 'repeated personality guidance is not duplicated here')
for (const meta of KAOMOJI_CATEGORIES) {
  assert.ok(section.text.includes(`- ${meta.label}（${meta.key}；${meta.hint}）：`), `section lists ${meta.key} with its hint`)
}
const defaultLines = section.text.split('\n').filter((line) => /^- .+（[a-z]+；.+）：/.test(line))
assert.equal(defaultLines.length, KAOMOJI_CATEGORIES.length)
const defaultFavouritePart = defaultLines[0].slice(defaultLines[0].indexOf('）：') + 2)
assert.equal(defaultFavouritePart.trim().split(/\s+/).length, 1, 'default inlinePerCategory is one')

const repeat = []
const secondCtx = {
  ...fakeCtx,
  tools: { register: () => disposable },
  inject: (_deps, callback) =>
    callback({
      effect: fakeCtx.effect,
      systemPrompt: { section: (value) => { repeat.push(value); return disposable } },
    }),
}
apply(secondCtx, {})
assert.equal(repeat[0].text, section.text, 'prompt section is deterministic')

// Config plumbing: tool off, prompt limited to two inline categories.
const customTools = []
const customSections = []
apply({
  effect: fakeCtx.effect,
  tools: { register: (definition) => { customTools.push(definition); return disposable } },
  inject: (_deps, callback) =>
    callback({
      effect: fakeCtx.effect,
      systemPrompt: { section: (value) => { customSections.push(value); return disposable } },
    }),
}, { tool: false, inlinePerCategory: 2, inlineCategories: ['happy', 'shy'], sectionOrder: 9000, avoidRecent: 0 })

assert.equal(customTools.length, 0, 'tool:false skips tool registration')
assert.equal(customSections.length, 1)
assert.equal(customSections[0].order, 9000)
const customLines = customSections[0].text.split('\n').filter((line) => /^- .+（[a-z]+；.+）：/.test(line))
assert.equal(customLines.length, 2, 'only the configured inline categories are listed')
assert.ok(customLines[0].startsWith('- 开心（happy；'))
assert.ok(customLines[1].startsWith('- 害羞（shy；'))
const favouritePart = customLines[0].slice(customLines[0].indexOf('）：') + 2)
assert.equal(favouritePart.trim().split(/\s+/).length, 2, 'inlinePerCategory controls the favourites count')

// The second execution argument scopes recency to an agent. With deterministic
// randomness, independent agents receive the same first draw while the same
// agent receives a different follow-up draw.
const isolatedMount = mountTool({ avoidRecent: 24 })
const agentA = {}
const agentB = {}
const originalRandom = Math.random
try {
  Math.random = () => 0
  const firstA = await isolatedMount.tool.execute({ category: 'happy', count: 5 }, { agent: agentA })
  const firstB = await isolatedMount.tool.execute({ category: 'happy', count: 5 }, { agent: agentB })
  assert.deepEqual(firstB.kaomoji, firstA.kaomoji, 'different agents do not share recent history')
  const secondA = await isolatedMount.tool.execute({ category: 'happy', count: 5 }, { agent: agentA })
  assert.equal(
    secondA.kaomoji.some((entry) => firstA.kaomoji.includes(entry)),
    false,
    'the same agent avoids its own recent faces',
  )

  const fallbackA = mountTool({ avoidRecent: 24 }).tool
  const fallbackB = mountTool({ avoidRecent: 24 }).tool
  const fallbackFirstA = await fallbackA.execute({ category: 'happy', count: 5 })
  const fallbackFirstB = await fallbackB.execute({ category: 'happy', count: 5 })
  assert.deepEqual(fallbackFirstB.kaomoji, fallbackFirstA.kaomoji, 'fallback history is per plugin instance')
} finally {
  Math.random = originalRandom
}

// Excluding a whole category returns an empty candidate list and a readable
// render result rather than throwing or fabricating a face.
const exhaustionTool = mountTool({ maxCount: 100, avoidRecent: 0 }).tool
const exhausted = await exhaustionTool.execute({
  category: 'happy',
  count: 100,
  exclude: KAOMOJI_POOL.happy,
})
assert.deepEqual(exhausted.kaomoji, [])
assert.ok(exhaustionTool.output.render({}, exhausted)[0].text.includes('没有更多未排除'))

// The host owns effect disposal; verify the tool registration returns a
// disposer that is invoked when the plugin instance unloads.
const lifecycleMount = mountTool()
assert.equal(lifecycleMount.unregisterCount, 0)
lifecycleMount.dispose()
assert.equal(lifecycleMount.unregisterCount, 1, 'unloading removes the registered tool')

console.log(JSON.stringify({
  ok: true,
  total,
  normalizedTotal: new Set(KAOMOJI_CATEGORIES.flatMap((meta) => KAOMOJI_POOL[meta.key].map(normalizeEntry))).size,
  categories: KAOMOJI_CATEGORIES.length,
  tool: tool.name,
  section: section.name,
  sectionChars: section.text.length,
  defaultDraw: all.value.kaomoji,
}, null, 2))
