import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
let checked = 0
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (/\.m?js$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr || String(result.error))
      checked++
    } else if (entry.name.endsWith('.json')) JSON.parse(await readFile(path, 'utf8'))
  }
}
await walk(root)
console.log(`Syntax and JSON check passed (${checked} JavaScript files).`)
