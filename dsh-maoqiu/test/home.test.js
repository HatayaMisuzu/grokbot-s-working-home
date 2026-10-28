import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { defaultHome, WINDOWS_DEFAULT_HOME } from '../lib/home.js'
import { defaultHome as exported } from '../lib/index.js'
import { MaoqiuStore, PRIVACY_MARKERS } from '../lib/store.js'

test('MAOQIU_HOME wins over every platform default', () => {
  assert.equal(defaultHome({ env: { MAOQIU_HOME: '/data/mq', XDG_DATA_HOME: '/x' }, platform: 'linux', home: '/h' }), '/data/mq')
  assert.equal(defaultHome({ env: { MAOQIU_HOME: 'F:/mq' }, platform: 'win32', home: 'C:/Users/u' }), 'F:/mq')
})

test('Windows keeps E:/maoqiu_home', () => {
  assert.equal(WINDOWS_DEFAULT_HOME, 'E:/maoqiu_home')
  assert.equal(defaultHome({ env: { XDG_DATA_HOME: '/x' }, platform: 'win32', home: 'C:/Users/u' }), 'E:/maoqiu_home')
})

test('non-Windows uses absolute XDG_DATA_HOME, else ~/.local/share', () => {
  assert.equal(defaultHome({ env: { XDG_DATA_HOME: '/xdg' }, platform: 'linux', home: '/home/u' }), join('/xdg', 'maoqiu_home'))
  assert.equal(defaultHome({ env: { XDG_DATA_HOME: 'relative' }, platform: 'linux', home: '/home/u' }), join('/home/u', '.local', 'share', 'maoqiu_home'))
  assert.equal(defaultHome({ env: {}, platform: 'darwin', home: () => '/Users/u' }), join('/Users/u', '.local', 'share', 'maoqiu_home'))
})

test('index re-exports the same defaultHome', () => {
  assert.equal(exported, defaultHome)
})

test('init writes privacy markers without overwriting user edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-home-'))
  try {
    const home = join(root, 'space-home')
    const store = new MaoqiuStore(home)
    assert.equal((await store.init()).ok, true)
    for (const [file, content] of Object.entries(PRIVACY_MARKERS)) assert.equal(await readFile(join(home, file), 'utf8'), content)
    assert.match(await readFile(join(home, '.gitignore'), 'utf8'), /^\*$/m)
    assert.equal((await store.status()).ok, true)
    // Re-running init on an initialized space keeps it valid.
    assert.equal((await new MaoqiuStore(home).init()).ok, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('ensurePrivacyMarkers never creates a missing home and skips symlinked roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maoqiu-home-'))
  try {
    const missing = new MaoqiuStore(join(root, 'missing'))
    assert.equal((await missing.ensurePrivacyMarkers()).skipped, true)
    await mkdir(join(root, 'real'))
    try { await symlink(join(root, 'real'), join(root, 'link'), 'dir') } catch { return }
    assert.equal((await new MaoqiuStore(join(root, 'link')).ensurePrivacyMarkers()).skipped, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
