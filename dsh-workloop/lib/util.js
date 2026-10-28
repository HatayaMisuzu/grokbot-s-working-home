/**
 * Shared primitives for the work-loop draft.
 *
 * Everything here is dependency-free and deliberately small: hashing, stable
 * JSON, atomic writes, path/scope matching and quality ranks. The plugin must
 * stay usable when linked as a local bundle, so it imports nothing from the
 * Harness packages.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Evidence quality ladder. Q0 never satisfies a completion claim. */
export const QUALITIES = ['Q0', 'Q1', 'Q2', 'Q3']

/** Rank a quality label; unknown labels degrade to Q0 rather than throwing. */
export function qualityRank(value) {
  const index = QUALITIES.indexOf(String(value ?? '').toUpperCase())
  return index < 0 ? 0 : index
}

/** Canonical quality label for a rank. */
export function qualityAt(rank) {
  return QUALITIES[Math.min(QUALITIES.length - 1, Math.max(0, rank))]
}

export function nowIso() {
  return new Date().toISOString()
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** JSON with recursively sorted object keys, so equal values hash equally. */
export function stableJson(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (item !== undefined) output[key] = sortValue(item)
  }
  return output
}

export function hashOf(value) {
  return sha256(stableJson(value))
}

/** Normalize a workspace-relative path to forward slashes without ./, or trailing /. */
export function normalizeRel(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/')
  if (text === '' || text === '.') return ''
  return text.replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Resolve a relative path under a root; absolute input is kept as-is. */
export function absoluteUnder(root, value) {
  const text = String(value ?? '').trim()
  if (isAbsolute(text)) return resolve(text)
  return resolve(root || '.', normalizeRel(text))
}

/** True when `absolute` is `root` itself or lives under it. */
export function isInside(root, absolute) {
  const rel = relative(resolve(root), resolve(absolute))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Path as seen from `root`, forward-slashed; absolute path outside root stays absolute. */
export function relativeTo(root, absolute) {
  const rel = relative(resolve(root), resolve(absolute))
  return normalizeRel(rel.startsWith('..') || isAbsolute(rel) ? absolute : rel)
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

/** Write JSON through a temp file + rename, so a crash cannot leave half a record. */
export function atomicWriteJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function atomicWriteText(file, text) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function readText(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

export function listFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(resolve(dir, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

export function appendJsonl(file, record) {
  ensureDir(dirname(file))
  const previous = readText(file)
  const line = `${JSON.stringify(record)}\n`
  atomicWriteText(file, previous.endsWith('\n') || previous === '' ? `${previous}${line}` : `${previous}\n${line}`)
}

/** Parse a JSON-lines file, keeping valid records and reporting skipped lines. */
export function readJsonl(file) {
  const records = []
  const problems = []
  const text = readText(file)
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      problems.push(`第 ${index + 1} 行不是合法 JSON`)
    }
  }
  return { records, problems }
}

export function fileSha256(file) {
  try {
    return sha256(readFileSync(file))
  } catch {
    return null
  }
}

export function randomId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomBytes(3).toString('hex')}`
}

/** Trim and collapse whitespace, then cap length for tool output. */
export function compact(value, max = 280) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

export function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))]
}

export function defaultWorkHome() {
  const dshHome = process.env.DSH_HOME || resolve(homedir(), '.dsh')
  return resolve(dshHome, 'work')
}

/**
 * Compile scope patterns into testers.
 *
 * - `src/**`   → glob
 * - `src/`     → directory prefix
 * - `src`      → that path and everything below it
 * - empty list → nothing is allowed (an empty allow-list is never "unlimited")
 */
export function compileScope(patterns) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((raw) => normalizeRel(raw))
    .filter((value) => value !== '')
    .map((pattern) => {
      if (pattern.endsWith('/')) {
        const prefix = pattern
        return { pattern, test: (path) => path.startsWith(prefix) }
      }
      if (!/[*?]/.test(pattern)) {
        return {
          pattern,
          test: (path) => path === pattern || path.startsWith(`${pattern}/`),
        }
      }
      return { pattern, test: globTest(pattern) }
    })
}

function globTest(pattern) {
  const source = `^${pattern
    .split('')
    .map((char, index) => {
      if (char === '*') {
        if (pattern[index + 1] === '*') return '\u0000'
        return '[^/]*'
      }
      if (char === '?') return '[^/]'
      return char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
    .replace(/\u0000\/?/g, '.*')}$`
  const regex = new RegExp(source)
  return (path) => regex.test(path)
}

export function matchesAny(path, compiled) {
  return compiled.some((entry) => entry.test(path))
}

/** A command that proves nothing on its own: it must never count above Q0. */
export function isPlaceholderCommand(command) {
  const text = String(command ?? '').trim()
  if (text === '') return true
  return [
    /^true$/i,
    /^exit\s+0?$/i,
    /^echo\s+(ok|pass|success|done)\s*$/i,
    /assert\s+true/i,
    /^python\s+-c\s+["']?assert\s+true/i,
    /^node\s+-e\s+["']?(true|console\.log\(["']ok["']\))/i,
  ].some((pattern) => pattern.test(text))
}

/** Is `value` a plain object (not an array, not null)? */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
