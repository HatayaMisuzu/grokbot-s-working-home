import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { reviewElements } from '../art/elements.js'
import { createEngine } from '../art/engine.js'
import { createArtTool } from '../art/tool.js'

test('no element hints when nothing is asked', () => {
  assert.equal(reviewElements({ text: 'x' }), undefined)
  const result = createEngine({}).run({ action: 'check', text: 'abc' })
  assert.equal(result.elementReview, undefined)
})

test('request without elements asks the model to list them', () => {
  const review = reviewElements({ text: 'x', request: '画一只抱着月亮睡觉的小猫' })
  assert.equal(review.elements.length, 0)
  assert.match(review.hints[0], /列出必须画出的/)
})

test('each element becomes a checklist item with its source and a caption reminder', () => {
  const review = reviewElements({
    text: ' /\\_/\\\n( -.- )',
    elements: ['猫耳', '月亮', '抱', '月亮', ' ', 42],
    request: '画一只抱着月亮睡觉的小猫',
    caption: '小猫抱着月亮睡着了',
  })
  assert.deepEqual(review.elements, ['猫耳', '月亮', '抱'])
  assert.match(review.hints[1], /^□ 月亮（题目、配文提到）/)
  assert.match(review.hints[0], /^□ 猫耳：/)
  assert.match(review.hints.at(-1), /配文里描述的每件事/)
})

test('a text label instead of a drawing is flagged', () => {
  const review = reviewElements({ text: '  (o.o)  ~~ 星星 ~~', elements: ['星星'] })
  assert.match(review.hints[0], /文字标签不能代替画面/)
})

test('element list is capped', () => {
  const review = reviewElements({ elements: Array.from({ length: 30 }, (_, i) => `e${i}`) })
  assert.equal(review.elements.length, 12)
})

test('text_art check renders element review and schema accepts the new fields', async () => {
  const tool = createArtTool({})
  for (const key of ['elements', 'request', 'caption']) assert.ok(tool.parameters.properties[key], key)
  const value = await tool.execute({ action: 'check', text: ' /\\_/\\', elements: ['月亮'], caption: '抱着月亮' })
  assert.ok(value.elementReview)
  const [rendered] = tool.output.render({}, value)
  assert.match(rendered.text, /要素核对（提示，不是判定）/)
  assert.match(rendered.text, /□ 月亮（配文提到）/)
})

test('skill demos keep process only, no finished drawings', async () => {
  const skill = await readFile(new URL('../skills/text-art-freehand/SKILL.md', import.meta.url), 'utf8')
  const demos = skill.slice(skill.indexOf('## 构造示范'), skill.indexOf('**反例'))
  assert.ok(demos.includes('示范 3'))
  assert.equal(/```/.test(demos), false, 'no fenced finished art in demos')
  assert.match(skill, /elements=\[/)
})
