import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { guidance } from '../lib/index.js'

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const emoji = /\p{Extended_Pictographic}/u

test('bundle inserts the host row and the maoqiu preset with the scoped mode helper', () => {
  assert.match(patch, /- id: maoqiu\n\s+name: dsh-maoqiu\n/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'\n\s+config:\n\s+id: maoqiu\n/)
  assert.match(patch, /name: dsh-maoqiu\/mode\n\s+config:\n\s+restrictWorkloop: true/)
  assert.doesNotMatch(patch, /@local\/dsh-maoqiu-mode'?\n/)
  assert.equal(pkg.exports['./mode'], './lib/mode.js')
})

test('engines cover rc.3 and rc.4', () => {
  assert.equal(pkg.version, '0.4.0')
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.3 <0.3.0-0')
})

test('persona and guidance avoid emoji, template quotas and contrast clichés', () => {
  for (const text of [patch, guidance]) {
    assert.doesNotMatch(text, emoji)
    assert.doesNotMatch(text, /不是[^。\n]{0,30}而是/)
  }
  for (const banned of ['电量', '最多一两个', '叠字', '嘿嘿', '欸嘿']) assert.ok(!patch.includes(banned), banned)
  for (const kept of ['温柔', '黏人', '女仆', '恋爱感', '反驳', '自己的兴趣', '可以安静', '括号', '颜文字', 'maoqiu_']) assert.ok(patch.includes(kept), kept)
})
