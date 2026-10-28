/**
 * Lightweight structural check: package shape, tool inventory, patch row,
 * no external dependencies. Run with `node scripts/check.mjs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const problems = []
const notes = []

function read(relativePath) {
  try {
    return readFileSync(join(root, relativePath), 'utf8')
  } catch {
    problems.push(`缺少文件：${relativePath}`)
    return ''
  }
}

const pkg = JSON.parse(read('package.json') || '{}')
if (pkg.name !== '@local/workloop') problems.push(`package.name 应为 @local/workloop，实际 ${pkg.name}`)
if (pkg.version !== '0.2.0') problems.push(`package.version 应为 0.2.0，实际 ${pkg.version}`)
if (pkg.type !== 'module') problems.push('package.type 必须是 module')
if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length > 0) {
  problems.push('插件不应有运行时依赖')
}
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('package.dsh.bundle.patch 未指向 cordis.patch.yml')

for (const locale of ['zh', 'en']) {
  const parsed = JSON.parse(read(`locale/${locale}.json`) || '{}')
  if (!parsed.meta?.title || !parsed.meta?.description) problems.push(`locale/${locale}.json 缺少 meta.title/description`)
}

const patch = read('cordis.patch.yml')
if (!/id:\s*workloop/.test(patch)) problems.push('cordis.patch.yml 缺少 id: workloop')
if (!/name:\s*'@local\/workloop'/.test(patch)) problems.push('cordis.patch.yml 缺少 name: @local/workloop')

const { buildTools } = await import('../lib/tools.js')
const { WorkloopStore } = await import('../lib/store.js')
const { guidanceText } = await import('../lib/guidance.js')

const tools = buildTools(new WorkloopStore(join(root, '.check-home')), { enrich: async (args) => args })
const expected = [
  'work_action',
  'work_claim',
  'work_contract',
  'work_evidence',
  'work_learn',
  'work_notice',
  'work_verdict',
]
const names = tools.map((tool) => tool.name).sort()
if (JSON.stringify(names) !== JSON.stringify(expected)) problems.push(`工具集合不一致：${names.join(',')}`)

for (const tool of tools) {
  if (!tool.name.startsWith('work_')) problems.push(`${tool.name} 命名缺少 work_ 前缀`)
  if (!tool.description || tool.description.length < 40) problems.push(`${tool.name} 描述过短`)
  if (tool.parameters?.type !== 'object') problems.push(`${tool.name} parameters 必须是 object schema`)
  if (!Array.isArray(tool.parameters?.required) || !tool.parameters.required.includes('action')) {
    problems.push(`${tool.name} 必须要求 action 参数`)
  }
  if (typeof tool.execute !== 'function') problems.push(`${tool.name} 缺少 execute`)
  if (tool.output?.schema === undefined) problems.push(`${tool.name} 缺少 output.schema`)
}

const guidance = guidanceText()
if (guidance.length > 1600) problems.push(`系统提示过长：${guidance.length} 字符`)
for (const phrase of ['Q0', 'PASS', '毛球空间']) {
  if (!guidance.includes(phrase)) problems.push(`系统提示缺少关键边界词：${phrase}`)
}

for (const file of ['README.md', 'icon.svg', 'lib/index.js', 'lib/guidance.js']) {
  if (!statSync(join(root, file), { throwIfNoEntry: false })) problems.push(`缺少文件：${file}`)
}

const tests = readdirSync(join(root, 'test')).filter((name) => name.endsWith('.test.js'))
notes.push(`测试文件：${tests.length} 个（${tests.join('、')}）`)

// Guard against accidentally shipping caches or run data.
for (const banned of ['.pytest_cache', '__pycache__', 'runs', 'node_modules']) {
  if (statSync(join(root, banned), { throwIfNoEntry: false })) problems.push(`不应提交目录：${banned}`)
}

if (problems.length > 0) {
  console.error(`检查失败（${problems.length}）：`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

console.log(`检查通过：${tools.length} 个工具，${relative(process.cwd(), root) || '.'} 结构完整`)
for (const note of notes) console.log(`-  ${note}`)
