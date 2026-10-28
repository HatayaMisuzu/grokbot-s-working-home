import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import MaoqiuStore from '../lib/store.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-store-'))
  const store = new MaoqiuStore(root)
  assert.equal((await store.init()).ok, true)
  return { root, store }
}

test('initializes without inventing diary or interests', async () => {
  const { root, store } = await fixture()
  try {
    assert.deepEqual((await store.interest({ action: 'list' })).interests, [])
    assert.deepEqual((await store.space({ action: 'list' })).files, [])
    assert.equal((await store.status()).active_interests, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('experience save, scoped recall and withdraw', async () => {
  const { root, store } = await fixture()
  try {
    const saved = await store.experience({
      action: 'save',
      id: 'task-scope',
      title: '测试项目的经验',
      content: '先看真实运行结果再改代码。',
      scope: '测试项目',
      keywords: ['DSH', '测试'],
      source: { kind: 'user', ref: 'test' },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.experience.status, 'candidate')
    assert.equal((await store.recall({ query: '测试项目', mode: 'work' })).experiences.length, 1)
    assert.equal((await store.recall({ query: '完全无关的天气', mode: 'work' })).experiences.length, 0)
    assert.equal((await store.experience({ action: 'withdraw', id: 'task-scope' })).experience.status, 'withdrawn')
    assert.equal((await store.recall({ query: '测试项目', mode: 'work' })).experiences.length, 0)
    const raw = await readFile(join(root, 'evolution', 'experiences', 'task-scope.md'), 'utf8')
    assert.match(raw, /"status":"withdrawn"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interests, space markdown and scene are persistent across store instances', async () => {
  const { root, store } = await fixture()
  try {
    const interest = await store.interest({ action: 'save', id: 'rain', title: '雨天窗边', reason: '想试试', kind: 'interest' })
    assert.equal(interest.ok, true)
    const written = await store.space({ action: 'write', path: 'drafts/rain.md', title: '雨天草稿', content: '窗边有一点雨声。', source: { kind: 'creation', ref: 'test' } })
    assert.equal(written.ok, true)
    assert.equal((await store.space({ action: 'read', path: 'drafts/rain.md' })).content, '窗边有一点雨声。')
    assert.equal((await store.space({ action: 'scene', scene: { weather: 'rainy' } })).scene.weather, 'rainy')
    const next = new MaoqiuStore(root)
    assert.equal((await next.interest({ action: 'read', id: 'rain' })).interest.title, '雨天窗边')
    assert.equal((await next.space({ action: 'scene' })).scene.weather, 'rainy')
    assert.equal((await next.recall({ query: '雨天', mode: 'chat' })).interests.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('planned activities only persist intent and run records verified result', async () => {
  const { root, store } = await fixture()
  try {
    await store.interest({ action: 'save', id: 'rain', title: '雨天窗边', reason: '接续草稿' })
    const planned = await store.activity({
      action: 'plan',
      id: 'draft-rain',
      interest_id: 'rain',
      title: '保存草稿',
      operation: 'draft',
      path: 'drafts/rain.md',
      content: '草稿内容',
    })
    assert.equal(planned.activity.status, 'planned')
    assert.deepEqual(JSON.parse(JSON.stringify(planned)), planned, 'DSH tools require lossless JSON output')
    assert.deepEqual((await store.space({ action: 'list' })).files, [])
    const ran = await store.activity({ action: 'run', id: 'draft-rain' })
    assert.equal(ran.ok, true)
    assert.equal(ran.activity.status, 'completed')
    assert.equal(ran.activity.result.verified, true)
    const repeated = await store.activity({ action: 'run', id: 'draft-rain' })
    assert.equal(repeated.ok, true)
    assert.equal(repeated.idempotent, true)
    const pausedPlan = await store.activity({ action: 'plan', title: '稍后', operation: 'scene', scene: { light: 'soft' } })
    assert.deepEqual(JSON.parse(JSON.stringify(pausedPlan)), pausedPlan)
    assert.equal((await store.activity({ action: 'pause', id: pausedPlan.activity.id })).activity.status, 'paused')
    assert.equal((await store.activity({ action: 'run', id: pausedPlan.activity.id })).ok, false)
    assert.equal((await store.activity({ action: 'resume', id: pausedPlan.activity.id })).activity.status, 'planned')
    assert.equal((await store.activity({ action: 'cancel', id: pausedPlan.activity.id })).activity.status, 'cancelled')
    assert.equal((await store.activity({ action: 'run', id: pausedPlan.activity.id })).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing root pauses writes instead of creating a second space', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'maoqiu-parent-')), 'missing')
  const store = new MaoqiuStore(root)
  try {
    const result = await store.experience({ action: 'save', title: '不应写入', content: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.paused, true)
    assert.equal((await store.status()).paused, true)
  } finally {
    await rm(join(root, '..'), { recursive: true, force: true })
  }
})

test('experience saves require scope and a source reference without inventing user provenance', async () => {
  const { root, store } = await fixture()
  try {
    const noScope = await store.experience({ action: 'save', title: '无范围', content: 'x', source: { kind: 'user', ref: 'test' } })
    assert.equal(noScope.ok, false)
    assert.match(noScope.error, /scope/)
    const noSource = await store.experience({ action: 'save', title: '无来源', content: 'x', scope: 'test' })
    assert.equal(noSource.ok, false)
    assert.match(noSource.error, /source\.ref/)
    const interest = await store.interest({ action: 'save', title: '未指定来源' })
    assert.equal(interest.interest.source.kind, 'inference')
    const note = await store.space({ action: 'write', path: 'notes/source.md', content: 'x' })
    assert.equal(note.metadata.source.kind, 'creation')
    assert.notEqual(note.metadata.source.kind, 'user')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('markdown bodies keep whitespace and recall returns only an experience excerpt', async () => {
  const { root, store } = await fixture()
  try {
    const body = '  leading\n正文  \n\n'
    const saved = await store.space({ action: 'write', path: 'drafts/whitespace.md', content: body })
    assert.equal(saved.content, body)
    assert.equal((await store.space({ action: 'read', path: 'drafts/whitespace.md' })).content, body)
    const long = '关键词 ' + '正文'.repeat(400)
    await store.experience({ action: 'save', id: 'excerpt', title: '摘要', content: long, scope: '关键词', source: { kind: 'inference', ref: 'test' } })
    const recalled = (await store.recall({ query: '关键词' })).experiences[0]
    assert.equal('content' in recalled, false)
    assert.ok(recalled.excerpt.length <= 601)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('work recall keeps commitments relevant and does not duplicate them as interests', async () => {
  const { root, store } = await fixture()
  try {
    await store.interest({ action: 'save', id: 'unrelated-commitment', title: '无关承诺', kind: 'commitment' })
    await store.interest({ action: 'save', id: 'relevant-commitment', title: 'DSH 承诺', kind: 'commitment' })
    await store.interest({ action: 'save', id: 'relevant-interest', title: 'DSH 兴趣', kind: 'interest' })
    const recalled = await store.recall({ query: 'DSH', mode: 'work' })
    assert.deepEqual(recalled.commitments.map((x) => x.id), ['relevant-commitment'])
    assert.deepEqual(recalled.interests.map((x) => x.id), ['relevant-interest'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skip can record a non-persisted decision and draft activities stay under drafts', async () => {
  const { root, store } = await fixture()
  try {
    const before = await readFile(join(root, 'space', 'activities.json'), 'utf8')
    const skipped = await store.activity({ action: 'skip', summary: '目前没有合适的动作' })
    assert.equal(skipped.ok, true)
    assert.equal(skipped.persisted, false)
    assert.equal(await readFile(join(root, 'space', 'activities.json'), 'utf8'), before)
    const invalid = await store.activity({ action: 'plan', id: 'notes-plan', title: '错误目录', operation: 'draft', path: 'notes/no.md', content: 'x' })
    assert.equal(invalid.ok, false)
    assert.match(invalid.error, /drafts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent writes, manual edits, archive status changes, migration and offline pause survive reload', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'maoqiu-lifecycle-'))
  const root = join(parent, 'space-a')
  const moved = join(parent, 'space-b')
  const store = new MaoqiuStore(root)
  await store.init()
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => store.experience({
      action: 'save', id: `concurrent-${index}`, title: `并发 ${index}`, content: 'x', scope: 'concurrency', source: { kind: 'tool', ref: `test-${index}` },
    })))
    assert.equal(results.filter((x) => x.ok).length, 8)
    await writeFile(join(root, 'space', 'notes', 'manual.md'), '  手动编辑\n', 'utf8')
    await store.interest({ action: 'save', id: 'archive-me', title: '可恢复', kind: 'interest' })
    assert.equal((await store.interest({ action: 'update', id: 'archive-me', status: 'archived' })).interest.status, 'archived')
    assert.equal((await store.interest({ action: 'update', id: 'archive-me', status: 'active' })).interest.status, 'active')
    await rename(root, moved)
    const reloaded = new MaoqiuStore(moved)
    assert.equal((await reloaded.space({ action: 'read', path: 'notes/manual.md' })).content, '  手动编辑\n')
    assert.equal((await reloaded.status()).experiences, 8)
    await rm(moved, { recursive: true, force: true })
    const paused = await reloaded.space({ action: 'write', path: 'notes/offline.md', content: 'x' })
    assert.equal(paused.ok, false)
    assert.equal(paused.paused, true)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('space and fixed JSON paths reject symlinked parents when the platform permits links', async (t) => {
  const { root, store } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'maoqiu-outside-'))
  try {
    try {
      await symlink(outside, join(root, 'space', 'notes', 'outside-link'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip(`symlink unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const escaped = await store.space({ action: 'read', path: 'notes/outside-link/secret.md' })
    assert.equal(escaped.ok, false)
    await writeFile(join(outside, 'interests.json'), '[]\n', 'utf8')
    await rm(join(root, 'space', 'active_interests.json'))
    try {
      await symlink(join(outside, 'interests.json'), join(root, 'space', 'active_interests.json'), 'file')
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip(`file symlink unavailable: ${error.code}`)
        return
      }
      throw error
    }
    assert.equal((await store.interest({ action: 'list' })).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
