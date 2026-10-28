import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MaoqiuStore } from '../lib/store.js'

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'maoqiu-items-'))
  const store = new MaoqiuStore(home)
  assert.equal((await store.init()).ok, true)
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }))
  return store
}

test('file versions reject stale overwrites and replayed append call ids do not duplicate bytes', async (t) => {
  const store = await setup(t)
  const first = await store.space({ action: 'write', path: 'drafts/a.md', content: '甲', expected_version: 'missing' })
  assert.equal(first.ok, true)
  const added = await store.withWriteContext({ operationId: 'same-native-call' }, () => store.space({ action: 'append', path: first.path, content: '乙', expected_version: first.version }))
  assert.equal(added.content, '甲乙')
  const replay = await store.withWriteContext({ operationId: 'same-native-call' }, () => store.space({ action: 'append', path: first.path, content: '乙', expected_version: first.version }))
  assert.equal(replay.idempotent, true)
  assert.equal(replay.content, '甲乙')
  const conflict = await store.space({ action: 'write', path: first.path, content: '旧内容', expected_version: first.version })
  assert.equal(conflict.ok, false)
  assert.match(conflict.error, /版本冲突/)
  const raw = await readFile(join(store.spaceDir, first.path), 'utf8')
  await writeFile(join(store.spaceDir, first.path), raw.replace('甲乙', '编辑器新内容'))
  assert.equal((await store.space({ action: 'append', path: first.path, content: '错误追加', expected_version: replay.version })).ok, false)
})

test('stable objects change locally, reject stale versions, archive reversibly and survive reload', async (t) => {
  const store = await setup(t)
  const lamp = await store.object({ action: 'upsert', id: 'lamp', expected_version: 'missing', patch: { name: '小灯', region: '窗台', position: '左侧' } })
  assert.equal(lamp.ok, true)
  await store.object({ action: 'upsert', id: 'cup', expected_version: 'missing', patch: { name: '茶杯', region: '桌子' } })
  const moved = await store.object({ action: 'upsert', id: 'lamp', expected_version: lamp.version, patch: { position: '右侧' } })
  assert.equal(moved.object.region, '窗台')
  assert.equal((await store.object({ action: 'read', id: 'cup' })).object.name, '茶杯')
  assert.equal((await store.object({ action: 'upsert', id: 'lamp', expected_version: lamp.version, patch: { name: '过期名字' } })).ok, false)
  const archived = await store.object({ action: 'archive', id: 'lamp', expected_version: moved.version })
  assert.ok(!(await store.object({ action: 'list' })).objects.some((item) => item.id === 'lamp'))
  assert.equal((await store.object({ action: 'upsert', id: 'lamp', expected_version: archived.version, patch: { archived: false } })).ok, true)
  assert.equal((await new MaoqiuStore(store.home).object({ action: 'read', id: 'lamp' })).object.position, '右侧')
  assert.equal((await store.space({ action: 'scene', scene: { objects: {} } })).ok, false)
})

test('restore one file and one object without reverting other edits; restoration itself is reversible', async (t) => {
  const store = await setup(t)
  await store.space({ action: 'write', path: 'drafts/a.md', content: '第一段' })
  const latest = await store.space({ action: 'write', path: 'drafts/a.md', content: '第二段' })
  await store.space({ action: 'write', path: 'notes/keep.txt', content: '旁边的笔记' })
  const versions = await store.history({ path: latest.path })
  assert.equal(versions.ok, true)
  assert.equal((await store.history({ action: 'restore', path: latest.path, history_id: versions.history[0].history_id, expected_version: latest.version })).verified, true)
  assert.equal((await store.space({ action: 'read', path: latest.path })).content, '第一段')
  assert.equal((await store.space({ action: 'read', path: 'notes/keep.txt' })).content, '旁边的笔记')
  const firstLamp = await store.object({ action: 'upsert', id: 'lamp', patch: { name: '小灯', position: '左侧' } })
  const moved = await store.object({ action: 'upsert', id: 'lamp', expected_version: firstLamp.version, patch: { position: '右侧' } })
  await store.object({ action: 'upsert', id: 'cup', patch: { name: '茶杯', position: '桌上' } })
  const snapshots = await store.history({ object_id: 'lamp' })
  let old
  for (const item of snapshots.history) {
    const value = JSON.parse(await readFile(join(store.historyDir, item.history_id), 'utf8'))
    if (value.objects?.lamp?.position === '左侧') { old = item.history_id; break }
  }
  assert.ok(old)
  const restored = await store.history({ action: 'restore', object_id: 'lamp', history_id: old, expected_version: moved.version })
  assert.equal(restored.verified, true)
  assert.equal(restored.object.position, '左侧')
  assert.equal((await store.object({ action: 'read', id: 'cup' })).object.position, '桌上')
  assert.ok((await store.history({ object_id: 'lamp' })).history.length > snapshots.history.length)
  assert.equal((await store.history({ action: 'restore', object_id: 'cup', history_id: old, expected_version: '1' })).ok, false)
})

test('old draft activities cannot overwrite newer foreground edits', async (t) => {
  const store = await setup(t)
  const draft = await store.space({ action: 'write', path: 'drafts/a.md', content: '初稿' })
  await store.activity({ action: 'plan', id: 'old', title: '续写', path: draft.path, content: '过时续写', expected_version: draft.version })
  await store.space({ action: 'write', path: draft.path, content: '主人刚改的' })
  const result = await store.activity({ action: 'run', id: 'old' })
  assert.equal(result.ok, false)
  assert.equal((await store.space({ action: 'read', path: draft.path })).content, '主人刚改的')
})
