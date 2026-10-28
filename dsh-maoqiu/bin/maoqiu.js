#!/usr/bin/env node
// Maintenance CLI deliberately keeps runtime mutations in DSH's one writer.
import { MaoqiuStore } from '../lib/store.js';
import { defaultHome } from '../lib/index.js';
import { backupSpace, restoreSpace } from '../lib/backup.js';

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
    else if (command === 'recall') result = await store.recall({ query: rest.join(' '), mode: 'work' });
    else if (command === 'help' || command === '--help') result = {
      usage: 'node bin/maoqiu.js [--home ABS] init|status|privacy|recall <话题>|backup --to ABS_DIR|restore --from ABS_DIR',
      note: 'init只创建空的必要数据文件和隐私标记；privacy为已有空间补写 .gitignore/.nobackup（不覆盖）；backup/restore只显式维护整个空间，恢复不会覆盖已有非空目录；运行时修改请使用DSH毛球工具。',
    };
    else throw new Error('未知命令：' + command);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
