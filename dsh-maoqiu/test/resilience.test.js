import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MaoqiuStore } from '../lib/store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-resilience-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new MaoqiuStore(root)
  assert.equal((await store.init()).ok, true)
  return { root, store }
}

test('malformed and wrong-type state stays intact while healthy blocks remain readable', async (t) => {
  const { root, store } = await fixture(t)
  await store.space({ action: 'write', path: 'notes/lighthouse.md', content: '灯塔研究与海岸观察。' })
  const broken = '{ invalid json'
  await writeFile(store.interestsFile, broken)
  await writeFile(store.activitiesFile, '{}')
  const status = await store.status()
  assert.equal(status.ok, true)
  assert.equal(status.space_files, 1)
  assert.equal(status.warnings.length, 2)
  assert.ok(status.warnings.every((x) => !x.path.includes(root)))
  assert.equal((await store.interest({ action: 'list' })).ok, true)
  assert.equal((await store.activity({ action: 'list' })).activities.length, 0)
  assert.equal((await store.interest({ action: 'save', title: '不应覆盖坏数据' })).ok, false)
  assert.equal((await store.activity({ action: 'plan', title: '不应覆盖', operation: 'scene', scene: {} })).ok, false)
  assert.equal(await readFile(store.interestsFile, 'utf8'), broken)
  const recalled = await store.recall({ query: '灯塔' })
  assert.equal(recalled.ok, true)
  assert.equal(recalled.materials.length, 1)
  assert.ok(recalled.warnings.length)
})

test('text metadata failures preserve the original body and corrupt headers are not overwritten', async (t) => {
  const { store } = await fixture(t)
  const file = join(store.spaceDir, 'notes', 'original.txt')
  await store.space({ action: 'write', path: 'notes/original.txt', content: 'original', title: 'Original' })
  const oldMeta = await readFile(store._sidecarPath(file), 'utf8')
  const writeSidecar = store._writeSidecar
  store._writeSidecar = async () => { throw new Error('simulated sidecar write failure') }
  const failed = await store.space({ action: 'write', path: 'notes/original.txt', content: 'replacement' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /正文已恢复/)
  assert.equal(await readFile(file, 'utf8'), 'original')
  assert.equal(await readFile(store._sidecarPath(file), 'utf8'), oldMeta)
  store._writeSidecar = writeSidecar
  await writeFile(store._sidecarPath(file), '{ corrupt')
  assert.equal((await store.space({ action: 'write', path: 'notes/original.txt', content: 'replacement' })).ok, false)
  assert.equal(await readFile(file, 'utf8'), 'original')
  await writeFile(join(store.spaceDir, 'notes', 'bad.md'), '<!-- maoqiu-meta\n{bad}\n-->\noriginal')
  assert.equal((await store.space({ action: 'write', path: 'notes/bad.md', content: 'replacement' })).ok, false)
  assert.match(await readFile(join(store.spaceDir, 'notes', 'bad.md'), 'utf8'), /original/)
})

test('activity reports a written output when the final state file cannot be saved', async (t) => {
  const { store } = await fixture(t)
  await store.activity({ action: 'plan', id: 'partial', title: 'Partial', path: 'drafts/partial.md', content: 'Completed output' })
  const writeJson = store._writeJson
  store._writeJson = async function (file, value) {
    if (file === this.activitiesFile) throw new Error('simulated state write failure')
    return writeJson.call(this, file, value)
  }
  const result = await store.activity({ action: 'run', id: 'partial' })
  assert.equal(result.ok, false)
  assert.equal(result.persisted, false)
  assert.equal(result.activity.result.verified, true)
  assert.match(result.error, /产物已完成/)
  store._writeJson = writeJson
  assert.equal((await store.activity({ action: 'read', id: 'partial' })).activity.status, 'planned')
  assert.equal((await store.space({ action: 'read', path: 'drafts/partial.md' })).content, 'Completed output')
  assert.equal((await store.activity({ action: 'run', id: 'partial' })).ok, true)
})

test('init rejects a linked history directory before creating state files', async (t) => {
  const { root, store } = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'maoqiu-init-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await rm(store.historyDir, { recursive: true })
  await rm(store.sceneFile)
  try { await symlink(outside, store.historyDir, 'junction') }
  catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`junction unavailable: ${error.code}`)
    throw error
  }
  assert.equal((await store.init()).ok, false)
  await assert.rejects(readFile(store.sceneFile), { code: 'ENOENT' })
  assert.deepEqual(await readdir(outside), [])
})

test('recall bounds material preview while explicit reads retain the complete file', async (t) => {
  const { store } = await fixture(t)
  const content = `${'a'.repeat(80 * 1024)}\n尾部独特灯塔`
  assert.equal((await store.space({ action: 'write', path: 'notes/large.md', content })).ok, true)
  assert.equal((await store.recall({ query: '尾部独特灯塔' })).materials.length, 0)
  assert.equal((await store.space({ action: 'read', path: 'notes/large.md' })).content, content)
})

test('bad Markdown metadata is visible as a warning and the original file is preserved', async (t) => {
  const { root, store } = await fixture(t)
  const bad = '<!-- maoqiu-meta\n{broken}\n-->\n\n灯塔随笔'
  await writeFile(join(root, 'space/notes/broken.md'), bad)
  await writeFile(join(root, 'evolution/experiences/broken.md'), bad)
  const read = await store.space({ action: 'read', path: 'notes/broken.md' })
  assert.equal(read.ok, true)
  assert.equal(read.content, bad)
  assert.equal(read.warnings.length, 1)
  assert.equal((await store.experience({ action: 'list' })).warnings.length, 1)
  assert.equal((await store.experience({ action: 'read', id: 'broken' })).ok, false)
  assert.equal(await readFile(join(root, 'space/notes/broken.md'), 'utf8'), bad)
})

test('initialization rejects unrelated nonempty directories and writes require a known layout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-uninitialized-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new MaoqiuStore(root)
  assert.equal((await store.space({ action: 'write', path: 'notes/no.md', content: 'x' })).ok, false)
  await writeFile(join(root, 'keep.txt'), 'user data')
  assert.equal((await store.init()).ok, false)
  assert.deepEqual(await readdir(root), ['keep.txt'])
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'user data')
})

test('missing space layout cannot silently masquerade as an empty initialized space', async (t) => {
  const { root, store } = await fixture(t)
  await rm(join(root, 'space'), { recursive: true })
  const status = await store.status()
  assert.equal(status.ok, false)
  assert.equal(status.initialized, false)
  assert.equal((await store.space({ action: 'write', path: 'notes/no.md', content: 'x' })).ok, false)
})

test('scene edits and scene activities preserve existing nested fields', async (t) => {
  const { store } = await fixture(t)
  await store.space({ action: 'scene', scene: { window: { weather: 'rain', light: 'warm' } } })
  const update = await store.space({ action: 'scene', scene: { window: { light: 'soft' } } })
  assert.deepEqual(update.scene.window, { weather: 'rain', light: 'soft' })
  const plan = await store.activity({ action: 'plan', title: '调灯', operation: 'scene', scene: { window: { light: 'dim' } } })
  const run = await store.activity({ action: 'run', id: plan.activity.id })
  assert.equal(run.ok, true)
  assert.deepEqual(run.activity.result.scene.window, { weather: 'rain', light: 'dim' })
})

test('resuming a failed activity clears old results and skipped activities need explicit revision', async (t) => {
  const { root, store } = await fixture(t)
  const plan = await store.activity({ action: 'plan', title: '草稿', operation: 'draft', path: 'drafts/test.md', content: 'draft' })
  await writeFile(join(root, 'space/drafts/test.md'), 'existing')
  await rm(join(root, 'space/drafts'), { recursive: true })
  await writeFile(join(root, 'space/drafts'), 'blocked directory')
  assert.equal((await store.activity({ action: 'run', id: plan.activity.id })).activity.status, 'failed')
  assert.equal((await store.activity({ action: 'pause', id: plan.activity.id })).ok, true)
  const resumed = await store.activity({ action: 'resume', id: plan.activity.id })
  assert.equal(resumed.activity.error, null)
  assert.equal(resumed.activity.result, null)
  assert.equal((await store.activity({ action: 'skip', id: plan.activity.id })).ok, true)
  assert.equal((await store.activity({ action: 'pause', id: plan.activity.id })).ok, false)
  assert.equal((await store.activity({ action: 'run', id: plan.activity.id })).ok, false)
})

test('completed activities recheck their outputs without silently recreating deleted drafts', async (t) => {
  const { root, store } = await fixture(t)
  const plan = await store.activity({ action: 'plan', title: '真实产物', operation: 'draft', path: 'drafts/real.md', content: 'saved' })
  assert.equal((await store.activity({ action: 'run', id: plan.activity.id })).ok, true)
  await rm(join(root, 'space/drafts/real.md'))
  const rerun = await store.activity({ action: 'run', id: plan.activity.id })
  assert.equal(rerun.ok, false)
  assert.equal(rerun.activity.result.verified, false)
  assert.deepEqual(await readdir(join(root, 'space/drafts')), [])
})

test('activity progress links only valid interests and append preserves old text and history', async (t) => {
  const { root, store } = await fixture(t)
  const invalid = await store.activity({ action: 'plan', title: '悬空关联', operation: 'scene', scene: {}, interest_id: 'missing' })
  assert.equal(invalid.ok, false)
  await store.interest({ action: 'save', id: 'writing', title: '写作' })
  const plan = await store.activity({ action: 'plan', title: '写片段', operation: 'draft', path: 'drafts/fragment.txt', content: '  first\n', interest_id: 'writing' })
  assert.equal((await store.activity({ action: 'run', id: plan.activity.id })).ok, true)
  const interest = (await store.interest({ action: 'read', id: 'writing' })).interest
  assert.equal(interest.last_activity_id, plan.activity.id)
  assert.match(interest.progress, /写片段/)
  const appended = await store.space({ action: 'append', path: 'drafts/fragment.txt', content: 'second  \n' })
  assert.equal(appended.content, '  first\nsecond  \n')
  assert.ok((await readdir(join(root, '.history'))).length)
})

test('space paths reject traversal, absolute paths and ambiguous Windows suffixes', async (t) => {
  const { store } = await fixture(t)
  for (const path of ['../outside.md', 'notes/../outside.md', 'notes//empty.md', 'C:/secret.md', '//server/share.md', 'other/test.md', 'notes/test.exe', 'notes/folder./test.md', 'notes/folder /test.md']) {
    assert.equal((await store.space({ action: 'write', path, content: 'x' })).ok, false, path)
  }
  assert.equal((await store.space({ action: 'write', path: 'Notes/normal.md', content: 'ok' })).ok, true)
})
