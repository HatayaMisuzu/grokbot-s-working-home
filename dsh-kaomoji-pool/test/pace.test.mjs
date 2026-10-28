import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createEngine } from '../art/engine.js'
import { createArtTool } from '../art/tool.js'

const agent = () => ({ execution: { agent: {} } })

test('draw result reminds to call check(elements=...) before delivering', () => {
  const engine = createEngine({})
  const { execution } = agent()
  const drawn = engine.run({ action: 'draw', text: '(=^.^=)' }, execution)
  assert.equal(drawn.pace.draws, 1)
  assert.match(drawn.pace.hint, /交付前先调用 check\(text=.*elements=\[/)
  assert.match(drawn.pace.hint, /禁止用 bash、python/)
  assert.match(drawn.pace.hint, /只用 text_art/)
  const text = createArtTool({}).output.render({}, drawn)[0].text
  assert.match(text, /下一步：.*check\(.*elements=/)
  assert.match(text, /禁止用 bash、python/)
})

test('redraw before any check is counted and discouraged', () => {
  const engine = createEngine({})
  const { execution } = agent()
  engine.run({ action: 'draw', text: 'a' }, execution)
  const again = engine.run({ action: 'draw', text: 'b' }, execution)
  assert.equal(again.pace.redraws, 1)
  assert.match(again.pace.hint, /已整幅重画 1 次.*不要再重画/)
})

test('check then two edits ends with a deliver instruction', () => {
  const engine = createEngine({})
  const { execution } = agent()
  engine.run({ action: 'draw', text: 'a' }, execution)
  const checked = engine.run({ action: 'check', text: 'a', elements: ['猫'] }, execution)
  assert.equal(checked.pace.checks, 1)
  assert.match(checked.pace.hint, /还可 edit 2 次/)
  const first = engine.run({ action: 'edit', text: 'ab' }, execution)
  assert.match(first.pace.hint, /还可再改 1 次/)
  const second = engine.run({ action: 'edit', text: 'abc' }, execution)
  assert.equal(second.pace.edits, 2)
  assert.match(second.pace.hint, /达到上限，现在交付/)
  const after = engine.run({ action: 'draw', text: 'new' }, execution)
  assert.deepEqual([after.pace.draws, after.pace.redraws, after.pace.edits], [1, 0, 0])
})

test('pace is per agent and absent for guide/inspect', () => {
  const engine = createEngine({})
  const a = agent().execution, b = agent().execution
  engine.run({ action: 'draw', text: 'a' }, a)
  assert.equal(engine.run({ action: 'draw', text: 'b' }, b).pace.redraws, 0)
  assert.equal(engine.run({ action: 'inspect' }, a).pace, undefined)
})

test('skill fixes the rhythm and still has no finished demo drawings', async () => {
  const skill = await readFile(new URL('../skills/text-art-freehand/SKILL.md', import.meta.url), 'utf8')
  const rhythm = skill.split('## 固定节奏')[1].split('\n## ')[0]
  assert.match(rhythm, /draw 1 次/)
  assert.match(rhythm, /check 1 次/)
  assert.match(rhythm, /最多 edit 2 次/)
  assert.match(rhythm, /交付/)
  assert.match(rhythm, /禁止用 bash、python/)
  assert.match(skill, /字符画只用 `text_art`/)
  assert.match(skill, /禁止用 bash、python/)
  const demos = skill.split('## 构造示范')[1].split('\n## ')[0]
  assert.doesNotMatch(demos, /```/)
})

test('check and edit hints also ban bash/python', () => {
  const engine = createEngine({})
  const { execution } = agent()
  engine.run({ action: 'draw', text: 'a' }, execution)
  const checked = engine.run({ action: 'check', text: 'a', elements: ['x'] }, execution)
  assert.match(checked.pace.hint, /禁止用 bash、python/)
  const edited = engine.run({ action: 'edit', text: 'ab' }, execution)
  assert.match(edited.pace.hint, /禁止用 bash、python/)
  assert.match(createArtTool({}).output.render({}, edited)[0].text, /禁止用 bash、python/)
})
