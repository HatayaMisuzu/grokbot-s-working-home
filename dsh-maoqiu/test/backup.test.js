import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import MaoqiuStore from '../lib/store.js'
import { backupSpace, commitStaging, restoreSpace } from '../lib/backup.js'

async function spaceFixture(prefix = 'maoqiu-backup-') {
  const parent = await mkdtemp(join(tmpdir(), prefix))
  const home = join(parent, 'home')
  const store = new MaoqiuStore(home)
  assert.equal((await store.init()).ok, true)
  return { parent, home, store }
}

test('backup and restore preserve all space bytes including history, sidecars and malformed JSON', async () => {
  const source = await spaceFixture()
  const restored = join(source.parent, 'restored')
  const backup = join(source.parent, 'backup')
  try {
    await source.store.experience({ action: 'save', id: 'one', title: '一条经验', content: '原文', scope: 'backup', source: { kind: 'user', ref: 'test' } })
    await source.store.space({ action: 'write', path: 'notes/plain.txt', content: '纯文本\n', title: '纯文本', source: { kind: 'creation', ref: 'test' } })
    await source.store.space({ action: 'write', path: 'notes/plain.txt', content: '覆盖后的纯文本\n', title: '纯文本', source: { kind: 'creation', ref: 'test' } })
    await writeFile(join(source.home, 'space', 'active_interests.json'), '{ broken json\n', 'utf8')
    const result = await backupSpace(source.home, backup)
    assert.equal(result.ok, true)
    const restore = await restoreSpace(restored, backup)
    assert.equal(restore.ok, true)
    assert.equal(await readFile(join(restored, 'space', 'active_interests.json'), 'utf8'), '{ broken json\n')
    assert.equal(await readFile(join(restored, 'space', 'notes', 'plain.txt'), 'utf8'), '覆盖后的纯文本\n')
    assert.ok((await readdir(join(restored, '.history'))).length >= 1)
    assert.ok((await readdir(join(restored, 'space', '.metadata'))).length >= 1)
  } finally {
    await rm(source.parent, { recursive: true, force: true })
  }
})

test('backup and restore preserve a space when one status JSON is missing', async () => {
  const source = await spaceFixture()
  const restored = join(source.parent, 'restored-missing-status')
  const backup = join(source.parent, 'backup-missing-status')
  const missing = join(source.home, 'space', 'active_interests.json')
  try {
    await rm(missing)
    const result = await backupSpace(source.home, backup)
    assert.equal(result.ok, true)
    assert.equal((await restoreSpace(restored, backup)).ok, true)
    await assert.rejects(() => readFile(join(restored, 'space', 'active_interests.json')), { code: 'ENOENT' })
    assert.equal(await readFile(join(restored, 'space', 'scene.json'), 'utf8'), await readFile(join(source.home, 'space', 'scene.json'), 'utf8'))
  } finally {
    await rm(source.parent, { recursive: true, force: true })
  }
})

test('backup accepts an existing empty destination but restore never overwrites non-empty space', async () => {
  const source = await spaceFixture()
  const backup = join(source.parent, 'backup')
  const target = join(source.parent, 'target')
  try {
    await (await import('node:fs/promises')).mkdir(backup)
    assert.equal((await backupSpace(source.home, backup)).ok, true)
    const occupied = await spaceFixture('maoqiu-occupied-')
    try {
      const result = await restoreSpace(occupied.home, backup)
      assert.equal(result.ok, false)
      assert.match(result.error, /不会覆盖|非空/)
    } finally {
      await rm(occupied.parent, { recursive: true, force: true })
    }
    const result = await restoreSpace(target, backup)
    assert.equal(result.ok, true)
  } finally {
    await rm(source.parent, { recursive: true, force: true })
  }
})

test('backup and restore reject intersecting paths, invalid roots and symlink trees', async (t) => {
  const source = await spaceFixture()
  try {
    assert.equal((await backupSpace(source.home, source.home)).ok, false)
    assert.equal((await backupSpace(source.home, join(source.home, 'backup'))).ok, false)
    assert.equal((await restoreSpace(source.home, source.home)).ok, false)
    const invalid = join(source.parent, 'invalid')
    await (await import('node:fs/promises')).mkdir(invalid)
    assert.equal((await backupSpace(invalid, join(source.parent, 'bad-backup'))).ok, false)
    try {
      await symlink(source.home, join(source.parent, 'linked-home'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip(`symlink unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const linked = await backupSpace(join(source.parent, 'linked-home'), join(source.parent, 'linked-backup'))
    assert.equal(linked.ok, false)
    assert.match(linked.error, /符号链接|junction/)
  } finally {
    await rm(source.parent, { recursive: true, force: true })
  }
})

test('staging rename failure never removes an existing destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-commit-'))
  const target = join(root, 'target')
  const staging = join(root, 'staging')
  try {
    const fs = await import('node:fs/promises')
    await fs.mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'keep me', 'utf8')
    await fs.mkdir(staging)
    await assert.rejects(() => commitStaging(staging, target, false))
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep me')
    assert.equal((await readdir(root)).includes('staging'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed install with an empty displaced destination restores it without recursive deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-rollback-'))
  const target = join(root, 'target')
  const missingStaging = join(root, 'missing-staging')
  try {
    const fs = await import('node:fs/promises')
    await fs.mkdir(target)
    await assert.rejects(() => commitStaging(missingStaging, target, true))
    const targetInfo = await fs.lstat(target)
    assert.equal(targetInfo.isDirectory(), true)
    assert.deepEqual(await readdir(target), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
