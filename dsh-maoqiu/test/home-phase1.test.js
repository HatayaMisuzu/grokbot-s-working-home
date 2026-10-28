import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import MaoqiuStore from '../lib/store.js'
import { buildHomeView, cornerList, heatOf, renderHtml, renderMarkdown, renderText } from '../lib/home-view.js'
import { fileVersion } from '../lib/space-items.js'

const run = promisify(execFile)
const cli = new URL('../bin/maoqiu.js', import.meta.url).pathname
const source = { kind: 'creation', ref: 'test' }

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-home1-'))
  const store = new MaoqiuStore(root)
  assert.equal((await store.init()).ok, true)
  try { await fn(store, root) } finally { await rm(root, { recursive: true, force: true }) }
}

const journalLines = async (store) => (await readFile(store.journalFile, 'utf8')).split('\n').filter(Boolean).map((x) => JSON.parse(x))

test('old data without visibility/corner keeps the old behaviour', async () => fixture(async (store) => {
  await store.space({ action: 'write', path: 'notes/rain.md', content: '雨声', source })
  const list = await store.space({ action: 'list' })
  assert.equal(list.private_count, 0)
  assert.equal(list.curtain, undefined)
  assert.equal(list.files[0].visibility, undefined)
  const recall = await store.recall({ query: '雨声', mode: 'chat' })
  assert.equal(recall.materials.length, 1)
}))

test('private material: not recalled, counted behind the curtain, readable by the owner, hidden from subagents', async () => fixture(async (store) => {
  await store.space({ action: 'write', path: 'notes/secret.md', content: '想多聊一会儿的雨夜', visibility: 'private', source })
  await store.space({ action: 'write', path: 'notes/open.md', content: '公开的雨夜', source })
  const recall = await store.recall({ query: '雨夜', mode: 'visit' })
  assert.deepEqual([...recall.materials, ...recall.recent].map((x) => x.path), ['notes/open.md'])
  const main = await store.space({ action: 'list', _viewer: 'main' })
  assert.equal(main.private_count, 1)
  assert.equal(main.curtain, '门帘后有 1 件')
  assert.equal(main.files.length, 2)
  const read = await store.space({ action: 'read', path: 'notes/secret.md', _viewer: 'main' })
  assert.equal(read.content, '想多聊一会儿的雨夜')
  const sub = await store.space({ action: 'list', _viewer: 'subagent' })
  assert.deepEqual(sub.files.map((x) => x.path), ['notes/open.md'])
  assert.equal(sub.private_count, 1)
  assert.equal((await store.space({ action: 'read', path: 'notes/secret.md', _viewer: 'subagent' })).ok, false)
  // A later write without visibility keeps it private.
  await store.space({ action: 'append', path: 'notes/secret.md', content: '。', source })
  assert.equal((await store.space({ action: 'read', path: 'notes/secret.md' })).metadata.visibility, 'private')
  await store.space({ action: 'write', path: 'notes/secret.md', content: '可以公开了', visibility: 'open', source })
  assert.equal((await store.space({ action: 'read', path: 'notes/secret.md' })).metadata.visibility, undefined)
}))

test('private interests and objects follow the same curtain rules', async () => fixture(async (store) => {
  await store.interest({ action: 'save', id: 'cat', title: '画猫', reason: '喜欢', source, visibility: 'private', corner: 'drafts' })
  await store.interest({ action: 'save', id: 'rain', title: '雨的别名', reason: '好听', source })
  assert.equal((await store.recall({ query: '画猫', mode: 'chat' })).interests.length, 0)
  assert.equal((await store.interest({ action: 'list', _viewer: 'subagent' })).interests.length, 1)
  const all = await store.interest({ action: 'list' })
  assert.equal(all.interests.length, 2)
  assert.equal(all.private_count, 1)
  await store.interest({ action: 'update', id: 'cat', progress: '画了耳朵', source })
  assert.equal((await store.interest({ action: 'read', id: 'cat' })).interest.visibility, 'private')
  assert.equal((await store.interest({ action: 'save', id: 'x', title: 'x', source, visibility: 'secret' })).ok, false)
  assert.equal((await store.object({ action: 'upsert', id: 'box', expected_version: 'missing', patch: { name: '小盒子', visibility: 'private' } })).ok, true)
  assert.equal((await store.object({ action: 'list', _viewer: 'subagent' })).objects.length, 0)
  assert.equal((await store.object({ action: 'read', id: 'box', _viewer: 'subagent' })).ok, false)
  assert.equal((await store.object({ action: 'list' })).private_count, 1)
}))

test('corner naming: placeholders, rename, reset, versioned and journaled', async () => fixture(async (store) => {
  const before = await store.space({ action: 'corners' })
  assert.equal(before.corners.find((x) => x.id === 'notes').name, '未命名 · notes')
  assert.equal(before.version, 'missing')
  const named = await store.withOp({ tool: 'maoqiu_space', action: 'name_corner' }, () => store.space({ action: 'name_corner', corner: 'notes', name: '小圆桌', expected_version: 'missing', source }))
  assert.equal(named.ok, true)
  assert.equal(named.corners.find((x) => x.id === 'notes').name, '小圆桌')
  assert.equal((await store.space({ action: 'name_corner', corner: 'notes', name: '另一个', expected_version: 'missing', source })).ok, false)
  assert.equal((await store.space({ action: 'name_corner', corner: 'kitchen', name: 'x', source })).ok, false)
  const reset = await store.space({ action: 'name_corner', corner: 'notes', name: '', expected_version: named.version, source })
  assert.equal(reset.corners.find((x) => x.id === 'notes').named, false)
  const entries = (await journalLines(store)).filter((x) => x.target === 'space/home.json')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].action, 'name_corner')
  assert.deepEqual(cornerList({}).map((x) => x.id), ['notes', 'drafts', 'collections', 'window', 'drawer', 'things', 'board', 'curtain'])
}))

test('journal: one entry per write, chained, no content copied, verify detects tampering and deleted history', async () => fixture(async (store) => {
  await store.space({ action: 'write', path: 'notes/a.md', content: '第一版私密原文', visibility: 'private', source })
  await store.space({ action: 'write', path: 'notes/a.md', content: '第二版', source })
  const entries = await journalLines(store)
  assert.equal(entries[0].action, 'journal-start')
  const writes = entries.filter((x) => x.target === 'space/notes/a.md')
  assert.deepEqual(writes.map((x) => x.op), ['create', 'update'])
  assert.ok(writes[1].history)
  assert.equal(writes[1].before, writes[0].after)
  assert.ok(!(await readFile(store.journalFile, 'utf8')).includes('私密原文'))
  assert.equal((await store.verifyJournal()).ok, true)

  const original = await readFile(store.journalFile, 'utf8')
  await writeFile(store.journalFile, original.replace('"op":"update"', '"op":"create"'))
  assert.equal((await store.verifyJournal()).ok, false)
  const lines = original.split('\n').filter(Boolean)
  await writeFile(store.journalFile, `${[...lines.slice(0, 2), ...lines.slice(3)].join('\n')}\n`)
  assert.match(JSON.stringify((await store.verifyJournal()).problems), /哈希链断开|序号不连续/)
  await writeFile(store.journalFile, original)
  await rm(join(store.historyDir, writes[1].history))
  assert.match(JSON.stringify((await store.verifyJournal()).problems), /已不存在/)
}))

test('journal keeps tool provenance and serializes concurrent writes', async () => fixture(async (store) => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.withOp({ tool: 'maoqiu_space', action: 'write', source_kind: 'creation' }, () => store.space({ action: 'write', path: `drafts/d${i}.md`, content: String(i), source }))))
  const verified = await store.verifyJournal()
  assert.equal(verified.ok, true, JSON.stringify(verified.problems))
  const drafts = (await journalLines(store)).filter((x) => x.target?.startsWith('space/drafts/'))
  assert.equal(drafts.length, 8)
  assert.ok(drafts.every((x) => x.tool === 'maoqiu_space' && x.actor === 'tool' && x.source_kind === 'creation'))
}))

test('heat levels and the read-only view', async () => fixture(async (store) => {
  const now = Date.parse('2026-10-28T12:00:00Z')
  assert.equal(heatOf('2026-10-20T12:00:00Z', now).level, 'warm')
  assert.equal(heatOf('2026-10-01T12:00:00Z', now).level, 'mild')
  assert.equal(heatOf('2026-08-01T12:00:00Z', now).level, 'dusty')
  assert.equal(heatOf('bad', now).level, 'unknown')
  await store.space({ action: 'write', path: 'notes/open.md', content: '公开<b>', source })
  await store.space({ action: 'write', path: 'drafts/p.md', content: '门帘后的原文', visibility: 'private', source })
  const files = ['space/active_interests.json', 'space/scene.json', 'space/journal.jsonl', 'space/notes/open.md']
  const versions = await Promise.all(files.map((f) => fileVersion(join(store.home, f))))
  const historyBefore = (await readdir(store.historyDir)).length
  const view = await buildHomeView(store, { now: Date.now() })
  assert.deepEqual(await Promise.all(files.map((f) => fileVersion(join(store.home, f)))), versions)
  assert.equal((await readdir(store.historyDir)).length, historyBefore)
  assert.equal(view.curtain.items.length, 1)
  assert.equal(view.curtain.items[0].content, '门帘后的原文')
  assert.equal(view.corners.find((x) => x.id === 'drafts').private_count, 1)
  const html = renderHtml(view)
  assert.match(html, /<details open>/)
  assert.match(html, /default-src 'none'/)
  assert.doesNotMatch(html, /<script|https?:\/\//i)
  assert.doesNotMatch(html, /公开<b>/)
  assert.doesNotMatch(html + renderText(view) + renderMarkdown(view), /\p{Extended_Pictographic}/u)
  assert.match(renderText(view), /门帘后有 1 件/)
  assert.match(renderMarkdown(view), /> 门帘后的原文/)
}))

test('cli view/verify/show work offline and refuse to write into the space', async () => fixture(async (store, root) => {
  await store.space({ action: 'write', path: 'notes/n.md', content: '你好', source })
  const out = join(tmpdir(), `maoqiu-view-${process.pid}-${Date.now()}.html`)
  try {
    const view = JSON.parse((await run('node', [cli, '--home', root, 'view', '--out', out])).stdout)
    assert.equal(view.ok, true)
    assert.match(await readFile(out, 'utf8'), /毛球的小家/)
    assert.match((await run('node', [cli, '--home', root, 'view', '--text'])).stdout, /未命名 · notes/)
    assert.equal(JSON.parse((await run('node', [cli, '--home', root, 'verify'])).stdout).ok, true)
    assert.equal((await run('node', [cli, '--home', root, 'show', 'notes/n.md'])).stdout, '你好\n')
    await assert.rejects(run('node', [cli, '--home', root, 'view', '--out', join(root, 'x.html')]))
  } finally { await rm(out, { force: true }) }
}))
