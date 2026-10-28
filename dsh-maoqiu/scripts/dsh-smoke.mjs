// Real extracted DSH Host + a local mock LLM. No Electron, QQ, network, or paid API.
// The script intentionally creates a temporary profile and Maoqiu home. It never
// reads or writes the user's configured E:/maoqiu_home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(pkg, '..');
const hostRoot = resolve(
  process.env.DSH_HOST_ROOT || join(workspaceRoot, 'work', 'dsh-host'),
);
const hostEntry = resolve(
  process.env.DSH_ENTRY ||
    join(hostRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
);
const nodeBinary = resolve(process.env.DSH_NODE || process.execPath);

const exists = async (path) => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(predicate, timeoutMs, child) {
  const started = Date.now();
  while (!(await predicate())) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`DSH host exited before smoke completion (code=${child.exitCode})`);
    if (Date.now() - started > timeoutMs) throw new Error('DSH smoke timed out');
    await sleep(50);
  }
}

function textOf(content) {
  return (content || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function redact(text) {
  return String(text)
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function safeEnv(dshHome) {
  const env = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.DSH_HOME = dshHome;
  env.DSH_TELEMETRY_DISABLED = '1';
  return env;
}

function packageJson(name, version = '1.0.0') {
  return JSON.stringify(
    {
      name,
      version,
      private: true,
      type: 'module',
      exports: { '.': './index.js' },
    },
    null,
    2,
  ) + '\n';
}

async function writeMockPackages(profileNodeModules, evidence, probe, values) {
  const modelDir = join(profileNodeModules, 'dsh-maoqiu-smoke-model');
  const probeDir = join(profileNodeModules, 'dsh-maoqiu-smoke-probe');
  await mkdir(modelDir, { recursive: true });
  await mkdir(probeDir, { recursive: true });

  const modelSource = `
import { appendFileSync } from 'node:fs';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const evidencePath = ${JSON.stringify(evidence)};
const append = (value) => appendFileSync(evidencePath, JSON.stringify(value) + '\\n');
const text = (options, value) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const tool = (name, args, id) => {
  const argumentsText = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
};
const asText = (message) => {
  if (!message || typeof message !== 'object') return '';
  return (message.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('\\n');
};
const lastUser = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && message?.source?.kind === 'user') return { message, index: i };
  }
  return { message: undefined, index: -1 };
};
const markerOf = (value) => (String(value).match(/SMOKE_[A-Z_]+/) || [])[0] || '';
const valuesOf = (messages) => messages.filter((item) => item.role === 'tool').map((item) => { try { return JSON.parse(asText(item)); } catch { return {}; } });
const batch = (entries) => entries.flatMap(([name, args, id], index) => tool(name, args, id).filter((chunk) => !['finish', 'usage'].includes(chunk.type)).map((chunk) => ({ ...chunk, index }))).concat([{ type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } }, { type: 'finish', reason: { kind: 'tool-calls' } }]);
const calls = {
  SMOKE_SAVE_EXPERIENCE: [
    'maoqiu_experience',
    { action: 'save', title: '蓝灯笼经验', content: '毛球宿主测试：蓝灯笼是相关召回词。模板原文{{missing_variable}}。', scope: 'smoke-blue-lantern', keywords: ['蓝灯笼', '毛球宿主'], status: 'candidate', source: { kind: 'user', ref: 'smoke user instruction' } },
  ],
  SMOKE_RECALL_BLUE: [
    'maoqiu_recall',
    { query: '蓝灯笼', scope: 'smoke-blue-lantern', mode: 'work', limit: 3 },
  ],
  SMOKE_RECALL_UNRELATED: [
    'maoqiu_recall',
    { query: '紫色火车', scope: 'smoke-unrelated', mode: 'work', limit: 3 },
  ],
  SMOKE_WITHDRAW_EXPERIENCE: [
    'maoqiu_experience',
    { action: 'withdraw', id: '__resolved_from_save__' },
  ],
  SMOKE_RECALL_AFTER_WITHDRAW: [
    'maoqiu_recall',
    { query: '蓝灯笼', scope: 'smoke-blue-lantern', mode: 'work', limit: 3 },
  ],
  SMOKE_PLAN_ACTIVITY: [
    'maoqiu_activity',
    { action: 'plan', id: 'activity-smoke', title: '恢复后的草稿活动', summary: '验证暂停后恢复并执行草稿计划。', operation: 'draft', path: 'drafts/smoke-resumed.md', content: '毛球宿主恢复测试草稿。', source: { kind: 'creation', ref: 'DSH smoke activity plan' } },
  ],
  SMOKE_PAUSE_ACTIVITY: ['maoqiu_activity', { action: 'pause', id: 'activity-smoke' }],
  SMOKE_RESUME_ACTIVITY: ['maoqiu_activity', { action: 'resume', id: 'activity-smoke' }],
  SMOKE_RUN_ACTIVITY: ['maoqiu_activity', { action: 'run', id: 'activity-smoke' }],
};

export const name = 'dsh-maoqiu-smoke-model';
export const inject = ['llm'];
export function apply(ctx) {
  class SmokeModel extends LlmAdapter {
    async *stream(options) {
      const messages = options.messages || [];
      const current = lastUser(messages);
      const currentText = asText(current.message);
      const marker = markerOf(currentText);
      const trailing = messages.slice(current.index + 1);
      const hasToolResult = trailing.some((message) => message?.role === 'tool');
      append({
        kind: 'request',
        purpose: options.purpose || null,
        tools: (options.tools || []).map((schema) => schema.name),
        marker,
        messages: messages.map((message) => ({ role: message.role, source: message.source, text: asText(message) })),
      });
      if (options.purpose === 'session-title') {
        for (const chunk of text(options, '毛球宿主测试')) yield chunk;
        return;
      }
      if (marker === 'SMOKE_FREE') {
        const stage = this.freeStage || 0;
        this.freeStage = stage + 1;
        const values = valuesOf(messages);
        let chunks;
        if (stage === 0) chunks = tool('maoqiu_freetime', { action: 'start', seconds: 60 }, 'free-start');
        else if (stage === 1 || stage === 3) chunks = text(options, '这一步先到这里。');
        else if (stage === 2) chunks = batch([
          ['maoqiu_space', { action: 'write', path: 'drafts/free-time.md', content: '第一段', expected_version: 'missing' }, 'free-write'],
          ['maoqiu_object', { action: 'upsert', id: 'free-lamp', expected_version: 'missing', patch: { name: '窗灯', position: '左侧' } }, 'free-lamp'],
          ['maoqiu_object', { action: 'upsert', id: 'free-cup', expected_version: 'missing', patch: { name: '茶杯', position: '桌上' } }, 'free-cup'],
          ['smoke_forbidden', {}, 'free-forbidden'],
        ]);
        else if (stage === 4) chunks = batch([
          ['maoqiu_space', { action: 'append', path: 'drafts/free-time.md', content: '\\n第二段', expected_version: values.findLast((value) => value.path === 'drafts/free-time.md').version }, 'free-append'],
          ['maoqiu_object', { action: 'upsert', id: 'free-lamp', expected_version: values.findLast((value) => value.object?.id === 'free-lamp').version, patch: { position: '右侧' } }, 'free-move'],
        ]);
        else chunks = tool('maoqiu_freetime', { action: 'finish' }, 'free-finish');
        for (const chunk of chunks) yield chunk;
        return;
      }
      if (marker === 'SMOKE_FREE_RESTORE') {
        const stage = this.restoreStage || 0;
        this.restoreStage = stage + 1;
        const values = valuesOf(messages);
        let chunks;
        if (stage === 0) chunks = batch([
          ['maoqiu_history', { action: 'list', path: 'drafts/free-time.md' }, 'restore-file-list'],
          ['maoqiu_history', { action: 'list', object_id: 'free-lamp' }, 'restore-object-list'],
        ]);
        else if (stage === 1) chunks = batch([
          ['maoqiu_history', { action: 'restore', path: 'drafts/free-time.md', history_id: values.findLast((value) => value.history && value.path === 'drafts/free-time.md').history[0].history_id, expected_version: values.findLast((value) => value.path === 'drafts/free-time.md' && value.version).version }, 'restore-file'],
          ['maoqiu_history', { action: 'restore', object_id: 'free-lamp', history_id: values.findLast((value) => value.history && value.object_id === 'free-lamp').history[0].history_id, expected_version: values.findLast((value) => value.object?.id === 'free-lamp').version }, 'restore-object'],
        ]);
        else chunks = text(options, '已恢复所选内容。');
        for (const chunk of chunks) yield chunk;
        return;
      }
      if (marker === 'SMOKE_FREE_INTERRUPT') {
        const stage = this.interruptStage || 0;
        this.interruptStage = stage + 1;
        const chunks = stage === 0
          ? tool('maoqiu_freetime', { action: 'start', seconds: 60 }, 'interrupt-start')
          : tool('maoqiu_space', { action: 'write', path: 'drafts/interrupted.md', content: '迟到结果', expected_version: 'missing' }, 'interrupt-write');
        for (const chunk of chunks) yield chunk;
        return;
      }
      if (!hasToolResult && calls[marker]) {
        let [name, args] = calls[marker];
        if (marker === 'SMOKE_WITHDRAW_EXPERIENCE') {
          let id;
          for (const message of messages) {
            if (message?.role !== 'tool') continue;
            try {
              const value = JSON.parse(asText(message));
              if (value?.experience?.id) id = value.experience.id;
            } catch {}
          }
          if (!id) throw new Error('smoke could not resolve the saved experience id for withdraw');
          args = { action: 'withdraw', id };
        }
        const id = 'smoke-' + marker.toLowerCase();
        for (const chunk of tool(name, args, id)) yield chunk;
        return;
      }
      for (const chunk of text(options, 'DSH 毛球宿主 smoke 已完成该步骤。')) yield chunk;
    }
  }
  ctx.llm.registerAdapter(['maoqiu-smoke'], new SmokeModel());
}
`;

const probeSource = `
import { appendFileSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { MaoqiuStore } from ${JSON.stringify(pathToFileURL(join(values.pluginDir, 'lib', 'store.js')).href)};

const config = ${JSON.stringify(values)};
export const name = 'dsh-maoqiu-smoke-probe';
export const inject = ['agents', 'sessionController', 'tools', 'systemPrompt', 'agentDefaultModel'];
const fail = (error) => ({ ok: false, error: String(error?.stack || error) });
const text = (value) => ({ type: 'text', text: value });
const message = (value, id) => ({ id, role: 'user', source: { kind: 'user' }, content: [text(value)] });
const save = async (value) => writeFile(config.probePath, JSON.stringify(value, null, 2) + '\\n');
const steps = [];
export function apply(ctx) {
  const errors = [];
  let forbiddenExecutions = 0;
  ctx.effect(() => ctx.tools.register({ name: 'smoke_forbidden', description: 'smoke forbidden capability', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'forbidden' }] }, execute: () => { forbiddenExecutions++; return {}; } }));
  ctx.on('agent/error', ({ agent, error }) => {
    errors.push({ agent: agent?.id || null, error: String(error?.stack || error) });
  });
  async function run() {
  const defaultModel = ctx.agentDefaultModel?.currentSelection?.() || null;
  steps.push({ name: 'default-model', defaultModel });
  const sessionId = 'maoqiu-smoke-session';
  const created = await ctx.sessionController.create({ sessionId, cwd: config.workspace });
  const resolved = await ctx.sessionController.resolveAgent(sessionId);
  if (!resolved?.agent) throw new Error('sessionController.resolveAgent did not return an agent');
  const agent = resolved.agent;
  const toolSchemas = ctx.tools.schemas(agent);
  const toolNames = toolSchemas.map((schema) => schema.name).filter(Boolean);
  steps[0] = { name: 'tool-schemas', toolNames };
  if (ctx.agents.get(agent.id) !== agent) throw new Error('agents.get did not return the resolved agent');
  steps.push({ name: 'session', sessionId, agentId: agent.id, cwd: agent.session.header?.cwd || null, created });
  const follow = async (marker) => {
    const topic = marker === 'SMOKE_RECALL_BLUE' || marker === 'SMOKE_RECALL_AFTER_WITHDRAW'
      ? ' 请继续蓝灯笼相关工作。'
      : marker === 'SMOKE_RECALL_UNRELATED' ? ' 讨论紫色火车。' : '';
    agent.followup(message(marker + topic, 'smoke-' + marker.toLowerCase()));
    await agent.whenIdle();
    steps.push({ name: marker, messageCount: agent.session.deriveMessages().length });
  };
  await follow('SMOKE_SAVE_EXPERIENCE');
  await follow('SMOKE_RECALL_BLUE');
  const recallBlueBeforeWithdraw = await new MaoqiuStore(config.home).recall({ query: '蓝灯笼', scope: 'smoke-blue-lantern', mode: 'work', limit: 3 });
  await follow('SMOKE_RECALL_UNRELATED');
  const recallUnrelatedBeforeWithdraw = await new MaoqiuStore(config.home).recall({ query: '紫色火车', scope: 'smoke-unrelated', mode: 'work', limit: 3 });
  await follow('SMOKE_WITHDRAW_EXPERIENCE');
  await follow('SMOKE_RECALL_AFTER_WITHDRAW');
  const recallAfterWithdraw = await new MaoqiuStore(config.home).recall({ query: '蓝灯笼', scope: 'smoke-blue-lantern', mode: 'work', limit: 3 });
  steps.push({ name: 'recall-boundaries', recallBlueBeforeWithdraw, recallUnrelatedBeforeWithdraw, recallAfterWithdraw });
  await follow('SMOKE_PLAN_ACTIVITY');
  await follow('SMOKE_PAUSE_ACTIVITY');
  const reloaded = new MaoqiuStore(config.home);
  const reloadStatus = await reloaded.status();
  const paused = await reloaded.activity({ action: 'read', id: 'activity-smoke' });
  steps.push({ name: 'store-reload', reloadStatus, paused });
  await follow('SMOKE_RESUME_ACTIVITY');
  await follow('SMOKE_RUN_ACTIVITY');
  const finalStatus = await new MaoqiuStore(config.home).status();
  const finalActivity = await new MaoqiuStore(config.home).activity({ action: 'read', id: 'activity-smoke' });
  steps.push({ name: 'final-store', finalStatus, finalActivity });
  const freeSession = await ctx.sessionController.create({ sessionId: 'maoqiu-free-smoke', cwd: config.workspace });
  const freeAgent = (await ctx.sessionController.resolveAgent('maoqiu-free-smoke')).agent;
  freeAgent.followup(message('开始自在时间60秒 SMOKE_FREE', 'free-human-start'));
  let freeState;
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try { freeState = JSON.parse(readFileSync(config.home + '/space/free_time.json', 'utf8')); } catch {}
    if (freeState?.runs?.[0]?.status === 'finished') break;
  }
  await freeAgent.whenIdle();
  const liveStore = new MaoqiuStore(config.home);
  steps.push({ name: 'free-continuation', freeState, forbiddenExecutions, file: await liveStore.space({ action: 'read', path: 'drafts/free-time.md' }), lamp: await liveStore.object({ action: 'read', id: 'free-lamp' }) });
  freeAgent.followup(message('SMOKE_FREE_RESTORE 恢复刚才草稿和小灯的上一个版本', 'free-human-restore'));
  await freeAgent.whenIdle();
  steps.push({ name: 'narrow-restore', file: await liveStore.space({ action: 'read', path: 'drafts/free-time.md' }), lamp: await liveStore.object({ action: 'read', id: 'free-lamp' }), cup: await liveStore.object({ action: 'read', id: 'free-cup' }) });
  let entered = false;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const originalWrite = MaoqiuStore.prototype._writeMaterial;
  MaoqiuStore.prototype._writeMaterial = async function(file, metadata, content) {
    if (file.endsWith('interrupted.md')) { entered = true; await held; }
    return originalWrite.call(this, file, metadata, content);
  };
  try {
    freeAgent.followup(message('开始自在时间60秒 SMOKE_FREE_INTERRUPT', 'interrupt-human-start'));
    for (let attempt = 0; attempt < 200 && !entered; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!entered) throw new Error('native interrupt write was never reached');
    freeAgent.followup(message('SMOKE_AFTER_INTERRUPT 用户回来了，先处理前台消息', 'interrupt-human-priority'));
    release();
    await freeAgent.whenIdle();
    steps.push({ name: 'user-preemption', state: JSON.parse(readFileSync(config.home + '/space/free_time.json', 'utf8')), file: await liveStore.space({ action: 'read', path: 'drafts/interrupted.md' }), foregroundHandled: freeAgent.session.deriveMessages().some((item) => item.id === 'interrupt-human-priority') });
  } finally { release(); MaoqiuStore.prototype._writeMaterial = originalWrite; }
  await save({ ok: true, steps, errors });
  await writeFile(config.donePath, JSON.stringify({ ok: true }) + '\\n');
  }
  Promise.resolve().then(run).catch(async (error) => {
    await save({ ok: false, steps, errors, error: String(error?.stack || error) });
    await writeFile(config.donePath, JSON.stringify({ ok: false }) + '\\n');
  });
}
`;

  await writeFile(join(modelDir, 'package.json'), packageJson('dsh-maoqiu-smoke-model'));
  await writeFile(join(modelDir, 'index.js'), modelSource);
  await writeFile(join(probeDir, 'package.json'), packageJson('dsh-maoqiu-smoke-probe'));
  await writeFile(join(probeDir, 'index.js'), probeSource);
  return { modelDir, probeDir };
}

const root = await mkdtemp(join(tmpdir(), 'maoqiu-dsh-smoke-'));
const dshHome = join(root, 'dsh-home');
const maoqiuHome = join(root, 'maoqiu-home');
const workspace = join(root, 'workspace');
const profile = join(dshHome, 'profiles', 'maoqiu-smoke');
const profileNodeModules = join(profile, 'node_modules');
const evidence = join(root, 'mock-requests.jsonl');
const probePath = join(root, 'probe.json');
const donePath = join(root, 'done.json');
const patchPath = join(root, 'smoke.patch.json');
const reportPath = resolve(
  process.env.MAOQIU_DSH_SMOKE_REPORT || join(workspaceRoot, 'work', 'dsh-smoke-report.json'),
);
let child;
let output = '';
let passed = false;

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(profileNodeModules, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  await mkdir(maoqiuHome, { recursive: true });
  await writeFile(
    join(workspace, 'AGENTS.md'),
    'Temporary DSH Maoqiu smoke workspace. Follow only the explicit test prompt.\n',
  );

  if (!(await exists(hostEntry))) {
    throw new Error(
      `纯 Node DSH 宿主不存在：${hostEntry}。先将 app.asar 提取到 work/dsh-host，或设置 DSH_HOST_ROOT/DSH_ENTRY。`,
    );
  }
  const { MaoqiuStore } = await import(pathToFileURL(join(pkg, 'lib', 'store.js')).href);
  const initial = await new MaoqiuStore(maoqiuHome).init();
  assert.equal(initial.ok, true, 'temporary Maoqiu home initialization failed');

  const pluginDir = join(profileNodeModules, 'dsh-maoqiu');
  await cp(pkg, pluginDir, { recursive: true });
  const generated = await writeMockPackages(profileNodeModules, evidence, probePath, {
    pluginDir,
    home: maoqiuHome,
    workspace,
    probePath,
    donePath,
    agents: null,
    sessionController: null,
    tools: null,
  });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-maoqiu-smoke',
        private: true,
        dependencies: {
          'dsh-maoqiu': JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version,
          'dsh-maoqiu-smoke-model': '1.0.0',
          'dsh-maoqiu-smoke-probe': '1.0.0',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(
    join(profile, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  );
  await writeFile(
    patchPath,
    JSON.stringify(
      [
        { id: 'agent-default-model', config: { provider: 'maoqiu-smoke', model: 'smoke-model' } },
        {
          insert: [
            { id: 'maoqiu-smoke-model', name: 'dsh-maoqiu-smoke-model' },
            { id: 'maoqiu', name: 'dsh-maoqiu', config: { home: maoqiuHome, autoRecall: true } },
            { id: 'maoqiu-smoke-probe', name: 'dsh-maoqiu-smoke-probe', config: { ...generated, home: maoqiuHome, workspace, probePath, donePath, pluginDir } },
          ],
        },
      ],
      null,
      2,
    ) + '\n',
  );

  child = spawn(
    nodeBinary,
    [hostEntry, '--profile', 'maoqiu-smoke', '--patch', patchPath, '--no-open', '--port', '0'],
    { cwd: root, env: safeEnv(dshHome), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-100000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-100000);
  });

  await waitFor(() => exists(donePath), 90000, child);
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  assert.equal(probe.ok, true, probe.error || 'probe failed');
  assert.equal(
    probe.errors?.length || 0,
    0,
    `native Agent errors (this DSH version may not support async systemPrompt.context): ${JSON.stringify(probe.errors)}`,
  );
  const requests = (await readFile(evidence, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const toolNames = probe.steps.find((step) => step.name === 'tool-schemas')?.toolNames || [];
  for (const name of ['maoqiu_recall', 'maoqiu_experience', 'maoqiu_interest', 'maoqiu_space', 'maoqiu_activity', 'maoqiu_object', 'maoqiu_history', 'maoqiu_freetime'])
    assert.ok(toolNames.includes(name), `missing live DSH tool schema: ${name}`);
  assert.ok(requests.some((request) => request.tools.includes('maoqiu_experience')));
  assert.ok(requests.some((request) => request.tools.includes('maoqiu_activity')));
  const toolErrors = requests
    .flatMap((request) => request.messages || [])
    .filter((message) => message.role === 'tool' && !['free-forbidden', 'interrupt-write'].includes(message.source?.callId) && /^Error: tool /.test(message.text || ''));
  assert.equal(toolErrors.length, 0, `native tool calls returned errors: ${JSON.stringify(toolErrors)}`);
  const relevant = requests.find((request) => request.marker === 'SMOKE_RECALL_BLUE');
  const unrelated = requests.find((request) => request.marker === 'SMOKE_RECALL_UNRELATED');
  const afterWithdraw = requests.find((request) => request.marker === 'SMOKE_RECALL_AFTER_WITHDRAW');
  assert.ok(relevant, 'mock model did not receive the relevant recall turn');
  assert.ok(unrelated, 'mock model did not receive the unrelated recall turn');
  assert.ok(afterWithdraw, 'mock model did not receive the post-withdraw recall turn');
  const runtimeText = (request) =>
    request.messages
      .filter((message) => message.source?.kind === 'runtime-context')
      .at(-1)?.text || '';
  assert.match(runtimeText(relevant), /蓝灯笼|smoke-blue-lantern/);
  assert.match(runtimeText(relevant), /\{\{missing_variable\}\}/);
  assert.doesNotMatch(runtimeText(unrelated), /蓝灯笼经验|smoke-blue-lantern/);
  assert.doesNotMatch(runtimeText(afterWithdraw), /蓝灯笼经验|smoke-blue-lantern/);
  const storeStep = probe.steps.find((step) => step.name === 'store-reload');
  assert.equal(storeStep?.paused?.activity?.status, 'paused');
  const boundaries = probe.steps.find((step) => step.name === 'recall-boundaries');
  assert.ok(boundaries?.recallBlueBeforeWithdraw?.experiences?.length);
  assert.equal(boundaries?.recallUnrelatedBeforeWithdraw?.experiences?.length, 0);
  assert.equal(boundaries?.recallAfterWithdraw?.experiences?.length, 0);
  const final = probe.steps.find((step) => step.name === 'final-store');
  assert.equal(final?.finalActivity?.activity?.status, 'completed');
  assert.equal(final?.finalActivity?.activity?.result?.verified, true);
  const draft = await readFile(join(maoqiuHome, 'space', 'drafts', 'smoke-resumed.md'), 'utf8');
  assert.match(draft, /恢复测试草稿/);
  const freeStep = probe.steps.find((step) => step.name === 'free-continuation');
  assert.equal(freeStep?.freeState?.runs?.[0]?.status, 'finished', JSON.stringify(freeStep));
  assert.equal(freeStep.freeState.runs[0].usage.decisions, 6);
  assert.equal(freeStep.file.content, '第一段\n第二段');
  assert.equal(freeStep.lamp.object.position, '右侧');
  assert.equal(freeStep.forbiddenExecutions, 0);
  const freeRequests = requests.filter((request) => request.marker === 'SMOKE_FREE');
  assert.ok(freeRequests.some((request) => request.messages.some((message) => message.source?.kind === 'maoqiu-freetime')));
  assert.ok(freeRequests.slice(1).every((request) => !request.tools.includes('smoke_forbidden') && !request.tools.includes('maoqiu_experience')));
  const restored = probe.steps.find((step) => step.name === 'narrow-restore');
  assert.equal(restored.file.content, '第一段');
  assert.equal(restored.lamp.object.position, '左侧');
  assert.equal(restored.cup.object.position, '桌上');
  const interrupted = probe.steps.find((step) => step.name === 'user-preemption');
  assert.equal(interrupted.file.exists, false);
  assert.equal(interrupted.foregroundHandled, true);
  assert.equal(interrupted.state.runs.at(-1).status, 'paused');
  assert.equal(interrupted.state.runs.at(-1).stop_reason, 'user-arrived');
  assert.ok(requests.flatMap((request) => request.messages).some((message) => message.source?.callId === 'interrupt-write' && /aborted/.test(message.text)));

  const report = {
    passed: true,
    node: process.version,
    dshEntry: hostEntry,
    checks: [
      '纯 Node 启动从 app.asar 提取的真实 DSH Web Host',
      '临时 DSH_HOME/profile 与临时毛球空间初始化',
      '真实 Cordis 挂载毛球插件并读取 live tool schemas',
      '原生 sessionController.create/resolveAgent 与 agents.get',
      '原生 Agent 调用 maoqiu_experience 并自动相关召回',
      '无关话题未带入相关经验',
      '撤回经验后真实 Agent 后续上下文与显式召回均为空',
      '新 MaoqiuStore 实例读取暂停活动并在恢复后执行草稿',
      'pre-step异步准备与同步context provider的相关/无关请求差异',
      '一条用户授权后两次原生 idle 续接，六次有预算的决策，草稿追加与物品移动',
      '真实 agent 工具限制隐藏并阻止越界工具，越界工具主体调用为零',
      '原生工具恢复单份草稿及单件物品，另一件物品不回退',
      '空间工具等待时用户消息中断，迟到内容未写入且前台消息进入模型',
    ],
    realQQ: false,
    paidModelAPI: false,
    externalNetwork: false,
    hostProcess: 'node-only',
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  passed = true;
} catch (error) {
  console.error(error?.stack || error);
  console.error(redact(output));
  console.error(`临时验收现场：${root}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (passed && !process.env.KEEP_SMOKE_DATA) await rm(root, { recursive: true, force: true });
}
