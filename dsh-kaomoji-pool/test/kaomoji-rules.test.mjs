import test from 'node:test'
import assert from 'node:assert/strict'
import { readConfig, KAOMOJI_RULES, hasColorEmoji, clampInteger } from '../config.js'
import { mountChat } from '../index.js'
import * as kaomoji from '../kaomoji.js'
import { KAOMOJI_POOL } from '../pool.js'

function ctx() {
  const prompts = [], tools = new Map()
  const c = {
    tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name) } },
    systemPrompt: { section(s) { prompts.push(s); return () => prompts.splice(prompts.indexOf(s), 1) } },
    skills: { registerProvider() { return () => {} } },
    effect(fn) { fn() }, inject(_d, fn) { fn(c) },
  }
  return { c, prompts, tools }
}

test('rules: light scenes only, 1–2 per reply, text symbols allowed, colour emoji banned', () => {
  const text = KAOMOJI_RULES.join('\n')
  assert.match(text, /轻松/)
  assert.match(text, /1–2 个/)
  assert.match(text, /♡ ♪ ✿/)
  assert.match(text, /彩色 Emoji.*一律不用/)
  assert.equal(hasColorEmoji(text), false, 'rule text itself must not contain colour emoji')
})

test('chat bridge injects compact kaomoji rules when the kaomoji tool is on', async () => {
  const { c, prompts, tools } = ctx()
  await mountChat(c, readConfig({ activation: 'scoped', art: false }))
  assert.ok(tools.has('kaomoji'))
  const chat = prompts.filter(p => p.name === 'text-art:chat')
  assert.equal(chat.length, 1)
  for (const rule of KAOMOJI_RULES) assert.ok(chat[0].text.includes(rule))
  assert.equal(prompts.some(p => p.name === 'kaomoji:pool'), false, 'no duplicate long pool section')
  assert.ok(chat[0].text.length < 500)
})

test('no kaomoji rules when the kaomoji tool is off', async () => {
  const { c, prompts } = ctx()
  await mountChat(c, readConfig({ activation: 'scoped', tool: false }))
  assert.equal(prompts[0].text.includes(KAOMOJI_RULES[0]), false)
})

test('standalone kaomoji section carries the same rules', () => {
  const { c, prompts } = ctx()
  kaomoji.apply(c, {})
  const section = prompts.find(p => p.name === 'kaomoji:pool')
  for (const rule of KAOMOJI_RULES) assert.ok(section.text.includes(rule))
})

test('colour emoji detector', () => {
  for (const bad of ['(^_^)😀', '❤️', '☺\uFE0F', '1\uFE0F\u20E3', '👍🏻', '🇨🇳', '👨\u200D👩', '⭐', '☀']) assert.equal(hasColorEmoji(bad), true, bad)
  for (const ok of ['(◕‿◕)♡', '♪(´▽｀)', '(✿◠‿◠)', '(✧ω✧)', '(｡•̀ᴗ-)✧', '(´･ω･`)']) assert.equal(hasColorEmoji(ok), false, ok)
  for (const entry of Object.values(KAOMOJI_POOL).flat()) assert.equal(hasColorEmoji(entry), false, entry)
})

test('shared config reader clamps both art and kaomoji fields', () => {
  const config = readConfig({ maxWidth: 999, defaultCount: 7.9, avoidRecent: 'x', inlinePerCategory: -3 })
  assert.equal(config.maxWidth, 240)
  assert.equal(config.defaultCount, 7)
  assert.equal(config.avoidRecent, 24)
  assert.equal(config.inlinePerCategory, 0)
  assert.equal(clampInteger(NaN, 5, 0, 9), 5)
})
