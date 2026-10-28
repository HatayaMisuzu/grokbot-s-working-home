#!/usr/bin/env node
/**
 * Corpus validator for the Kaomoji Pool plugin.
 *
 * Enforces the quality contract the prompt text and the tool rely on:
 * markdown-safe entries, no emoji pictographs, sane lengths, global
 * uniqueness, category coverage, category hints, and the minimum inventory
 * size. Visual near-duplicates are checked after NFKC/whitespace/invisible
 * normalization: within one category they are a violation, across categories
 * they are reported as material variants because a single draw already
 * de-duplicates them.
 *
 * Usage: node scripts/validate-pool.mjs
 * Exit code 1 on any violation.
 */
import { KAOMOJI_CATEGORIES, KAOMOJI_POOL } from '../pool.js'

const MIN_PER_CATEGORY = {
  happy: 40,
  gentle: 35,
  shy: 35,
  coy: 35,
  surprised: 38,
  confused: 35,
  sad: 38,
  angry: 35,
  helpless: 40,
  proud: 35,
  encourage: 35,
  sorry: 28,
  thanks: 28,
  greeting: 30,
  sleepy: 30,
  love: 38,
  animal: 50,
  funny: 38,
  speechless: 35,
  farewell: 28,
}
const MIN_TOTAL = 700
const MIN_LENGTH = 2
const MAX_LENGTH = 40
const MAX_HINT_LENGTH = 30
const MAX_ASCII_ONLY_RATIO = 0.08
const BANNED_ASCII = /[\\*_`~[\]|'"]/
const CONTROL_OR_SPACE = /[\u0000-\u001f\u007f]/
const THEME_DEDUPE = new Set(['(๑•̀ㅂ•́)و✧', '(｡•́︿•̀｡)', '(〃▽〃)', '٩(๑>◡<๑)۶'])

/** Same comparison key the plugin uses to spot "the same face". */
const normalizeEntry = (value) =>
  String(value).normalize('NFKC').replace(/\s+/g, '').replace(/[\u200B-\u200D\u2060\uFE00-\uFE0F]/g, '')

const problems = []
const seen = new Map()
const normalizedGlobal = new Map()
let crossCategoryVariants = 0
let total = 0
let asciiOnly = 0

const categoryKeys = KAOMOJI_CATEGORIES.map((meta) => meta.key)
const missingKeys = categoryKeys.filter((key) => !Array.isArray(KAOMOJI_POOL[key]))
const extraKeys = Object.keys(KAOMOJI_POOL).filter((key) => !categoryKeys.includes(key))
if (missingKeys.length > 0) problems.push(`缺少分类数组: ${missingKeys.join(', ')}`)
if (extraKeys.length > 0) problems.push(`多余分类数组: ${extraKeys.join(', ')}`)

for (const meta of KAOMOJI_CATEGORIES) {
  const entries = KAOMOJI_POOL[meta.key]
  const label = `${meta.key}（${meta.label}）`
  if (typeof meta.hint !== 'string' || meta.hint.trim() === '') {
    problems.push(`${label} 缺少 hint，提示段无法说明适用情绪`)
  } else if (Array.from(meta.hint).length > MAX_HINT_LENGTH) {
    problems.push(`${label} hint 过长（${Array.from(meta.hint).length} > ${MAX_HINT_LENGTH}）`)
  }
  if (typeof meta.en !== 'string' || meta.en.trim() === '') problems.push(`${label} 缺少英文标签 en`)
  if (!Array.isArray(entries)) continue
  const minimum = MIN_PER_CATEGORY[meta.key] ?? 0
  if (entries.length < minimum) problems.push(`${label} 只有 ${entries.length} 条，少于 ${minimum} 条`)
  total += entries.length
  const normalizedLocal = new Map()
  for (const [index, entry] of entries.entries()) {
    const where = `${label}[${index}]`
    if (typeof entry !== 'string') {
      problems.push(`${where} 不是字符串: ${String(entry)}`)
      continue
    }
    const points = Array.from(entry)
    if (points.length < MIN_LENGTH || points.length > MAX_LENGTH) {
      problems.push(`${where} 长度 ${points.length}: ${JSON.stringify(entry)}`)
    }
    if (entry !== entry.trim()) problems.push(`${where} 首尾有空白: ${JSON.stringify(entry)}`)
    if (CONTROL_OR_SPACE.test(entry)) problems.push(`${where} 含控制字符: ${JSON.stringify(entry)}`)
    if (BANNED_ASCII.test(entry)) problems.push(`${where} 含 Markdown 风险字符: ${JSON.stringify(entry)}`)
    if (/[\u{e000}-\u{f8ff}]/u.test(entry)) problems.push(`${where} 含私用区字符: ${JSON.stringify(entry)}`)
    if (/[\u{1f300}-\u{1faff}\u{fe0f}\u{200d}\u{200b}-\u{200f}\u{202a}-\u{202e}]/u.test(entry)) {
      problems.push(`${where} 含彩色 emoji/不可见控制符: ${JSON.stringify(entry)}`)
    }
    if (/\{\{|\}\}/.test(entry)) problems.push(`${where} 含模板变量标记: ${JSON.stringify(entry)}`)
    if (THEME_DEDUPE.has(entry)) problems.push(`${where} 与人设常用颜文字重复: ${JSON.stringify(entry)}`)
    if (!/[^\x00-\x7f]/.test(entry)) asciiOnly += 1

    const exactKey = entry.trim()
    if (seen.has(exactKey)) {
      problems.push(`重复 ${JSON.stringify(entry)}：${seen.get(exactKey)} 与 ${where}`)
    } else {
      seen.set(exactKey, where)
    }

    const normalized = normalizeEntry(entry)
    const previous = normalizedLocal.get(normalized)
    if (previous !== undefined) {
      problems.push(`类内视觉重复 ${JSON.stringify(entry)}：与 ${previous} 归一化相同`)
    } else {
      normalizedLocal.set(normalized, where)
    }
    const owner = normalizedGlobal.get(normalized)
    if (owner === undefined) normalizedGlobal.set(normalized, meta.key)
    else if (owner !== meta.key) crossCategoryVariants += 1
  }
}

if (total < MIN_TOTAL) problems.push(`总数 ${total}，少于 ${MIN_TOTAL}`)
if (total > 0 && asciiOnly / total > MAX_ASCII_ONLY_RATIO) {
  problems.push(`纯 ASCII 表情占比 ${(asciiOnly / total * 100).toFixed(1)}% 超过 ${MAX_ASCII_ONLY_RATIO * 100}%`)
}

const summary = {
  categories: KAOMOJI_CATEGORIES.length,
  total,
  asciiOnly,
  unique: seen.size,
  normalizedUnique: normalizedGlobal.size,
  crossCategoryVariants,
  perCategory: Object.fromEntries(
    KAOMOJI_CATEGORIES.map((meta) => [meta.key, Array.isArray(KAOMOJI_POOL[meta.key]) ? KAOMOJI_POOL[meta.key].length : 0]),
  ),
  violations: problems.length,
}
console.log(JSON.stringify(summary, null, 2))
if (problems.length > 0) {
  console.error('\n违规明细：')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  console.log(`\nOK: 语料库通过全部校验。跨分类视觉变体 ${crossCategoryVariants} 组（同批抽样会自动去重，保留作素材）。`)
}
