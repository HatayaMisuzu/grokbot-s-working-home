import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Explicit, file-level backup helpers for the maintenance CLI.
 *
 * This module is deliberately separate from the DSH tools. A backup or restore
 * is an operator action and is never exposed as an agent capability.
 */

function failure(error, extra = {}) {
  return { ok: false, error: String(error?.message || error), ...extra }
}

function pathKey(path) {
  return resolve(path).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function sameOrWithin(parent, child) {
  const p = pathKey(parent)
  const c = pathKey(child)
  return c === p || c.startsWith(`${p}/`)
}

function requireAbsolute(path, label) {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new Error(`${label} 必须是绝对路径`)
  }
  return resolve(path)
}

async function existing(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function assertNoSymlinkAncestors(path, { allowMissingLeaf = false } = {}) {
  const absolute = resolve(path)
  const parts = absolute.split(sep)
  // Keep the drive root (C:\) or UNC root intact while walking.
  let current = parts[0] || sep
  if (current.endsWith(':')) current += sep
  for (let index = current === sep || /[A-Za-z]:\\$/.test(current) ? 1 : 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (!part) continue
    current = current.endsWith(sep) ? `${current}${part}` : join(current, part)
    const info = await existing(current)
    if (!info) {
      if (allowMissingLeaf) return
      return
    }
    if (info.isSymbolicLink()) throw new Error(`拒绝符号链接或 junction 路径：${current}`)
    if (!info.isDirectory() && index < parts.length - 1) throw new Error(`路径父级不是目录：${current}`)
  }
}

async function assertTreeSafe(root) {
  const info = await existing(root)
  if (!info) throw new Error(`路径不存在：${root}`)
  if (info.isSymbolicLink()) throw new Error(`拒绝符号链接或 junction 路径：${root}`)
  if (!info.isDirectory()) throw new Error(`路径不是目录：${root}`)
  await assertNoSymlinkAncestors(root)
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(current, entry.name)
      const childInfo = await lstat(child)
      if (childInfo.isSymbolicLink()) throw new Error(`拒绝符号链接或 junction 路径：${child}`)
      if (childInfo.isDirectory()) await walk(child)
    }
  }
  await walk(root)
}

async function assertEmptyDirectory(path, label) {
  const info = await existing(path)
  if (!info) return false
  if (info.isSymbolicLink()) throw new Error(`${label}不能是符号链接或 junction`)
  if (!info.isDirectory()) throw new Error(`${label}不是目录`)
  await assertNoSymlinkAncestors(path)
  const entries = await readdir(path)
  if (entries.length) throw new Error(`${label}必须为空；恢复不会覆盖已有非空空间，请先另存旧目录再恢复`)
  return true
}

async function assertInitializedSpace(root) {
  await assertTreeSafe(root)
  const directories = [
    join(root, 'space'),
    join(root, 'evolution', 'experiences'),
  ]
  for (const path of directories) {
    const info = await existing(path)
    if (!info || !info.isDirectory()) {
      throw new Error(`不是已初始化的毛球空间，缺少：${relative(root, path)}`)
    }
  }

  const statusFiles = [
    join(root, 'space', 'active_interests.json'),
    join(root, 'space', 'scene.json'),
    join(root, 'space', 'activities.json'),
  ]
  const hasStatusFile = (await Promise.all(statusFiles.map(existing))).some((info) => info?.isFile())
  if (!hasStatusFile) {
    throw new Error(`不是已初始化的毛球空间，至少需要一份状态文件：${statusFiles.map((path) => relative(root, path)).join('、')}`)
  }
}

async function copyTree(source, target) {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error(`拒绝复制符号链接或 junction：${source}`)
  if (info.isDirectory()) {
    await mkdir(target)
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyTree(join(source, entry.name), join(target, entry.name))
    }
    return
  }
  if (!info.isFile()) throw new Error(`只支持普通文件和目录：${source}`)
  await copyFile(source, target)
}

function stagingPath(parent, label) {
  return join(parent, `.maoqiu-${label}-${process.pid}-${Date.now()}-${randomBytes(5).toString('hex')}`)
}

async function cleanupStaging(staging, target) {
  // A staging path is unique to this operation. Check it before removal so a
  // later refactor cannot accidentally remove the destination after a rename.
  if (!staging || sameOrWithin(staging, target) || sameOrWithin(target, staging)) return
  if (await existing(staging)) await rm(staging, { recursive: true, force: true }).catch(() => {})
}

/**
 * Install a copied staging tree without deleting a concurrently-created
 * destination. Exported for a deterministic failure-safety test.
 */
export async function commitStaging(staging, target, hadEmptyTarget) {
  const parent = dirname(target)
  let displaced = null
  let displacedMoved = false
  let stagingMoved = false
  const warnings = []
  try {
    if (hadEmptyTarget) {
      displaced = stagingPath(parent, 'old')
      await rename(target, displaced)
      displacedMoved = true
    }
    await rename(staging, target)
    stagingMoved = true
    if (displaced) {
      try {
        await rmdir(displaced)
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`旧空目录未删除，已保留：${displaced}`)
      }
    }
    return warnings
  } catch (error) {
    if (!stagingMoved) await cleanupStaging(staging, target)
    if (displacedMoved && !stagingMoved) {
      // Restore only when the destination is still absent. If another process
      // created it, leave that directory and all of its data untouched.
      if (!(await existing(target))) {
        await rename(displaced, target).catch(() => {})
      } else {
        try { await rmdir(displaced) } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') warnings.push(`并发目标存在，旧目录已保留：${displaced}`)
        }
      }
    }
    if (warnings.length) error.warnings = warnings
    throw error
  }
}

function validateSeparate(source, target, sourceLabel, targetLabel) {
  if (sameOrWithin(source, target) || sameOrWithin(target, source)) {
    throw new Error(`${sourceLabel}与${targetLabel}不能相同或互为子目录`)
  }
}

/** Copy an initialized space to an empty/new directory, preserving bytes. */
export async function backupSpace(home, target) {
  try {
    const source = requireAbsolute(home, 'home')
    const destination = requireAbsolute(target, 'backup 目标')
    validateSeparate(source, destination, '空间', '备份目标')
    await assertInitializedSpace(source)
    await assertNoSymlinkAncestors(dirname(destination), { allowMissingLeaf: true })
    const hadEmptyTarget = await assertEmptyDirectory(destination, '备份目标')
    await mkdir(dirname(destination), { recursive: true })
    const staging = stagingPath(dirname(destination), 'backup')
    try {
      await copyTree(source, staging)
      const warnings = await commitStaging(staging, destination, hadEmptyTarget)
      return warnings.length ? { ok: true, command: 'backup', home: source, target: destination, warnings } : { ok: true, command: 'backup', home: source, target: destination }
    } catch (error) {
      await cleanupStaging(staging, destination)
      throw error
    }
  } catch (error) {
    return failure(error, error.warnings?.length ? { warnings: error.warnings } : {})
  }
}

/** Restore a backup into an empty/new directory; never overwrite live data. */
export async function restoreSpace(home, sourcePath) {
  try {
    const destination = requireAbsolute(home, 'home')
    const source = requireAbsolute(sourcePath, 'restore 来源')
    validateSeparate(source, destination, '恢复来源', '空间')
    await assertInitializedSpace(source)
    await assertNoSymlinkAncestors(dirname(destination), { allowMissingLeaf: true })
    const hadEmptyTarget = await assertEmptyDirectory(destination, '恢复目标空间')
    await mkdir(dirname(destination), { recursive: true })
    const staging = stagingPath(dirname(destination), 'restore')
    try {
      await copyTree(source, staging)
      const warnings = await commitStaging(staging, destination, hadEmptyTarget)
      return warnings.length ? { ok: true, command: 'restore', home: destination, source, warnings } : { ok: true, command: 'restore', home: destination, source }
    } catch (error) {
      await cleanupStaging(staging, destination)
      throw error
    }
  } catch (error) {
    return failure(error, error.warnings?.length ? { warnings: error.warnings } : {})
  }
}

