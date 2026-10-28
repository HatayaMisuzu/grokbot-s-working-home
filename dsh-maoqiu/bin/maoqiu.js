#!/usr/bin/env node
// Maintenance CLI deliberately keeps runtime mutations in DSH's one writer.
import { MaoqiuStore } from '../lib/store.js';
import { defaultHome } from '../lib/index.js';
import { backupSpace, restoreSpace } from '../lib/backup.js';
import { buildHomeView, renderHtml, renderMarkdown, renderText } from '../lib/home-view.js';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
let home = defaultHome();
const at = args.indexOf('--home');
if (at >= 0) { home = args[at + 1]; args.splice(at, 2); if (!home) throw new Error('--home 需要绝对路径'); }
const [command = 'help', ...rest] = args;
function option(values, name) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  values.splice(index, 2);
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要绝对路径`);
  return value;
}
try {
  let result;
  if (command === 'backup') {
    const target = option(rest, '--to');
    if (rest.length || !target) throw new Error('用法：node bin/maoqiu.js [--home ABS] backup --to ABS_DIR');
    result = await backupSpace(home, target);
  } else if (command === 'restore') {
    const source = option(rest, '--from');
    if (rest.length || !source) throw new Error('用法：node bin/maoqiu.js [--home ABS] restore --from ABS_DIR');
    result = await restoreSpace(home, source);
  } else {
    const store = new MaoqiuStore(home);
    if (command === 'init') result = await store.init();
    else if (command === 'status') result = await store.status();
    else if (command === 'privacy') result = await store.ensurePrivacyMarkers();
    else if (command === 'verify') result = await store.verifyJournal();
    else if (command === 'show') {
      if (rest.length !== 1) throw new Error('用法：node bin/maoqiu.js [--home ABS] show <notes/...|drafts/...|collections/...>');
      const read = await store.space({ action: 'read', path: rest[0] });
      if (!read.ok) result = read;
      else { process.stdout.write(read.content.endsWith('\n') ? read.content : `${read.content}\n`); result = undefined; }
    } else if (command === 'view') {
      const format = rest.includes('--text') ? 'text' : rest.includes('--md') ? 'md' : 'html';
      for (const flag of ['--text', '--md']) { const i = rest.indexOf(flag); if (i >= 0) rest.splice(i, 1); }
      const noteAt = rest.indexOf('--note'); let note = '';
      if (noteAt >= 0) { note = rest[noteAt + 1] || ''; rest.splice(noteAt, 2); }
      const nowAt = rest.indexOf('--now'); let now;
      if (nowAt >= 0) { now = Date.parse(rest[nowAt + 1]); rest.splice(nowAt, 2); if (!Number.isFinite(now)) throw new Error('--now 需要日期时间'); }
      const out = option(rest, '--out');
      if (rest.length) throw new Error('用法：node bin/maoqiu.js [--home ABS] view [--text|--md] [--out ABS_FILE] [--note 文字] [--now 时间]');
      if (!(await store._isAvailable())) throw new Error('毛球空间不可用或未初始化');
      const view = await buildHomeView(store, { now, note });
      const body = format === 'text' ? renderText(view) : format === 'md' ? renderMarkdown(view) : renderHtml(view);
      if (format !== 'html' && !out) { process.stdout.write(body); result = undefined; }
      else {
        const target = out ? (isAbsolute(out) ? out : resolve(out)) : join(await mkdtemp(join(tmpdir(), 'maoqiu-view-')), 'maoqiu-home.html');
        if (resolve(target).toLowerCase().startsWith(resolve(home).toLowerCase())) throw new Error('视图文件不要写进毛球空间本身');
        await writeFile(target, body, 'utf8');
        result = { ok: true, command: 'view', format, file: target, private_items: view.curtain.items.length, note: '只读快照，含私密角原文；只在本机查看' };
      }
    }
    else if (command === 'recall') result = await store.recall({ query: rest.join(' '), mode: 'work' });
    else if (command === 'help' || command === '--help') result = {
      usage: 'node bin/maoqiu.js [--home ABS] init|status|privacy|verify|show <路径>|view [--text|--md] [--out ABS_FILE]|recall <话题>|backup --to ABS_DIR|restore --from ABS_DIR',
      note: 'init只创建空的必要数据文件和隐私标记；privacy为已有空间补写 .gitignore/.nobackup（不覆盖）；backup/restore只显式维护整个空间，恢复不会覆盖已有非空目录；运行时修改请使用DSH毛球工具。',
    };
    else throw new Error('未知命令：' + command);
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
