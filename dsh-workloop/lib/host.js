/**
 * Host evidence: command results observed by the DSH host itself.
 *
 * The plugin listens on `tools/post-execute` and keeps a bounded, in-memory
 * log of finished foreground shell calls (command, exit code, output tail).
 * Command-based evidence can only rise above Q1 when it is backed by one of
 * these captures; numbers typed by the model are treated as self-reported.
 *
 * Captures live in process memory only: a host restart forgets them, which is
 * the honest failure mode (evidence falls back to self-reported, Q1).
 */
import { createHash } from 'node:crypto'

export const DEFAULT_CAPTURE_TOOLS = ['bash']
const TAIL = 4000

function tail(text) {
  const value = typeof text === 'string' ? text : ''
  return value.length > TAIL ? value.slice(-TAIL) : value
}

function streamText(stream) {
  if (typeof stream === 'string') return stream
  return typeof stream?.text === 'string' ? stream.text : ''
}

/**
 * Parse an executed-test count from common runner summaries. Returns null when
 * nothing recognisable is printed; callers must not invent a number.
 */
export function parseTestCount(text) {
  const value = String(text ?? '')
  const patterns = [
    /ℹ tests (\d+)/, // node --test (spec reporter)
    /^# tests (\d+)/m, // node --test (tap reporter)
    /Tests:\s+(?:\d+ failed, )?(\d+) passed/, // jest
    /Tests\s+(\d+) passed/, // vitest
    /(\d+) passed(?:,|\s|$)/, // pytest
    /Ran (\d+) tests? in/, // unittest
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

/** Normalize a command for matching: trim and collapse whitespace. */
export function normalizeCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ')
}

/**
 * Build a capture from a post-execute (exec, result) pair, or null when the
 * call is not a finished foreground shell command.
 */
export function captureFrom(exec, result, tools = DEFAULT_CAPTURE_TOOLS) {
  if (!exec || !tools.includes(exec.name)) return null
  if (!result || result.isError) return null
  const value = result.value
  if (value === null || typeof value !== 'object') return null
  if (value.kind !== undefined && value.kind !== 'foreground') return null
  if (!Number.isInteger(value.exitCode)) return null
  const command = normalizeCommand(exec.args?.command ?? exec.arguments?.command)
  if (command === '') return null
  const stdout = streamText(value.stdout)
  const stderr = streamText(value.stderr)
  return {
    tool: exec.name,
    callId: String(exec.callId ?? exec.rootCallId ?? ''),
    command,
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    exitCode: value.exitCode,
    timedOut: value.timedOut === true,
    aborted: value.aborted === true,
    tests: parseTestCount(`${stdout}\n${stderr}`),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    outputSha256: createHash('sha256').update(stdout).update('\0').update(stderr).digest('hex'),
  }
}

export class HostCaptureLog {
  constructor({ max = 50 } = {}) {
    this.max = max
    this.bySession = new Map()
    this.counter = 0
  }

  add(session, capture) {
    const key = String(session || '')
    this.counter += 1
    const record = { id: `HX-${this.counter}`, at: new Date().toISOString(), session: key, ...capture }
    const list = this.bySession.get(key) ?? []
    list.push(record)
    while (list.length > this.max) list.shift()
    this.bySession.set(key, list)
    return record
  }

  list(session) {
    return [...(this.bySession.get(String(session || '')) ?? [])]
  }

  /** Resolve by explicit captureId, else the latest capture with the same command. */
  resolve(session, { captureId, command } = {}) {
    const list = this.bySession.get(String(session || '')) ?? []
    if (captureId) return list.find((item) => item.id === captureId) ?? null
    const wanted = normalizeCommand(command)
    if (wanted === '') return null
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].command === wanted) return list[index]
    }
    return null
  }
}
