import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('a clean work process imports neither the art modules nor the old kaomoji pool', () => {
  const trace = join(mkdtempSync(join(tmpdir(), 'text-art-import-')), 'imports.txt')
  const root = new URL('../index.js', import.meta.url).href
  const source = `
    import { apply } from ${JSON.stringify(root)};
    const work = {session:{header:{agentPreset:'standard'}},ctx:{inject(){throw Error('unexpected work mount')}}};
    apply({inject(deps,callback){callback({agents:{list:()=>[work]},on(){},effect(){}})}},{});
  `
  const child = spawnSync(process.execPath, ['--experimental-loader', new URL('../scripts/fixtures/import-trace.mjs', import.meta.url).href, '--input-type=module', '--eval', source], {
    env: { ...process.env, TEXT_ART_IMPORT_TRACE: trace }, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(child.status, 0, child.stderr)
  const imports = readFileSync(trace, 'utf8')
  assert.ok(imports.includes(root))
  assert.doesNotMatch(imports, /\/art\/|\/kaomoji\.js|\/pool\.js/)
})
