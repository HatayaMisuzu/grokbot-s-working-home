/**
 * Test helpers: temporary work homes, fake workspaces and a fake Cordis ctx
 * that mirrors the API surface the plugin actually uses.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

export function tempDir(prefix = 'workloop-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Create a workspace with the given relative files. */
export function makeWorkspace(files = {}) {
  const root = tempDir('workloop-ws-')
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

export function makeAgent(cwd, { subagent = false, id = 'agent-1', session = 'session-1', parentSession = 'session-1' } = {}) {
  const header = subagent
    ? { id: session, cwd, origin: 'subagent', parentSession }
    : { id: session, cwd }
  return { id, session: { id: session, header } }
}

/** A fake ctx that records registrations and returns disposers. */
export function makeCtx() {
  const tools = []
  const sections = []
  const contexts = []
  const hooks = new Map()
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {}
      },
      context(definition) {
        contexts.push(definition)
        return () => {}
      },
    },
    on(event, handler) {
      hooks.set(event, handler)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  return { ctx, tools, sections, contexts, hooks }
}

/** Boot the plugin against a temp home and return the plugin surface. */
export function bootPlugin({ home = tempDir(), config = {} } = {}) {
  const { ctx, tools, sections, contexts, hooks } = makeCtx()
  const instance = apply(ctx, { home, ...config })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { ...instance, ctx, tools, byName, sections, contexts, hooks }
}

/** Run a tool through its real execute path. */
export async function callTool(byName, name, args, agent) {
  const tool = byName.get(name)
  if (tool === undefined) throw new Error(`tool ${name} 未注册`)
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

/** A host capture as produced by lib/host.js, for grading tests. */
export function hostCaptureFor(command, { exitCode = 0, tests = 3, id = 'HX-1' } = {}) {
  return { id, command, exitCode, tests, timedOut: false, aborted: false, outputSha256: 'x'.repeat(64) }
}
