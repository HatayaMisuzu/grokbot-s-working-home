/** Isolated real DSH Host + scripted LLM. Never uses real credentials or user space. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('../', import.meta.url))
const entry = process.env.DSH_ENTRY || process.argv[2]
if (!entry) throw new Error('设置 DSH_ENTRY 为实际 DSH lib/bin.js 路径，或作为第一个参数传入；无需真实 API key。')
const root = await mkdtemp(join(tmpdir(), 'text-art-dsh-'))
const dshHome = join(root, 'home'), workspace = join(root, 'workspace')
const profile = join(dshHome, 'profiles', 'text-art-smoke'), modules = join(profile, 'node_modules')
const reportPath = join(root, 'report.json'), evidence = join(root, 'requests.jsonl'), done = join(root, 'done')
await mkdir(modules, { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'AGENTS.md'), 'Temporary isolated character-art transport test. Follow only the test messages.\n')
const pluginDir = join(modules, '@local', 'kaomoji-pool')
await cp(pkg, pluginDir, { recursive: true, filter: source => !relative(pkg, source).split(/[\\/]/).some(part => part === 'node_modules' || part.startsWith('.')) })
const dependencies = { '@local/kaomoji-pool': '2.0.1', 'text-art-smoke-model': '1.0.0', 'text-art-smoke-probe': '1.0.0' }
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/kaomoji-pool']
for (const name of ['model', 'probe']) {
  const dir = join(modules, 'text-art-smoke-' + name)
  await mkdir(dir, { recursive: true })
  await cp(join(pkg, 'scripts', 'fixtures', name + '.mjs'), join(dir, 'index.mjs'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'text-art-smoke-' + name, version: '1.0.0', type: 'module', exports: './index.mjs' }))
}
const maoqiuDir = process.env.DSH_MAOQIU_BUNDLE
if (maoqiuDir) {
  await cp(resolve(maoqiuDir), join(modules, '@local', 'dsh-maoqiu-mode'), { recursive: true })
  dependencies['@local/dsh-maoqiu-mode'] = '1.0.1'
  bundles.push('@local/dsh-maoqiu-mode')
}
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-text-art-smoke', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2))
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const patch = [
  { id: 'agent-default-model', config: { provider: 'text-art-smoke', model: 'scripted-transport-only' } },
  { insert: [
    { id: 'text-art-smoke-model', name: 'text-art-smoke-model', config: { evidence } },
    ...maoqiuDir ? [] : [{ id: 'preset-maoqiu', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'maoqiu', name: '测试毛球', plugins: [] } }],
    { id: 'text-art-smoke-probe', name: 'text-art-smoke-probe', config: { workspace, report: reportPath, done, original: join(root, 'original.md'), edited: join(root, 'edited.md') } },
  ] },
]
const patchPath = join(root, 'smoke.patch.json')
await writeFile(patchPath, JSON.stringify(patch, null, 2))
const env = {}
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG'])
  if (process.env[key]) env[key] = process.env[key]
env.DSH_HOME = dshHome
env.DSH_TELEMETRY_DISABLED = '1'
const child = spawn(process.env.DSH_NODE || process.execPath, [resolve(entry), '--profile', 'text-art-smoke', '--patch', patchPath, '--no-open', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let output = ''
child.stdout.on('data', data => { output = (output + data.toString()).slice(-60000) })
child.stderr.on('data', data => { output = (output + data.toString()).slice(-60000) })
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
try {
  const start = Date.now()
  while (true) {
    try { await readFile(done); break } catch { /* wait for our probe */ }
    if (child.exitCode !== null) throw new Error(`Host exited: ${child.exitCode}`)
    if (Date.now() - start > 90000) throw new Error('Host smoke timed out')
    await sleep(100)
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.equal(report.ok, true, report.error)
  assert.equal(report.errors.length, 0)
  const requests = (await readFile(evidence, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(requests.some(request => request.marker === 'ART_DRAW' && request.tools.includes('text_art')))
  assert.ok(requests.some(request => request.marker === 'ART_WORK' && !request.tools.includes('text_art')))
  const result = { ...report, runtime: JSON.parse(await readFile(join(dirname(dirname(resolve(entry))), 'package.json'), 'utf8')).version, scriptedModel: true, realModelQualityTested: false, actualMaoqiuBundle: Boolean(maoqiuDir), evidenceDirectory: root }
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await writeFile(join(root, 'host.log'), output)
  console.error(output)
  console.error(`隔离验收目录：${root}`)
  throw error
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), sleep(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}
