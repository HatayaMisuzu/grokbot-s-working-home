import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, renderCanvas, measureText, toMarkdown } from '../art/engine.js'
import { createArtTool } from '../art/tool.js'

const limits = { maxWidth: 120, maxHeight: 80 }
const draw = (objects, extra = {}) => renderCanvas({ objects, ...extra }, limits)
const text = (id, value, x = 0, y = 0, extra = {}) => ({ id, kind: 'text', text: value, x, y, ...extra })

test('raw drawings preserve every margin, blank line and slash', () => {
  const original = '\n  /\\  \n (  ) \n\n'
  const engine = createEngine()
  const work = engine.run({ action: 'draw', text: original })
  assert.equal(work.text, original)
  assert.equal(work.height, 5)
  assert.equal(engine.run({ action: 'inspect', artId: work.artId }).text, original)
})

test('normalization expands tabs to display-column stops and retains spaces', () => {
  const checked = measureText('中\tX\r\n  z  ', limits)
  assert.equal(checked.text, '中  X\n  z  ')
  assert.equal(checked.width, 5)
  assert.deepEqual(checked.lineWidths, [5, 5])
})

test('grapheme widths handle CJK, astral emoji and combining glyphs', () => {
  assert.equal(measureText('A中🙂e\u0301', limits).width, 6)
  assert.equal(measureText('👨‍👩‍👧', limits).width, 2)
  assert.equal(measureText('𝑥', limits).width, 1)
  assert.throws(() => measureText('\ud800', limits), /代理码点/)
})

test('combining marks at the start of a later row cannot attach across a newline', () => {
  assert.ok(measureText('A\n\u0301B', limits).warnings.some(warning => /独立组合/.test(warning)))
  assert.throws(() => draw([text('rows', 'A\n\u0301B')]), /独立组合/)
})

test('returned snapshots cannot mutate stored history', () => {
  const engine = createEngine()
  const original = engine.run({ action: 'draw', text: 'AB' })
  original.warnings.push('external')
  original.lineWidths[0] = 999
  const reread = engine.run({ action: 'inspect', artId: original.artId })
  assert.deepEqual(reread.warnings, [])
  assert.deepEqual(reread.lineWidths, [2])
})

test('control characters fail visibly instead of silently changing the art', () => {
  for (const control of ['\u001b[31m', '\u0000', '\u202e', '\u200b'])
    assert.throws(() => measureText('a' + control, limits), /控制字符/)
})

test('fence grows beyond embedded backticks', () => {
  assert.equal(toMarkdown('a\n```\nb'), '````\na\n```\nb\n````')
  assert.equal(toMarkdown('`'), '```\n`\n```')
})

test('user-defined layers use transparency and order', () => {
  const background = text('bg', 'ABCDE\nFGHIJ')
  assert.equal(draw([background, text('custom', ' X ', 1, 0)]).text, 'ABXDE\nFGHIJ')
  assert.equal(draw([background, text('erase', ' X ', 1, 0, { transparent: false })]).text, 'A X E\nFGHIJ')
})

test('overwriting either half of a wide glyph removes the entire previous glyph', () => {
  assert.equal(draw([text('wide', '中AB'), text('over', 'x', 1)]).text, ' xAB')
  assert.equal(draw([text('wide', 'A中B'), text('over', 'x', 1)]).text, 'Ax B')
  assert.equal(draw([text('one', 'ABCD'), text('two', '中', 1)]).text, 'A中D')
})

test('generic geometry has deterministic bounds and paint order', () => {
  const box = { id: 'frame', kind: 'box', x: 0, y: 0, width: 5, height: 3 }
  assert.equal(draw([box]).text, '+---+\n|   |\n+---+')
  assert.equal(draw([box], { style: 'unicode' }).text, '┌───┐\n│   │\n└───┘')
  assert.equal(draw([{ ...box, fill: '.' }]).text, '+---+\n|...|\n+---+')
  assert.equal(draw([{ id: 'edge', kind: 'line', x: 0, y: 0, x2: 3, y2: 0 }]).text, '----')
  assert.equal(draw([{ id: 'edge', kind: 'line', x: 0, y: 0, x2: 2, y2: 2 }]).text, '\\  \n \\ \n  \\')
  const oval = draw([{ id: 'orbit', kind: 'ellipse', x: 0, y: 0, width: 9, height: 5, char: 'o' }])
  assert.equal(oval.height, 5)
  assert.equal(oval.width, 9)
  assert.ok(oval.text.includes('o'))
})

test('out-of-bounds, invalid geometry and duplicate names do not silently crop', () => {
  assert.throws(() => draw([text('one', 'abc', 2)], { width: 4 }), /超出/)
  assert.throws(() => draw([text('one', 'abc', -1)]), /整数/)
  assert.throws(() => draw([text('one', 'a'), text('one', 'b')]), /重复/)
  assert.throws(() => draw([{ kind: 'line', x2: 1.5, y2: 2 }]), /整数/)
  assert.throws(() => draw([{ kind: 'box', width: 3, height: 3, char: '中' }]), /单列/)
  assert.throws(() => draw([text('one', '\u0301a')]), /组合附加符/)
})

test('edit preserves unrelated layers and old versions; invalid edits are atomic', () => {
  const engine = createEngine()
  const first = engine.run({ action: 'draw', objects: [text('roof', '/\\'), text('sign', 'A', 0, 1)], width: 6, height: 3 })
  const edited = engine.run({ action: 'edit', artId: first.artId, changes: [{ id: 'sign', text: 'B', x: 3 }] })
  assert.equal(edited.parentId, first.artId)
  assert.equal(edited.text, '/\\    \n   B  \n      ')
  assert.equal(engine.run({ action: 'inspect', artId: first.artId }).text, first.text)
  assert.throws(() => engine.run({ action: 'edit', artId: edited.artId, changes: [{ id: 'sign', x: 6 }] }), /超出/)
  assert.equal(engine.run({ action: 'inspect' }).artId, edited.artId)
  const grown = engine.run({ action: 'edit', changes: [{ id: 'sign', x: 6 }], width: 8 })
  assert.equal(grown.artId, 'art-3')
})

test('edit adds, removes and can replace custom raw text', () => {
  const engine = createEngine()
  engine.run({ action: 'draw', objects: [text('a', 'A'), text('b', 'B', 1)], width: 3 })
  const edit = engine.run({ action: 'edit', changes: [{ id: 'a', remove: true }, { id: 'c', kind: 'text', x: 2, text: 'C' }] })
  assert.equal(edit.text, ' BC')
  const raw = engine.run({ action: 'edit', text: '  freehand\n  /  \\' })
  assert.equal(raw.layers.length, 0)
  assert.throws(() => engine.run({ action: 'edit', changes: [{ id: 'b', x: 0 }] }), /原文画/)
})

test('history is isolated and bounded; check never evicts a drawing', () => {
  const engine = createEngine({ historySize: 2 })
  const a = { agent: {} }, b = { agent: {} }
  const first = engine.run({ action: 'draw', text: 'A' }, a)
  assert.throws(() => engine.run({ action: 'inspect', artId: first.artId }, b), /找不到/)
  engine.run({ action: 'check', text: 'test' }, a)
  assert.equal(engine.run({ action: 'inspect' }, a).artId, first.artId)
  engine.run({ action: 'draw', text: 'B' }, a)
  engine.run({ action: 'draw', text: 'C' }, a)
  assert.throws(() => engine.run({ action: 'inspect', artId: first.artId }, a), /找不到/)
})

test('overflow can be checked without committing a broken drawing', () => {
  const engine = createEngine({ maxWidth: 4, maxHeight: 2 })
  const result = engine.run({ action: 'check', text: '12345\na\nb' })
  assert.equal(result.fits, false)
  assert.equal(result.warnings.filter(x => x.includes('超过')).length, 2)
  assert.throws(() => engine.run({ action: 'draw', text: '12345' }), /超过/)
  assert.throws(() => engine.run({ action: 'draw', text: 'a', objects: [text('a', 'b')] }), /其中一种/)
  assert.throws(() => engine.run({ action: 'draw', text: ' ' }), /空白/)
})

test('cancellation precedes state changes', () => {
  const engine = createEngine()
  const signal = AbortSignal.abort(new Error('stopped'))
  assert.throws(() => engine.run({ action: 'draw', text: 'a' }, { signal }), /stopped/)
  assert.equal(engine.run({ action: 'draw', text: 'b' }).artId, 'art-1')
})

test('tool teaches techniques and returns exactly one protected drawing', async () => {
  const tool = createArtTool(limits)
  const guide = await tool.execute({ action: 'guide' })
  assert.match(guide.content, /主语和动词|主语/)
  assert.match(guide.content, /不是.*prompt|不会替你理解题材/)
  for (const topic of ['contours', 'composition', 'shading', 'unicode']) {
    const extra = await tool.execute({ action: 'guide', topic })
    assert.ok(extra.content.length > 250, `${topic} should contain a real technique guide`)
  }
  assert.equal(tool.isConcurrencySafe({ action: 'guide' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'edit' }), false)
  const value = await tool.execute({ action: 'draw', text: '  /\\\n <  >' })
  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0].text, /art-1/)
  assert.ok(rendered[0].text.includes('```\n  /\\\n <  >\n```'))
  await assert.rejects(tool.execute({ action: 'guide', topic: '../../anything' }), /topic/)
})
