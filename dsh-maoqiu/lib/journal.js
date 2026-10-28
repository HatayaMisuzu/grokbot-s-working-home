import { createHash } from 'node:crypto'
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises'

/**
 * Append-only change journal with a SHA-256 hash chain.
 *
 * It records that a write happened (target, versions, history snapshot,
 * provenance), never the written content, so private text is not copied here.
 * The chain lets `verify` DETECT edits, reordering, removed lines and deleted
 * history snapshots. It cannot PREVENT anyone with file access from changing
 * the files, and cutting lines off the very end is only visible when compared
 * with a previously noted head (seq + hash), which verify prints.
 */
export const JOURNAL_FILE = 'journal.jsonl'
const chains = new Map()

export function entryHash(entry) {
  const { hash, ...rest } = entry
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

async function readLines(file) {
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('变更日志不是普通文件')
    return (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim())
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function tailOf(lines) {
  const last = lines.at(-1)
  try {
    const entry = JSON.parse(last)
    if (Number.isSafeInteger(entry.seq) && typeof entry.hash === 'string') return entry
  } catch {}
  // A damaged tail is kept as is; the next entry still links to something
  // deterministic so verify reports the damage instead of hiding it.
  return { seq: lines.length, hash: `unparsed:${createHash('sha256').update(last).digest('hex')}` }
}

async function write(file, previous, fields) {
  const entry = { seq: previous ? previous.seq + 1 : 1, at: new Date().toISOString(), ...fields, prev_hash: previous ? previous.hash : null }
  entry.hash = entryHash(entry)
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

/** Serialize appends per journal file inside this process. */
export function appendJournal(file, fields) {
  const previous = chains.get(file) || Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const lines = await readLines(file)
    let tail = lines?.length ? tailOf(lines) : null
    if (!tail) tail = await write(file, null, { action: 'journal-start', note: '变更日志从这里开始；更早的变更只有 .history 中被覆盖的旧版本，没有完整记录' })
    return write(file, tail, fields)
  })
  chains.set(file, run)
  run.finally(() => { if (chains.get(file) === run) chains.delete(file) }).catch(() => {})
  return run
}

/**
 * Check the chain and cross-check `.history`: every snapshot named by the
 * journal must still exist, and every snapshot created after the journal
 * started must be named by an entry.
 */
export async function verifyJournal(file, historyDir) {
  const lines = await readLines(file)
  if (!lines) return { ok: true, entries: 0, head: null, problems: [], note: '还没有变更日志（第一次写入时创建）' }
  const problems = []
  const entries = []
  let previous = null
  lines.forEach((line, index) => {
    let entry
    try { entry = JSON.parse(line) } catch { problems.push({ line: index + 1, problem: '不是有效 JSON' }); previous = { seq: index + 1, hash: `unparsed:${createHash('sha256').update(line).digest('hex')}` }; return }
    if (entry.seq !== (previous ? previous.seq + 1 : 1)) problems.push({ line: index + 1, problem: `序号不连续：期望 ${previous ? previous.seq + 1 : 1}，实际 ${entry.seq}` })
    if (entry.prev_hash !== (previous ? previous.hash : null)) problems.push({ line: index + 1, problem: '与上一条的哈希链断开（中间可能被删改或插入）' })
    if (entry.hash !== entryHash(entry)) problems.push({ line: index + 1, problem: '本条内容与哈希不符（被修改过）' })
    if (index === 0 && entry.action !== 'journal-start') problems.push({ line: 1, problem: '开头缺少 journal-start（开头可能被删掉）' })
    entries.push(entry)
    previous = entry
  })
  if (historyDir) {
    const named = new Set(entries.map((entry) => entry.history).filter(Boolean))
    const startedAt = entries[0]?.at ? Date.parse(entries[0].at) : Infinity
    let names = []
    try { names = await readdir(historyDir) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const present = new Set(names)
    for (const name of named) if (!present.has(name)) problems.push({ history: name, problem: '日志记录的历史版本已不存在（可能被删除）' })
    for (const name of names) {
      const stamp = Number(name.split('-')[0])
      if (Number.isFinite(stamp) && stamp >= startedAt && !named.has(name)) problems.push({ history: name, problem: '有历史版本但日志里没有对应记录（日志可能被截断或改写）' })
    }
  }
  const head = previous ? { seq: previous.seq, hash: previous.hash } : null
  return { ok: problems.length === 0, entries: entries.length, head, problems, note: '只能发现改动，不能阻止；末尾被整段截掉时，需要与之前记下的 head 对照才能发现' }
}
