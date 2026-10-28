import { normalizeCorner, normalizeVisibility } from './home-view.js'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

// Plugin writes are serialized. Metadata also detects ordinary editor changes;
// it cannot provide an atomic compare-and-swap against an unrelated process.
export async function fileVersion(file) {
  try {
    const info = await lstat(file, { bigint: true })
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('目标不是普通文件')
    return `${info.mtimeNs}:${info.ctimeNs}:${info.size}`
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function expectVersion(file, expected) {
  if (expected !== undefined && expected !== await fileVersion(file)) throw new Error('内容版本冲突；请重新读取后决定，不会覆盖新内容')
}

function objectMap(scene) {
  const items = scene.objects ?? {}
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('scene.objects 应为按稳定 id 保存的对象，请先检查原文件')
  return items
}

function checkObjectVersion(item, expected) {
  if (expected !== undefined && expected !== (item ? String(item.version || 1) : 'missing')) throw new Error('物品版本冲突；请重新读取后决定')
}

export async function objects(store, args) {
  try {
    if (!(await store._isAvailable())) return store._failure('毛球空间不可用')
    const action = args.action || 'list'
    const perform = async () => {
      const scene = await store._readJson(store.sceneFile, {})
      const items = objectMap(scene)
      const visible = (item) => !(args._viewer === 'subagent' && item?.visibility === 'private')
      if (action === 'list') {
        const all = Object.values(items).filter((item) => args.include_archived || !item.archived)
        return { ok: true, objects: all.filter(visible), private_count: all.filter((item) => item.visibility === 'private').length }
      }
      const id = store._id(store._requiredText(args.id, 'id'))
      const item = Object.hasOwn(items, id) ? items[id] : null
      if (action === 'read' && !visible(item)) throw new Error('这是私密角的物品，子agent不能读取')
      if (action === 'read') return { ok: true, object: item, version: item ? String(item.version || 1) : 'missing' }
      if (!['upsert', 'archive'].includes(action)) throw new Error('未知 object action')
      checkObjectVersion(item, args.expected_version)
      if (action === 'archive' && !item) throw new Error('物品不存在')
      const patch = args.patch || {}
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch 必须是对象')
      const allowed = ['name', 'description', 'region', 'position', 'links', 'archived', 'visibility', 'corner']
      if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('patch 只允许修改 name/description/region/position/links/archived/visibility/corner')
      if (Object.hasOwn(patch, 'visibility')) normalizeVisibility(patch.visibility)
      if (Object.hasOwn(patch, 'corner') && patch.corner !== null) normalizeCorner(patch.corner)
      if (['name', 'description', 'region', 'position'].some((key) => Object.hasOwn(patch, key) && typeof patch[key] !== 'string')) throw new Error('物品文字字段必须是字符串')
      if (Object.hasOwn(patch, 'links') && (!Array.isArray(patch.links) || patch.links.some((value) => typeof value !== 'string'))) throw new Error('links 必须是字符串数组')
      if (Object.hasOwn(patch, 'archived') && typeof patch.archived !== 'boolean') throw new Error('archived 必须为布尔值')
      const next = { ...item, ...patch, id, version: (item?.version || 0) + 1, updated_at: store._now() }
      if (action === 'archive') next.archived = true
      if (!next.name?.trim()) throw new Error('新物品需要 name')
      Object.defineProperty(items, id, { value: next, enumerable: true, configurable: true, writable: true })
      scene.objects = items
      await store._writeJson(store.sceneFile, scene)
      const saved = objectMap(await store._readJson(store.sceneFile, {}))[id]
      if (JSON.stringify(saved) !== JSON.stringify(next)) throw new Error('物品回读不一致')
      return { ok: true, object: saved, version: String(saved.version), verified: true }
    }
    return ['list', 'read'].includes(action) ? await perform() : await store._mutate(perform)
  } catch (error) { return store._failure(error.message) }
}

async function targetOf(store, args) {
  if (args.object_id) return { file: store.sceneFile, key: 'space/scene.json', objectId: store._id(args.object_id) }
  if (args.path === 'scene.json') return { file: store.sceneFile, key: 'space/scene.json' }
  const file = await store._safeSpacePath(args.path)
  return { file, key: `space/${store._spaceRelative(file)}` }
}

export async function history(store, args) {
  try {
    if (!(await store._isAvailable())) return store._failure('毛球空间不可用')
    const target = await targetOf(store, args)
    // Existing backups used the platform's separator. Accept both so a copied
    // space keeps its history on Windows and other Node hosts.
    const encodings = [...new Set([target.key.replaceAll('\\', '/'), target.key.replaceAll('/', '\\')])].map((key) => store._encodePath(key))
    await store._assertSafePath(store.historyDir)
    const names = (await readdir(store.historyDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
      .filter((name) => /^\d+-[a-f\d]+-/.test(name) && encodings.some((encoded) => name.endsWith(`-${encoded}`))).sort().reverse()
    if ((args.action || 'list') === 'list') {
      const items = []
      for (const name of names) {
        const file = join(store.historyDir, name)
        await store._assertSafePath(file)
        const text = await readFile(file, 'utf8')
        let preview
        if (target.objectId) {
          const previous = JSON.parse(text)
          if (!Object.hasOwn(objectMap(previous), target.objectId)) continue
          preview = JSON.stringify(objectMap(previous)[target.objectId]).slice(0, 240)
        }
        else preview = (extname(target.file).toLowerCase() === '.md' ? store._parseMarkdown(text).content : text).slice(0, 240)
        items.push({ history_id: name, at: new Date(Number(name.split('-')[0])).toISOString(), preview })
        if (items.length >= Math.min(20, Math.max(1, args.limit || 10))) break
      }
      return { ok: true, ...(target.objectId ? { object_id: target.objectId } : { path: args.path }), history: items }
    }
    if (args.action !== 'restore' || !names.includes(args.history_id)) throw new Error('历史版本不存在或不属于这个目标')
    if (typeof args.expected_version !== 'string') throw new Error('恢复需要先读取目标并提供 expected_version')
    return store._mutate(async () => {
      const snapshot = join(store.historyDir, args.history_id)
      await store._assertSafePath(snapshot)
      const text = await readFile(snapshot, 'utf8')
      if (target.objectId) {
        const current = await store._readJson(store.sceneFile, {})
        const items = objectMap(current)
        checkObjectVersion(Object.hasOwn(items, target.objectId) ? items[target.objectId] : null, args.expected_version)
        const oldItems = objectMap(JSON.parse(text))
        const previous = Object.hasOwn(oldItems, target.objectId) ? oldItems[target.objectId] : null
        if (!previous) throw new Error('历史版本中没有该物品')
        const restored = { ...previous, version: (items[target.objectId]?.version || 0) + 1, updated_at: store._now() }
        Object.defineProperty(items, target.objectId, { value: restored, enumerable: true, configurable: true, writable: true })
        current.objects = items
        await store._writeJson(store.sceneFile, current)
        return { ok: true, object: restored, version: String(restored.version), restored_from: args.history_id, verified: JSON.stringify((await store._readJson(store.sceneFile, {})).objects[target.objectId]) === JSON.stringify(restored) }
      }
      await expectVersion(target.file, args.expected_version)
      if (target.file === store.sceneFile) {
        const scene = JSON.parse(text)
        if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('历史场景不是对象')
        await store._writeJson(target.file, scene)
      } else if (extname(target.file).toLowerCase() === '.md') {
        store._parseMarkdown(text)
        await store._writeText(target.file, text)
      } else {
        // Restore the text body, recording the restore as current provenance.
        await store._writeMaterial(target.file, { source: store._source(args.source, 'creation'), restored_from: args.history_id, updated_at: store._now() }, text)
      }
      const expected = target.file === store.sceneFile ? `${JSON.stringify(JSON.parse(text), null, 2)}\n` : text
      return { ok: true, path: args.path, version: await fileVersion(target.file), restored_from: args.history_id, verified: (await readFile(target.file, 'utf8')) === expected }
    })
  } catch (error) { return store._failure(error.message) }
}
