import { randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { recallFromStore } from './recall.js'
import { objects, history, fileVersion, expectVersion } from './space-items.js'
import { appendJournal, verifyJournal, JOURNAL_FILE } from './journal.js'
import { CORNER_IDS, cornerList, isPrivate, normalizeCorner, normalizeVisibility } from './home-view.js'

/**
 * Small file backed store for the Maoqiu DSH bundle.
 *
 * Explicit reads see current files. Automatic recall is bounded and cached by
 * the adapter for one turn; successful writes invalidate that cached result.
 */
export const PRIVACY_MARKERS = Object.freeze({
  '.gitignore': '# 毛球个人空间：不要提交到任何仓库\n*\n',
  '.nobackup': '毛球个人空间：请备份工具排除本目录（如 restic/borg --exclude-if-present .nobackup）。\n需要备份时使用 node bin/maoqiu.js backup 显式导出。\n',
})

export class MaoqiuStore {
  static locks = new Map()

  constructor(home) {
    if (typeof home !== 'string' || !home.trim()) throw new TypeError('home must be a non-empty path')
    this.home = resolve(home)
    this.evolutionDir = join(this.home, 'evolution')
    this.experienceDir = join(this.evolutionDir, 'experiences')
    this.spaceDir = join(this.home, 'space')
    this.historyDir = join(this.home, '.history')
    this.interestsFile = join(this.spaceDir, 'active_interests.json')
    this.sceneFile = join(this.spaceDir, 'scene.json')
    this.activitiesFile = join(this.spaceDir, 'activities.json')
    this.journalFile = join(this.spaceDir, JOURNAL_FILE)
    this.homeFile = join(this.spaceDir, 'home.json')
    this.revision = 0
    this.writeContext = new AsyncLocalStorage()
    this.opContext = new AsyncLocalStorage()
  }

  /**
   * Personal data must not ride along in repositories or generic backups.
   * DSH itself has no backup that reaches this directory (it lives outside
   * DSH_HOME); these markers cover git and marker-aware backup tools. Only
   * writes into an already existing, non-symlinked home; never overwrites.
   */
  async ensurePrivacyMarkers() {
    const root = await this._lstatIfExists(this.home)
    if (!root || root.isSymbolicLink() || !root.isDirectory()) return { ok: false, skipped: true }
    for (const [file, content] of Object.entries(PRIVACY_MARKERS)) await this._writeIfMissing(join(this.home, file), content)
    return { ok: true, files: Object.keys(PRIVACY_MARKERS) }
  }

  async init() {
    try {
      const root = await this._lstatIfExists(this.home)
      if (root?.isSymbolicLink()) return this._failure('空间根目录不能是符号链接或 junction')
      if (root && !root.isDirectory()) return this._failure('home is not a directory')
      if (root && (await readdir(this.home)).length && !(await this._hasLayout())) {
        return this._failure('目标是非空且未识别的目录；请使用空目录初始化，不会覆盖现有文件')
      }
      await mkdir(this.home, { recursive: true })
      for (const directory of [this.experienceDir, this.historyDir, ...['notes', 'drafts', 'collections'].map((x) => join(this.spaceDir, x))]) await this._assertSafePath(directory)
      await mkdir(this.experienceDir, { recursive: true })
      await mkdir(join(this.spaceDir, 'notes'), { recursive: true })
      await mkdir(join(this.spaceDir, 'drafts'), { recursive: true })
      await mkdir(join(this.spaceDir, 'collections'), { recursive: true })
      await mkdir(this.historyDir, { recursive: true })
      await this._writeIfMissing(this.interestsFile, '[]\n')
      await this._writeIfMissing(this.sceneFile, '{}\n')
      await this._writeIfMissing(this.activitiesFile, '[]\n')
      await this.ensurePrivacyMarkers()
      return { ok: true, home: this.home, initialized: true }
    } catch (error) {
      return this._failure(error.message)
    }
  }

  async status() {
    const root = await this._lstatIfExists(this.home)
    if (!root) return { ok: false, paused: true, initialized: false, home: this.home, error: '毛球空间不可用' }
    if (root.isSymbolicLink()) return this._failure('空间根目录不能是符号链接或 junction')
    if (!root.isDirectory()) return this._failure('home is not a directory')
    try {
      if (!(await this._hasLayout())) return this._failure('空间目录不完整或未初始化，请核对路径与备份', { initialized: false, paused: true, home: this.home })
      const warnings = []
      const [experiences, files, interests, activities, scene] = await Promise.all([
        this._experienceRecords(warnings, { preview: true }),
        this._spaceFiles(warnings),
        this._readRecoverable(this.interestsFile, [], warnings),
        this._readRecoverable(this.activitiesFile, [], warnings),
        this._readRecoverable(this.sceneFile, {}, warnings),
      ])
      return {
        ok: true,
        paused: false,
        initialized: true,
        home: this.home,
        experiences: experiences.length,
        space_files: files.length,
        active_interests: interests.filter((x) => x.status === 'active').length,
        activities: activities.length,
        scene_configured: Object.keys(scene).length > 0,
        warnings,
      }
    } catch (error) {
      return this._failure(error.message)
    }
  }

  async experience(args = {}) {
    const action = String(args.action || 'list')
    if (action === 'list') {
      try {
        const warnings = []
        const records = await this._experienceRecords(warnings)
        return { ok: true, experiences: records.map((x) => this._publicExperience(x, false)), warnings }
      } catch (error) {
        return this._failure(error.message)
      }
    }
    if (action === 'read') {
      try {
        const record = await this._findExperience(args.id)
        return record ? { ok: true, experience: this._publicExperience(record, true) } : this._failure('经验不存在')
      } catch (error) {
        return this._failure(error.message)
      }
    }
    return this._mutate(async () => {
      if (action === 'save') {
        const meta = this._experienceMeta(args)
        if (!this._hasScope(args.scope)) return this._failure('经验 save 需要非空 scope')
        if (!this._hasSourceRef(args.source)) return this._failure('经验 save 需要可核对的 source.ref')
        const id = this._id(meta.id)
        if (await this._findExperience(id)) return this._failure('经验 id 已存在')
        meta.id = id
        meta.status = meta.status || 'candidate'
        const record = { meta, content: this._requiredText(args.content, 'content') }
        await this._writeText(join(this.experienceDir, `${id}.md`), this._markdownWithMeta(meta, record.content))
        return { ok: true, experience: this._publicExperience(record, true) }
      }
      const record = await this._findExperience(args.id)
      if (!record) return this._failure('经验不存在')
      if (action === 'withdraw') {
        record.meta.status = 'withdrawn'
        record.meta.updated_at = this._now()
        await this._writeText(record.file, this._markdownWithMeta(record.meta, record.content))
        return { ok: true, experience: this._publicExperience(record, true) }
      }
      if (action === 'revise') {
        const nextMeta = this._experienceMeta({ ...record.meta, ...args, id: record.meta.id })
        nextMeta.id = record.meta.id
        nextMeta.status = args.status || record.meta.status
        nextMeta.created_at = record.meta.created_at
        const nextContent = args.content === undefined ? record.content : this._requiredText(args.content, 'content')
        const nextRecord = { meta: nextMeta, content: nextContent, file: record.file }
        await this._writeText(record.file, this._markdownWithMeta(nextMeta, nextContent))
        return { ok: true, experience: this._publicExperience(nextRecord, true) }
      }
      return this._failure(`未知 experience action: ${action}`)
    })
  }

  async interest(args = {}) {
    const action = String(args.action || 'list')
    if (action === 'list' || action === 'read') {
      try {
        if (!(await this._isAvailable())) return this._failure('毛球空间不可用，读取已暂停')
        const warnings = []
        const all = await this._readRecoverable(this.interestsFile, [], warnings)
        const items = args._viewer === 'subagent' ? all.filter((x) => !isPrivate(x)) : all
        if (action === 'read') {
          const item = items.find((x) => x.id === args.id)
          return item ? { ok: true, interest: item, version: await fileVersion(this.interestsFile), warnings } : warnings.length ? this._failure('关注点文件不可读，请先修复原文件', { warnings }) : this._failure('关注点不存在')
        }
        return { ok: true, interests: items, private_count: all.filter(isPrivate).length, version: await fileVersion(this.interestsFile), warnings }
      } catch (error) {
        return this._failure(error.message)
      }
    }
    return this._mutate(async () => {
      const items = await this._readJson(this.interestsFile, [])
      if (action === 'save') {
        const item = this._interestItem(args)
        item.id = this._id(item.id)
        if (items.some((x) => x.id === item.id)) return this._failure('关注点 id 已存在')
        items.push(item)
        await this._writeJson(this.interestsFile, items)
        return { ok: true, interest: item }
      }
      const index = items.findIndex((x) => x.id === args.id)
      if (index < 0) return this._failure('关注点不存在')
      if (action !== 'update') return this._failure(`未知 interest action: ${action}`)
      await expectVersion(this.interestsFile, args.expected_version)
      const next = this._interestItem({ ...items[index], ...args, id: items[index].id })
      next.created_at = items[index].created_at
      items[index] = next
      await this._writeJson(this.interestsFile, items)
      return { ok: true, interest: next }
    })
  }

  async space(args = {}) {
    const action = String(args.action || 'status')
    if (action === 'status') return this.status()
    if (action === 'list') {
      try {
        if (!(await this._isAvailable())) return this._failure('毛球空间不可用，读取已暂停')
        const warnings = []
        const files = await this._annotatedSpaceFiles(warnings)
        const privateCount = files.filter((x) => x.visibility === 'private').length
        const shown = args._viewer === 'subagent' ? files.filter((x) => x.visibility !== 'private') : files
        return { ok: true, files: shown, private_count: privateCount, ...(privateCount ? { curtain: `门帘后有 ${privateCount} 件` } : {}), warnings }
      } catch (error) {
        return this._failure(error.message)
      }
    }
    if (action === 'read') {
      try {
        if (!(await this._isAvailable())) return this._failure('毛球空间不可用，读取已暂停')
        const file = await this._safeSpacePath(args.path)
        const content = await readFile(file, 'utf8')
        const warnings = []
        let parsed
        try { parsed = extname(file).toLowerCase() === '.md' ? this._parseMarkdown(content) : { content, meta: await this._readSidecar(file) } }
        catch (error) {
          if (error.code !== 'MAOQIU_DATA') throw error
          warnings.push(this._warning(file, error))
          parsed = { content, meta: null }
        }
        if (args._viewer === 'subagent' && isPrivate(parsed.meta)) return this._failure('这是私密角的材料，子agent不能读取')
        return { ok: true, path: this._spaceRelative(file), content: parsed.content ?? content, metadata: parsed.meta || null, version: await fileVersion(file), warnings }
      } catch (error) {
        return this._failure(error.code === 'ENOENT' ? '空间文件不存在' : error.message, error.code === 'ENOENT' ? { path: args.path, exists: false, version: 'missing' } : {})
      }
    }
    if (action === 'scene') {
      return this._mutate(async () => {
        const current = await this._readJson(this.sceneFile, {})
        if (!Object.prototype.hasOwnProperty.call(args, 'scene')) return { ok: true, scene: current, version: await fileVersion(this.sceneFile), note: '仅空间设定，不代表现实事实' }
        await expectVersion(this.sceneFile, args.expected_version)
        if (!args.scene || typeof args.scene !== 'object' || Array.isArray(args.scene)) return this._failure('scene 必须是对象')
        if (Object.hasOwn(args.scene, 'objects')) return this._failure('物品请用 object 工具按 id 局部更新')
        const next = { ...this._mergeScene(current, args.scene), updated_at: this._now() }
        await this._writeJson(this.sceneFile, next)
        const verified = await this._readJson(this.sceneFile, null)
        if (!verified || JSON.stringify(verified) !== JSON.stringify(next)) throw new Error('场景配置回读不一致')
        return { ok: true, scene: verified, version: await fileVersion(this.sceneFile), verified: true, note: '仅空间设定，不代表现实事实' }
      })
    }
    if (action === 'corners') {
      try {
        if (!(await this._isAvailable())) return this._failure('毛球空间不可用，读取已暂停')
        const warnings = []
        const data = await this._readRecoverable(this.homeFile, {}, warnings)
        return { ok: true, corners: cornerList(data), version: await fileVersion(this.homeFile), warnings }
      } catch (error) { return this._failure(error.message) }
    }
    if (action === 'name_corner') {
      return this._mutate(async () => {
        const id = String(args.corner || '')
        if (!CORNER_IDS.includes(id)) return this._failure(`corner 应为 ${CORNER_IDS.join('/')} 之一`)
        await expectVersion(this.homeFile, args.expected_version)
        const data = await this._readJson(this.homeFile, {})
        const corners = data.corners && typeof data.corners === 'object' && !Array.isArray(data.corners) ? { ...data.corners } : {}
        const name = this._text(args.name).slice(0, 24)
        if (name) corners[id] = { name, named_at: this._now(), source: this._source(args.source, 'creation') }
        else delete corners[id]
        await this._writeJson(this.homeFile, { ...data, corners })
        return { ok: true, corners: cornerList({ corners }), version: await fileVersion(this.homeFile) }
      })
    }
    if (!['write', 'append'].includes(action)) return this._failure(`未知 space action: ${action}`)
    return this._mutate(async () => {
      const file = await this._safeSpacePath(args.path)
      const old = await this._lstatIfExists(file)
      const previous = old ? await this._readSpaceParsed(file) : null
      const operationId = this.writeContext.getStore()?.operationId
      if (operationId && previous?.meta?.operation_id === operationId) return { ok: true, idempotent: true, path: this._spaceRelative(file), content: previous.content, metadata: previous.meta, version: await fileVersion(file), verified: true }
      await expectVersion(file, args.expected_version)
      const content = `${action === 'append' ? previous?.content ?? '' : ''}${this._requiredContent(args.content, 'content')}`
      const metadata = {
        title: typeof args.title === 'string' ? args.title.trim() : previous?.meta?.title || this._spaceRelative(file),
        source: this._source(args.source, 'creation'),
        ...this._placement(args, previous?.meta),
        updated_at: this._now(),
      }
      await this._writeMaterial(file, metadata, content)
      const readBack = await readFile(file, 'utf8')
      const parsedBack = extname(file).toLowerCase() === '.md'
        ? this._parseMarkdown(readBack)
        : { content: readBack, meta: await this._readSidecar(file) }
      if (parsedBack.content !== content) throw new Error('空间文件回读不一致')
      return { ok: true, path: this._spaceRelative(file), content: parsedBack.content, metadata: parsedBack.meta || metadata, version: await fileVersion(file), verified: true }
    })
  }

  object(args = {}) { return objects(this, args) }
  history(args = {}) { return history(this, args) }
  withWriteContext(context, fn) { return this.writeContext.run(context, fn) }
  _checkWrite() {
    const context = this.writeContext.getStore()
    context?.signal?.throwIfAborted()
    context?.assertCurrent?.()
  }

  async activity(args = {}) {
    const action = String(args.action || 'list')
    if (action === 'list' || action === 'read') {
      try {
        if (!(await this._isAvailable())) return this._failure('毛球空间不可用，读取已暂停')
        const warnings = []
        const items = await this._readRecoverable(this.activitiesFile, [], warnings)
        if (action === 'read') {
          const item = items.find((x) => x.id === args.id)
          return item ? { ok: true, activity: item, warnings } : warnings.length ? this._failure('活动文件不可读，请先修复原文件', { warnings }) : this._failure('活动不存在')
        }
        return { ok: true, activities: items, warnings }
      } catch (error) {
        return this._failure(error.message)
      }
    }
    if (action === 'skip' && !args.id) return this._ephemeralSkip(args)
    return this._mutate(async () => {
      const items = await this._readJson(this.activitiesFile, [])
      const index = items.findIndex((x) => x.id === args.id)
      if (action === 'plan') {
        let item
        try {
          item = this._activityItem(args)
        } catch (error) {
          return this._failure(`${error.message}；规划未保存，请修订参数后重新 plan`)
        }
        item.id = this._id(item.id)
        if (item.interest_id && !(await this._readJson(this.interestsFile, [])).some((x) => x.id === item.interest_id)) return this._failure('关联关注点不存在，请先保存关注或省略 interest_id')
        if (items.some((x) => x.id === item.id)) return this._failure('活动 id 已存在')
        items.push(item)
        await this._writeJson(this.activitiesFile, items)
        return { ok: true, activity: item }
      }
      if (index < 0) {
        if (action === 'skip') return this._ephemeralSkip(args)
        return this._failure('活动不存在')
      }
      const item = items[index]
      if (action === 'pause') {
        if (!['planned', 'failed'].includes(item.status)) return this._failure('只有待执行或失败活动可以暂停')
        item.status = 'paused'
        item.updated_at = this._now()
      } else if (action === 'resume') {
        if (item.status !== 'paused') return this._failure('只有暂停活动可以恢复')
        item.status = 'planned'
        item.error = null
        item.result = null
        item.updated_at = this._now()
      } else if (action === 'cancel') {
        if (item.status === 'completed') return this._failure('已完成活动不能取消')
        item.status = 'cancelled'
        item.updated_at = this._now()
      } else if (action === 'skip') {
        if (item.status === 'completed' || item.status === 'cancelled') return this._failure('当前活动不能跳过')
        item.status = 'skipped'
        item.result = { kind: 'skipped', at: this._now(), reason: this._text(args.summary || args.reason) || '没有执行' }
        item.updated_at = this._now()
      } else if (action === 'revise') {
        if (['completed', 'cancelled'].includes(item.status)) return this._failure('已完成或已取消活动不能修订，请重新 plan')
        let revised
        try {
          revised = this._activityItem({ ...item, ...args, id: item.id })
        } catch (error) {
          return this._failure(`${error.message}；规划未保存，请修订参数后重新 revise`)
        }
        revised.id = item.id
        revised.created_at = item.created_at
        revised.status = 'planned'
        revised.result = null
        revised.error = null
        revised.updated_at = this._now()
        items[index] = revised
        await this._writeJson(this.activitiesFile, items)
        return { ok: true, activity: revised }
      } else if (action === 'run') {
        if (item.status === 'completed') {
          const verified = await this._verifyActivity(item)
          return { ok: verified, idempotent: true, activity: { ...item, result: { ...item.result, verified } }, ...(verified ? {} : { error: '已完成活动的产物已更改或不存在；不会自动重写，请检查原文或新建活动' }) }
        }
        if (!['planned', 'failed'].includes(item.status)) return this._failure('只有 planned 或 failed 活动可以执行')
        try {
          const result = await this._runActivity(item)
          item.status = 'completed'
          item.result = result
          item.error = null
          if (item.interest_id) {
            try {
              const interests = await this._readJson(this.interestsFile, [])
              const interest = interests.find((x) => x.id === item.interest_id)
              if (!interest) throw this._dataError('关联关注点已不存在，活动产物已完成但未更新进展')
              interest.progress = `已完成：${item.title}`
              interest.last_activity_id = item.id
              interest.updated_at = this._now()
              await this._writeJson(this.interestsFile, interests)
            } catch (error) { item.result.warnings = [this._warning(this.interestsFile, error)] }
          }
          item.updated_at = this._now()
        } catch (error) {
          item.status = 'failed'
          item.result = null
          item.error = String(error.message || error)
          item.updated_at = this._now()
        }
      } else return this._failure(`未知 activity action: ${action}`)
      try { await this._writeJson(this.activitiesFile, items) }
      catch (error) {
        if (action === 'run' && item.status === 'completed') return this._failure(`活动产物已完成，但活动状态未保存：${error.message}；请检查产物后重试`, { activity: item, persisted: false })
        throw error
      }
      return { ok: item.status !== 'failed', activity: item }
    })
  }

  async recall(args = {}) {
    try {
      if (!(await this._isAvailable())) return this._failure('毛球空间不可用或未初始化，读取已暂停')
      return await recallFromStore(this, args)
    } catch (error) { return this._failure(error.message) }
  }

  _ephemeralSkip(args = {}) {
    const reason = this._text(args.summary || args.reason) || '没有执行'
    const now = this._now()
    const activity = {
      id: this._id(args.id),
      title: this._text(args.title) || reason,
      summary: reason,
      operation: 'skip',
      source: this._source(args.source, 'inference'),
      status: 'skipped',
      result: { kind: 'skipped', at: now, reason },
      created_at: now,
      updated_at: now,
    }
    return { ok: true, persisted: false, activity }
  }

  _failure(error, extra = {}) {
    const paused = /不可用|ENOENT|not available|失联/i.test(String(error))
    return { ok: false, paused, error: String(error).replaceAll(this.home, '<space>'), ...extra }
  }

  async _mutate(fn) {
    const key = this.home.toLowerCase()
    const previous = MaoqiuStore.locks.get(key) || Promise.resolve()
    let release
    const current = new Promise((resolveRelease) => {
      release = resolveRelease
    })
    const chain = previous.then(() => current)
    MaoqiuStore.locks.set(key, chain)
    await previous
    try {
      this._checkWrite()
      if (!(await this._isAvailable())) return this._failure('毛球空间不可用或未初始化，写入已暂停；请核对路径后显式 init')
      return await fn()
    } catch (error) {
      return this._failure(error.message)
    } finally {
      release()
      if (MaoqiuStore.locks.get(key) === chain) MaoqiuStore.locks.delete(key)
    }
  }

  async _isAvailable() {
    const root = await this._lstatIfExists(this.home)
    return !!root && !root.isSymbolicLink() && root.isDirectory() && await this._hasLayout()
  }

  async _hasLayout() {
    await this._assertSafePath(this.experienceDir)
    await this._assertSafePath(this.spaceDir)
    const directories = await Promise.all([this.spaceDir, this.experienceDir].map((p) => this._lstatIfExists(p)))
    if (!directories.every((p) => p?.isDirectory() && !p.isSymbolicLink())) return false
    const states = await Promise.all([this.interestsFile, this.activitiesFile, this.sceneFile].map((p) => this._lstatIfExists(p)))
    return states.some((p) => p?.isFile() && !p.isSymbolicLink())
  }

  async _lstatIfExists(path) {
    try {
      return await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async _assertSafePath(file, root = this.home) {
    const base = resolve(root)
    const candidate = resolve(file)
    if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) throw new Error('路径越界')
    const relativePath = relative(base, candidate)
    let current = base
    const parts = relativePath ? relativePath.split(sep) : []
    for (const part of parts) {
      current = join(current, part)
      const item = await this._lstatIfExists(current)
      if (item?.isSymbolicLink()) throw new Error('拒绝访问符号链接')
    }
    const baseItem = await this._lstatIfExists(base)
    if (baseItem?.isSymbolicLink()) throw new Error('拒绝访问符号链接')
    return candidate
  }

  async _writeIfMissing(file, text) {
    await this._assertSafePath(file)
    const old = await this._lstatIfExists(file)
    if (old?.isSymbolicLink()) throw new Error('拒绝写入符号链接')
    if (!old) await this._atomicWrite(file, text, false)
  }

  async _writeText(file, text) {
    await this._atomicWrite(file, text, true)
  }

  async _atomicWrite(file, text, backup) {
    this._checkWrite()
    await this._assertSafePath(file)
    await mkdir(dirname(file), { recursive: true })
    const old = await this._lstatIfExists(file)
    if (old?.isSymbolicLink()) throw new Error('拒绝写入符号链接')
    const before = old?.isFile() ? await fileVersion(file) : 'missing'
    const historyId = backup && old?.isFile() ? await this._backup(file) : null
    const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      await writeFile(temp, text, 'utf8')
      this._checkWrite()
      await rename(temp, file)
      this.revision += 1
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    if (file !== this.journalFile) await this._journal(file, before, historyId)
  }

  /** Record that a write happened; content itself is never copied here. */
  async _journal(file, before, historyId) {
    const op = this.opContext.getStore() || {}
    const write = this.writeContext.getStore()
    const fields = {
      target: relative(this.home, file).split(sep).join('/'),
      op: before === 'missing' ? 'create' : 'update',
      before,
      after: await fileVersion(file),
      history: historyId,
      actor: write?.assertCurrent ? 'freetime' : op.actor || (op.tool ? 'tool' : 'direct'),
      ...(op.tool ? { tool: op.tool } : {}),
      ...(op.action ? { action: op.action } : {}),
      ...(op.source_kind ? { source_kind: op.source_kind } : {}),
      ...(op.visibility ? { visibility: op.visibility } : {}),
    }
    // Free-time usage accounting is kept in full but marked so views can fold it.
    if (fields.target === 'space/free_time.json') fields.bookkeeping = true
    try { await appendJournal(this.journalFile, fields) }
    catch (error) { throw new Error(`内容已写入，但变更日志追加失败：${error.message}`) }
  }

  /** Attach provenance (tool/action/source kind) to the journal entries of fn's writes. */
  withOp(op, fn) { return this.opContext.run(op, fn) }

  verifyJournal() { return verifyJournal(this.journalFile, this.historyDir) }

  async _backup(file) {
    const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`
    const target = join(this.historyDir, `${stamp}-${this._encodePath(relative(this.home, file))}`)
    await this._assertSafePath(this.historyDir)
    await mkdir(this.historyDir, { recursive: true })
    await copyFile(file, target)
    return relative(this.historyDir, target)
  }

  async _writeJson(file, value) {
    await this._writeText(file, `${JSON.stringify(value, null, 2)}\n`)
  }

  async _readJson(file, fallback) {
    try {
      await this._assertSafePath(file)
      const text = await readFile(file, 'utf8')
      let value
      try { value = JSON.parse(text) } catch { throw this._dataError('JSON 损坏，保留原文件，未自动覆盖') }
      const list = file === this.interestsFile || file === this.activitiesFile || Array.isArray(fallback)
      if (list ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw this._dataError(list ? '应为 JSON 数组' : '应为 JSON 对象')
      if (list && value.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || typeof x.status !== 'string')) throw this._dataError('列表中存在无效记录，请检查 id 与 status')
      return value
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (![this.interestsFile, this.activitiesFile, this.sceneFile].includes(file)) return fallback
        throw this._dataError(`${relative(this.home, file)} 缺失，请从备份恢复或显式 init`)
      }
      if (error.code === 'MAOQIU_DATA') throw this._dataError(`${relative(this.home, file)}: ${error.message}`)
      throw error
    }
  }

  _dataError(message) {
    return Object.assign(new Error(message), { code: 'MAOQIU_DATA' })
  }

  _warning(file, error) {
    return { path: relative(this.home, file).split(sep).join('/'), message: String(error.message || error).replaceAll(this.home, '<space>').slice(0, 180) }
  }

  async _readRecoverable(file, fallback, warnings) {
    try { return await this._readJson(file, fallback) }
    catch (error) {
      if (error.code !== 'MAOQIU_DATA') throw error
      warnings.push(this._warning(file, error))
      return fallback
    }
  }

  async _readText(file, { preview = false } = {}) {
    if (!preview) return readFile(file, 'utf8')
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await handle.close() }
  }

  async _experienceRecords(warnings = [], options = {}) {
    if (!(await this._isAvailable())) throw new Error('毛球空间不可用')
    await this._assertSafePath(this.experienceDir)
    const entries = await readdir(this.experienceDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const records = []
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
      const file = join(this.experienceDir, entry.name)
      try {
        await this._assertSafePath(file)
        const parsed = this._parseMarkdown(await this._readText(file, options))
        if (!parsed.meta?.id || !parsed.meta?.title || !['active', 'candidate', 'withdrawn'].includes(parsed.meta.status)) throw this._dataError('缺少有效经验元数据')
        records.push({ meta: parsed.meta, content: parsed.content, file })
      } catch (error) { warnings.push(this._warning(file, error)) }
    }
    return records
  }

  async _findExperience(id) {
    if (!id) return null
    const candidate = join(this.experienceDir, `${this._id(id)}.md`)
    await this._assertSafePath(candidate)
    try {
      const parsed = this._parseMarkdown(await readFile(candidate, 'utf8'))
      return parsed.meta?.id ? { meta: parsed.meta, content: parsed.content, file: candidate } : null
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async _spaceFiles(warnings = []) {
    const files = []
    for (const category of ['notes', 'drafts', 'collections']) {
      const root = join(this.spaceDir, category)
      try { await this._assertSafePath(root) } catch (error) { warnings.push(this._warning(root, error)); continue }
      const visit = async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true }).catch((error) => { warnings.push(this._warning(dir, error)); return [] })
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          const child = join(dir, entry.name)
          if (entry.isSymbolicLink()) { warnings.push(this._warning(child, new Error('跳过符号链接'))); continue }
          if (entry.isDirectory()) await visit(child)
          else if (entry.isFile() && ['.md', '.txt'].includes(extname(entry.name).toLowerCase())) {
            try {
              const st = await stat(child)
              files.push({ path: this._spaceRelative(child), size: st.size, updated_at: st.mtime.toISOString() })
            } catch (error) { warnings.push(this._warning(child, error)) }
          }
        }
      }
      await visit(root)
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  async _safeSpacePath(raw) {
    const clean = this._validateSpacePathText(raw)
    const file = resolve(this.spaceDir, normalize(clean))
    const base = resolve(this.spaceDir)
    if (!(file === base || file.startsWith(`${base}${sep}`))) throw new Error('path 越界')
    await this._assertSafePath(file, base)
    return file
  }

  async _readSpaceParsed(file, options = {}) {
    await this._assertSafePath(file)
    const raw = await this._readText(file, options)
    return extname(file).toLowerCase() === '.md' ? this._parseMarkdown(raw) : { content: raw, meta: await this._readSidecar(file) }
  }

  async _readSidecar(file) {
    const sidecar = this._sidecarPath(file)
    return (await this._readJson(sidecar, null)) || {}
  }

  async _writeSidecar(file, meta) {
    await this._writeJson(this._sidecarPath(file), meta)
  }

  async _writeMaterial(file, metadata, content) {
    const operationId = this.writeContext.getStore()?.operationId
    if (operationId) metadata = { ...metadata, operation_id: operationId }
    const old = await this._lstatIfExists(file)
    // Validate an existing header/sidecar before replacing any bytes.
    if (old) await this._readSpaceParsed(file)
    if (extname(file).toLowerCase() === '.md') {
      await this._writeText(file, this._markdownWithMeta(metadata, content))
      return
    }
    await this._readSidecar(file)
    const previous = old ? await readFile(file) : null
    await this._writeText(file, content)
    try { await this._writeSidecar(file, metadata) }
    catch (error) {
      try {
        if (previous !== null) await this._atomicWrite(file, previous, false)
        else await rm(file)
      } catch (rollback) {
        throw new Error(`正文已保存，但元数据保存及正文恢复失败，请检查文件与历史：${error.message}；${rollback.message}`)
      }
      throw new Error(`元数据保存失败，正文已恢复原状：${error.message}`)
    }
  }

  _sidecarPath(file) {
    const token = this._encodePath(relative(this.spaceDir, file))
    return join(this.spaceDir, '.metadata', `${token}.json`)
  }

  _spaceRelative(file) {
    return relative(this.spaceDir, file).split(sep).join('/')
  }

  _encodePath(value) {
    return Buffer.from(value, 'utf8').toString('base64url')
  }

  _markdownWithMeta(meta, content) {
    return `<!-- maoqiu-meta\n${JSON.stringify(meta)}\n-->\n\n${content}`
  }

  _parseMarkdown(raw) {
    const match = /^<!--\s*maoqiu-meta\s*\r?\n([\s\S]*?)\r?\n-->\r?\n(?:\r?\n)?/.exec(raw)
    if (!match) {
      if (/^<!--\s*maoqiu-meta\b/.test(raw)) throw this._dataError('Markdown 元数据头格式损坏')
      return { meta: null, content: raw }
    }
    try {
      const meta = JSON.parse(match[1])
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error()
      return { meta, content: raw.slice(match[0].length) }
    } catch {
      throw this._dataError('Markdown 元数据 JSON 损坏')
    }
  }

  _publicExperience(record, full) {
    const value = { ...record.meta }
    if (full) value.content = record.content
    else value.excerpt = this._excerpt(record.content)
    return value
  }

  _publicInterest(item) {
    const value = { ...item }
    for (const key of ['title', 'reason', 'progress', 'next_step']) value[key] = this._excerpt(item[key], 300)
    value.materials = Array.isArray(item.materials) ? item.materials.slice(0, 3).map((x) => this._excerpt(x, 300)) : []
    return value
  }

  _experienceMeta(args) {
    const source = this._source(args.source)
    const status = args.status || 'candidate'
    if (!['candidate', 'active', 'withdrawn'].includes(status)) throw new Error('经验 status 无效')
    return {
      id: args.id,
      title: this._requiredText(args.title, 'title'),
      scope: this._scope(args.scope),
      ...(typeof args.project === 'string' && args.project ? { project: args.project } : {}),
      keywords: this._strings(args.keywords),
      source,
      status,
      created_at: args.created_at || this._now(),
      updated_at: this._now(),
    }
  }

  _placement(args, previous = {}) {
    const visibility = Object.hasOwn(args, 'visibility') ? normalizeVisibility(args.visibility) : previous?.visibility
    const corner = Object.hasOwn(args, 'corner') ? normalizeCorner(args.corner) : previous?.corner
    return { ...(visibility === 'private' ? { visibility } : {}), ...(corner ? { corner } : {}) }
  }

  /** Space files with their optional placement metadata (read-only). */
  async _annotatedSpaceFiles(warnings = []) {
    const files = await this._spaceFiles(warnings)
    for (const entry of files) {
      try {
        const parsed = await this._readSpaceParsed(join(this.spaceDir, entry.path), { preview: true })
        const meta = parsed.meta || {}
        if (typeof meta.title === 'string') entry.title = meta.title
        if (isPrivate(meta)) entry.visibility = 'private'
        if (typeof meta.corner === 'string') entry.corner = meta.corner
        if (typeof meta.updated_at === 'string') entry.meta_updated_at = meta.updated_at
      } catch (error) { warnings.push(this._warning(join(this.spaceDir, entry.path), error)) }
    }
    return files
  }

  _interestItem(args) {
    const status = args.status || 'active'
    const kind = args.kind || 'interest'
    if (!['active', 'paused', 'completed', 'archived', 'abandoned'].includes(status)) throw new Error('关注点 status 无效')
    if (!['interest', 'commitment'].includes(kind)) throw new Error('关注点 kind 无效')
    return {
      id: args.id,
      title: this._requiredText(args.title, 'title'),
      reason: this._text(args.reason),
      progress: this._text(args.progress),
      next_step: this._text(args.next_step),
      materials: this._strings(args.materials),
      status,
      kind,
      source: this._source(args.source),
      ...(args.last_activity_id ? { last_activity_id: args.last_activity_id } : {}),
      ...this._placement(args),
      created_at: args.created_at || this._now(),
      updated_at: this._now(),
    }
  }

  _activityItem(args) {
    const operation = args.operation || 'draft'
    if (!['draft', 'scene'].includes(operation)) throw new Error('活动 operation 无效')
    if (operation === 'draft') {
      this._validateDraftPathText(args.path)
      if (typeof args.content !== 'string') throw new Error('draft 活动需要 content')
    }
    if (operation === 'scene' && (!args.scene || typeof args.scene !== 'object' || Array.isArray(args.scene))) {
      throw new Error('scene 活动需要 scene 对象')
    }
    return {
      id: args.id,
      interest_id: this._text(args.interest_id),
      title: this._requiredText(args.title, 'title'),
      summary: this._text(args.summary),
      operation,
      ...(typeof args.expected_version === 'string' ? { expected_version: args.expected_version } : {}),
      ...(operation === 'draft' ? { path: args.path, content: args.content } : { scene: args.scene }),
      source: this._source(args.source),
      status: 'planned',
      created_at: this._now(),
      updated_at: this._now(),
    }
  }

  _validateSpacePathText(path) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('path 必须是空间内相对路径')
    const clean = path.replaceAll('\\', '/').replace(/^[^/]+/, (category) => category.toLowerCase())
    if (isAbsolute(clean) || clean.split('/').some((x) => x === '..' || x === '')) throw new Error('path 必须是安全的相对路径')
    if (clean.split('/').some((x) => /[. ]$/.test(x))) throw new Error('路径段不能以空格或点结尾')
    if (!['notes', 'drafts', 'collections'].includes(clean.split('/')[0])) throw new Error('path 只能位于 notes、drafts 或 collections')
    if (!['.md', '.txt'].includes(extname(clean).toLowerCase())) throw new Error('path 只支持 .md 或 .txt')
    return clean
  }

  _validateDraftPathText(path) {
    this._validateSpacePathText(path)
    const clean = path.replaceAll('\\', '/').replace(/^[^/]+/, (category) => category.toLowerCase())
    if (clean.split('/')[0] !== 'drafts') throw new Error('draft 活动只能写入 drafts 目录')
  }

  async _runActivity(item) {
    if (item.operation === 'draft') {
      if (!item.path || typeof item.content !== 'string') throw new Error('draft 活动需要 path 和 content')
      this._validateDraftPathText(item.path)
      const file = await this._safeSpacePath(item.path)
      await expectVersion(file, item.expected_version)
      const metadata = { title: item.title, source: this._source(item.source, 'creation'), updated_at: this._now() }
      await this._writeMaterial(file, metadata, item.content)
      const readBack = await readFile(file, 'utf8')
      const parsedBack = extname(file).toLowerCase() === '.md' ? this._parseMarkdown(readBack) : { content: readBack }
      if (parsedBack.content !== item.content) throw new Error('草稿回读不一致')
      return {
        operation: 'draft',
        path: this._spaceRelative(file),
        result: 'written',
        verified: true,
        at: this._now(),
      }
    }
    if (!item.scene || typeof item.scene !== 'object' || Array.isArray(item.scene)) throw new Error('scene 活动需要 scene 对象')
    const current = await this._readJson(this.sceneFile, {})
    await expectVersion(this.sceneFile, item.expected_version)
    if (Object.hasOwn(item.scene, 'objects')) throw new Error('物品请用 object 工具按 id 局部更新')
    const scene = { ...this._mergeScene(current, item.scene), updated_at: this._now() }
    await this._writeJson(this.sceneFile, scene)
    const verified = await this._readJson(this.sceneFile, null)
    if (!verified || JSON.stringify(verified) !== JSON.stringify(scene)) throw new Error('场景配置回读不一致')
    return { operation: 'scene', scene: verified, result: 'updated', verified: true, at: this._now() }
  }

  _source(raw, defaultKind = 'inference') {
    const source = raw && typeof raw === 'object' ? raw : { kind: defaultKind, ref: 'unspecified' }
    const kind = typeof source.kind === 'string' ? source.kind : defaultKind
    if (!['user', 'inference', 'tool', 'external', 'creation'].includes(kind)) throw new Error('source.kind 无效')
    return { kind, ref: typeof source.ref === 'string' ? source.ref : 'unspecified', ...Object.fromEntries(['session', 'agent', 'entry'].filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]])) }
  }

  _mergeScene(current, patch) {
    const result = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      const nested = value && typeof value === 'object' && !Array.isArray(value)
      const old = current[key]
      const merged = nested ? this._mergeScene(old && typeof old === 'object' && !Array.isArray(old) ? old : {}, value) : value
      Object.defineProperty(result, key, { value: merged, enumerable: true, configurable: true, writable: true })
    }
    return result
  }

  async _verifyActivity(item) {
    try {
      if (item.operation === 'draft') {
        const file = await this._safeSpacePath(item.path)
        const parsed = await this._readSpaceParsed(file)
        return parsed.content === item.content
      }
      const scene = await this._readJson(this.sceneFile, {})
      const contains = (actual, expected) => Object.entries(expected).every(([key, value]) => value && typeof value === 'object' && !Array.isArray(value) ? actual?.[key] && contains(actual[key], value) : JSON.stringify(actual?.[key]) === JSON.stringify(value))
      return !!contains(scene, item.scene)
    } catch { return false }
  }

  _hasSourceRef(raw) {
    return !!(raw && typeof raw === 'object' && typeof raw.ref === 'string' && raw.ref.trim())
  }

  _hasScope(raw) {
    if (Array.isArray(raw)) return raw.some((x) => typeof x === 'string' && x.trim())
    return typeof raw === 'string' && !!raw.trim()
  }

  _scope(raw) {
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
    return typeof raw === 'string' ? raw.trim() : ''
  }

  _strings(raw) {
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []
  }

  _text(raw) {
    return typeof raw === 'string' ? raw.trim() : ''
  }

  _requiredText(raw, name) {
    const value = this._text(raw)
    if (!value) throw new Error(`${name} 不能为空`)
    return value
  }

  _requiredContent(raw, name) {
    if (typeof raw !== 'string') throw new Error(`${name} 不能为空`)
    return raw
  }

  _id(raw) {
    if (raw === undefined || raw === null || raw === '') return `m-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const id = String(raw).trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw new Error('id 含有不安全字符')
    return id
  }

  _now() {
    return new Date().toISOString()
  }

  _excerpt(text, max = 600) {
    const clean = String(text || '').trim().replace(/\s+/g, ' ')
    return clean.length > max ? `${clean.slice(0, max)}…` : clean
  }

}

export default MaoqiuStore
