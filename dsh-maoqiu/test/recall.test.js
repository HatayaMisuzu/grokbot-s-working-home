import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaoqiuStore } from '../lib/store.js'
import { recallFromStore, scoreText } from '../lib/recall.js'
import { summarizeRecall } from '../lib/context.js'

function fakeStore({ experiences = [], files = [], interests = [], activities = [], badFiles = [], badActivities = false } = {}) {
  const store = {
    home: 'C:/maoqiu-test',
    spaceDir: 'C:/maoqiu-test/space',
    interestsFile: 'C:/maoqiu-test/space/active_interests.json',
    activitiesFile: 'C:/maoqiu-test/space/activities.json',
    experiences,
    files,
    interests,
    activities,
    badFiles: new Set(badFiles),
    badActivities,
    recordScans: 0,
    fileScans: 0,
    async _experienceRecords() {
      this.recordScans += 1
      return this.experiences
    },
    async _spaceFiles() {
      this.fileScans += 1
      return this.files
    },
    async _readSpaceParsed(file) {
      const path = String(file).split(/[\\/]/).pop()
      if (this.badFiles.has(path)) throw new Error('损坏的材料')
      const entry = this.files.find((item) => item.path.endsWith(path))
      return entry?.parsed || { content: '', meta: null }
    },
    async _readJson(file) {
      const name = String(file).split(/[\\/]/).pop()
      if (name === 'activities.json') {
        if (this.badActivities) throw new Error('活动文件损坏')
        return this.activities
      }
      return this.interests
    },
    _publicExperience(record) {
      return { ...record.meta, excerpt: String(record.content || '').slice(0, 600) }
    },
    _publicInterest(item) {
      return { ...item, materials: Array.isArray(item.materials) ? item.materials.slice(0, 3) : [] }
    },
    _excerpt(value, max = 600) {
      const text = String(value || '').trim().replace(/\s+/g, ' ')
      return text.length > max ? `${text.slice(0, max)}…` : text
    },
  }
  return store
}

function experience(id, title, content, project, updated_at, extra = {}) {
  return { meta: { id, title, scope: project, project, keywords: [], status: 'candidate', updated_at, ...extra }, content }
}

test('matches experience title and body without keywords and enforces strict scope', async () => {
  const store = fakeStore({
    experiences: [
      experience('inside', '蓝灯笼计划', '先看真实结果再继续。', 'C:/work/project-a', '2026-10-24T02:00:00Z'),
      experience('outside', '蓝灯笼计划', '另一个项目的记录。', 'C:/work/project-b', '2026-10-24T03:00:00Z'),
    ],
  })
  const byTitle = await recallFromStore(store, { query: '蓝灯笼', scope: 'C:/work/project-a' })
  assert.deepEqual(byTitle.experiences.map((item) => item.id), ['inside'])
  const byBody = await recallFromStore(store, { query: '真实结果', scope: 'C:/work/project-a' })
  assert.deepEqual(byBody.experiences.map((item) => item.id), ['inside'])
  const unrestricted = await recallFromStore(store, { query: '蓝灯笼', limit: 10 })
  assert.deepEqual(unrestricted.experiences.map((item) => item.id), ['outside', 'inside'])
})

test('reduces generic CJK noise while retaining two meaningful bigram matches', async () => {
  const store = fakeStore({
    experiences: [
      experience('useful', '蓝灯笼', '蓝灯笼需要持续观察。', 'project', '2026-10-24T00:00:00Z'),
      experience('noise', '普通记录', '今天有点事情需要继续。', 'project', '2026-10-24T01:00:00Z'),
    ],
  })
  const useful = await recallFromStore(store, { query: '蓝灯笼相关工作' })
  assert.deepEqual(useful.experiences.map((item) => item.id), ['useful'])
  const noise = await recallFromStore(store, { query: '今天有点需要' })
  assert.equal(noise.experiences.length, 0)
})

test('caps limit at ten and uses newest updated_at first for ties', async () => {
  const store = fakeStore({
    experiences: Array.from({ length: 12 }, (_, index) => experience(
      `e-${index}`, '同一主题', `正文 ${index}`, 'project', `2026-10-24T${String(index).padStart(2, '0')}:00:00Z`,
    )),
  })
  const result = await recallFromStore(store, { query: '同一主题', limit: 99 })
  assert.equal(result.experiences.length, 10)
  assert.equal(result.experiences[0].id, 'e-11')
  assert.equal(result.experiences.at(-1).id, 'e-2')
})

test('loose scope keeps a cross-scope hit explicitly marked', async () => {
  const store = fakeStore({ experiences: [experience('other', '蓝灯笼', '记录', 'C:/work/other', '2026-10-24T00:00:00Z')] })
  const strict = await recallFromStore(store, { query: '蓝灯笼', scope: 'C:/work/current' })
  assert.equal(strict.experiences.length, 0)
  const loose = await recallFromStore(store, { query: '蓝灯笼', scope: 'C:/work/current', scope_mode: 'loose' })
  assert.equal(loose.experiences.length, 1)
  assert.equal(loose.experiences[0].cross_scope, true)
})

test('one damaged material becomes a warning while other materials remain searchable', async () => {
  const store = fakeStore({
    files: [
      { path: 'notes/good.md', size: 20, updated_at: '2026-10-24T02:00:00Z', parsed: { content: '蓝灯笼的好记录', meta: { title: '好记录' } } },
      { path: 'notes/bad.md', size: 20, updated_at: '2026-10-24T03:00:00Z', parsed: { content: '蓝灯笼的坏记录', meta: { title: '坏记录' } } },
    ],
    badFiles: ['bad.md'],
  })
  const result = await recallFromStore(store, { query: '蓝灯笼' })
  assert.deepEqual(result.materials.map((item) => item.path), ['notes/good.md'])
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].path, 'notes/bad.md')
  assert.doesNotMatch(result.warnings[0].message, /C:\//)
})

test('chat mode rotates active interests in memory and separates commitments', async () => {
  const store = fakeStore({
    interests: [
      { id: 'i1', title: '雨天', status: 'active', kind: 'interest', materials: ['a', 'b', 'c', 'd'], updated_at: '2026-10-24T01:00:00Z' },
      { id: 'i2', title: '书', status: 'active', kind: 'interest', updated_at: '2026-10-24T02:00:00Z' },
      { id: 'i3', title: '歌', status: 'active', kind: 'interest', updated_at: '2026-10-24T03:00:00Z' },
      { id: 'i4', title: '电影', status: 'active', kind: 'interest', updated_at: '2026-10-24T04:00:00Z' },
      { id: 'i5', title: '散步', status: 'active', kind: 'interest', updated_at: '2026-10-24T05:00:00Z' },
      { id: 'i6', title: '咖啡', status: 'active', kind: 'interest', updated_at: '2026-10-24T06:00:00Z' },
      { id: 'c1', title: '承诺', status: 'active', kind: 'commitment', updated_at: '2026-10-24T04:00:00Z' },
    ],
  })
  const first = await recallFromStore(store, { query: '', mode: 'chat', limit: 3 })
  const second = await recallFromStore(store, { query: '', mode: 'chat', limit: 3 })
  assert.deepEqual(new Set([...first.interests, ...second.interests].map((item) => item.id)), new Set(['i1', 'i2', 'i3', 'i4', 'i5', 'i6']))
  assert.deepEqual(first.commitments.map((item) => item.id), ['c1'])
  assert.deepEqual(second.interests.find((item) => item.id === 'i1').materials, ['a', 'b', 'c'])
  const unrelated = await recallFromStore(store, { query: '完全不相关的查询', mode: 'chat', limit: 3 })
  assert.equal(unrelated.interests.length, 0)
  assert.equal((await recallFromStore(store, { query: '近况', mode: 'chat', include_recent: true })).interests.length, 3)
})

test('query is bounded and pure score helper exposes meaningful matches', async () => {
  const store = fakeStore({ experiences: [experience('one', '蓝灯笼', '记录', 'project', '2026-10-24T00:00:00Z')] })
  const longQuery = '蓝灯笼'.repeat(500)
  const result = await recallFromStore(store, { query: longQuery, limit: 99 })
  await recallFromStore(store, { query: longQuery, limit: 99 })
  assert.equal(result.query.length, 1000)
  assert.deepEqual(result.experiences.map((item) => item.id), ['one'])
  assert.equal(store.recordScans, 2)
  assert.deepEqual(scoreText('蓝灯笼相关工作', ['蓝灯笼需要持续观察']).matched, ['蓝灯', '灯笼'])
})

test('real MaoqiuStore keeps unscoped notes and isolates bad JSON and sidecars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-recall-real-'))
  try {
    const store = new MaoqiuStore(root)
    assert.equal((await store.init()).ok, true)
    const projectA = join(root, 'workspace', 'project-a')
    const projectB = join(root, 'workspace', 'project-b')
    await store.experience({
      action: 'save', id: 'inside', title: '蓝灯笼项目', content: '正文包含真实结果。',
      scope: '项目A', project: projectA, source: { kind: 'user', ref: 'test' },
    })
    await store.experience({
      action: 'save', id: 'outside', title: '蓝灯笼项目', content: '另一个项目正文。',
      scope: '项目B', project: projectB, source: { kind: 'user', ref: 'test' },
    })
    await store.space({ action: 'write', path: 'notes/good.md', title: '蓝灯笼笔记', content: '普通 notes 没有 project 元数据。' })
    await store.space({ action: 'write', path: 'notes/bad.txt', title: '蓝灯笼损坏 sidecar', content: '这条应被隔离。' })
    await writeFile(store.interestsFile, '{ broken json\n', 'utf8')
    const badSidecar = store._sidecarPath(join(store.spaceDir, 'notes', 'bad.txt'))
    await writeFile(badSidecar, '{ broken sidecar\n', 'utf8')

    const result = await store.recall({ query: '蓝灯笼', scope: [projectB, projectA], limit: 10 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.experiences.map((item) => item.id), ['outside', 'inside'])
    assert.deepEqual(result.materials.map((item) => item.path), ['notes/good.md'])
    assert.ok(result.warnings.some((item) => item.path === 'space/active_interests.json'))
    assert.ok(result.warnings.some((item) => item.path === 'notes/bad.txt'))
    assert.ok(result.warnings.every((item) => !/[A-Za-z]:[\\/]/.test(item.message)))
    const byTextScope = await store.recall({ query: '蓝灯笼', scope: '项目A' })
    assert.deepEqual(byTextScope.experiences.map((item) => item.id), ['inside'])
    const unrelatedScope = await store.recall({ query: '项目A蓝灯笼', scope: '其他项目' })
    assert.equal(unrelatedScope.experiences.length, 0, '查询正文不能覆盖显式的范围边界')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('chat requires opt-in for recent materials while visits include them and work stays query-only', async () => {
  const store = fakeStore({
    files: [
      { path: 'drafts/old.md', size: 10, updated_at: '2026-10-20T10:00:00Z', parsed: { content: '旧草稿正文', meta: { title: '旧草稿' } } },
      { path: 'notes/new.md', size: 10, updated_at: '2026-10-24T10:00:00Z', parsed: { content: '新笔记正文', meta: { title: '新笔记' } } },
      { path: 'drafts/mid.txt', size: 10, updated_at: '2026-10-22T10:00:00Z', parsed: { content: '中间草稿', meta: { title: '中间草稿' } } },
      { path: 'collections/latest.md', size: 10, updated_at: '2026-10-25T01:00:00Z', parsed: { content: '最新收集', meta: null } },
    ],
  })
  assert.deepEqual((await recallFromStore(store, { query: '', mode: 'chat' })).recent, [])
  const chat = await recallFromStore(store, { query: '', mode: 'chat', include_recent: true, limit: 2 })
  assert.deepEqual(chat.recent.map((item) => item.path), ['collections/latest.md', 'notes/new.md'])
  assert.equal(chat.recent[0].category, 'collections')
  assert.equal(chat.recent[0].title, 'latest')
  assert.ok(chat.recent.every((item) => item.excerpt.length <= 240))
  const work = await recallFromStore(store, { query: '新笔记' })
  assert.equal(work.mode, 'work')
  assert.deepEqual(work.recent, [])
  assert.deepEqual(work.activities, [])
})

test('recent materials do not repeat query-matched materials', async () => {
  const store = fakeStore({
    files: [
      { path: 'notes/blue.md', size: 10, updated_at: '2026-10-25T02:00:00Z', parsed: { content: '蓝灯笼计划笔记', meta: { title: '蓝灯笼' } } },
      { path: 'drafts/other.md', size: 10, updated_at: '2026-10-24T02:00:00Z', parsed: { content: '别的草稿', meta: { title: '别的' } } },
    ],
  })
  const result = await recallFromStore(store, { query: '蓝灯笼', mode: 'visit' })
  assert.deepEqual(result.materials.map((item) => item.path), ['notes/blue.md'])
  assert.deepEqual(result.recent.map((item) => item.path), ['drafts/other.md'])
})

test('one damaged recent material becomes a warning while others remain', async () => {
  const store = fakeStore({
    files: [
      { path: 'drafts/bad.md', size: 10, updated_at: '2026-10-25T02:00:00Z', parsed: { content: '坏' } },
      { path: 'drafts/good.md', size: 10, updated_at: '2026-10-24T02:00:00Z', parsed: { content: '好' } },
    ],
    badFiles: ['bad.md'],
  })
  const result = await recallFromStore(store, { query: '', mode: 'visit' })
  assert.deepEqual(result.recent.map((item) => item.path), ['drafts/good.md'])
  assert.ok(result.warnings.some((item) => item.path === 'drafts/bad.md'))
})

test('activity mode surfaces unfinished activities only', async () => {
  const store = fakeStore({
    activities: [
      { id: 'a-old', title: '旧计划', status: 'planned', summary: '写一段', updated_at: '2026-10-20T00:00:00Z' },
      { id: 'a-new', title: '新计划', status: 'paused', updated_at: '2026-10-24T00:00:00Z' },
      { id: 'a-fail', title: '失败', status: 'failed', updated_at: '2026-10-23T00:00:00Z' },
      { id: 'a-done', title: '完成', status: 'completed', updated_at: '2026-10-25T00:00:00Z' },
      { id: 'a-cancel', title: '取消', status: 'cancelled', updated_at: '2026-10-25T01:00:00Z' },
      { id: 'a-skip', title: '跳过', status: 'skipped', updated_at: '2026-10-25T02:00:00Z' },
    ],
  })
  const result = await recallFromStore(store, { query: '', mode: 'activity', limit: 2 })
  assert.deepEqual(result.activities.map((item) => item.id), ['a-new', 'a-fail'])
  assert.equal(result.activities[0].status, 'paused')
  const chat = await recallFromStore(store, { query: '', mode: 'chat' })
  assert.deepEqual(chat.activities, [])
})

test('recall summary renders recent materials, pending activities and dates', () => {
  const text = summarizeRecall({
    ok: true,
    experiences: [{ id: 'e1', title: '经验一', status: 'candidate', updated_at: '2026-10-24T08:00:00Z', excerpt: '正文' }],
    materials: [{ path: 'notes/a.md', updated_at: '2026-10-23T08:00:00Z', excerpt: '材料正文' }],
    recent: [{ path: 'drafts/b.md', title: '两篇草稿', updated_at: '2026-10-25T08:00:00Z', excerpt: '草稿正文' }],
    activities: [{ id: 'a1', status: 'planned', title: '写一段', updated_at: '2026-10-22T08:00:00Z' }],
    interests: [],
    commitments: [],
    warnings: [],
  })
  assert.match(text, /最近材料 drafts\/b\.md/)
  assert.match(text, /待办活动 id=a1 \[planned\]/)
  assert.match(text, /（更新 10-\d\d）/)
  assert.ok(text.length <= 1200)
  const empty = summarizeRecall({ ok: true, experiences: [], materials: [], recent: [], activities: [], interests: [], commitments: [], warnings: [] })
  assert.equal(empty, '')
  const long = summarizeRecall({
    ok: true,
    experiences: [],
    materials: [],
    recent: Array.from({ length: 3 }, (_, index) => ({ path: `drafts/x${index}.md`, updated_at: '2026-10-25T00:00:00Z', excerpt: '长'.repeat(500) })),
    activities: [{ id: 'a2', status: 'planned', title: '长'.repeat(300), updated_at: '2026-10-25T00:00:00Z' }],
    interests: [],
    commitments: [],
    warnings: [],
  })
  assert.ok(long.length <= 1200, 'summary respects the context cap')
})
