# 毛球成长与独立空间

这是适配 **DeepSeek Harness 0.2.1-rc.3** 的 `dsh-maoqiu 0.3.0` Host 插件。保留 0.2.1 的经验、关注和 preset 适配，新增有期限和预算的连续自在时间、稳定物品和单项恢复。复用 DSH 原生 Agent 循环、取消和工具限制；没有第三方依赖、独立后台进程或额外模型引擎。验收与桌面加载状态见 [`VALIDATION.md`](VALIDATION.md)。

数据默认保存在 `E:\maoqiu_home`，与插件目录分开。现有 `~/.dsh/AGENTS.md` 和 `~/.dsh/maoqiu-memory.md` 保持原样；不会自动导入旧聊天或重新解释已有私人记忆。

## 使用

在 DSH 正常说话即可，例如：

- “这次修改只改下载模块，不要顺手重构。把这条要求记为这个项目的经验。”
- “看看这条经验的来源；这次已经不适用了，撤回它。”
- “去你的空间看看，有什么想继续的？可以写一小段，也可以今天先不做。”
- “把这个念头留下。先暂停，之后再继续。”
- “继续之前那篇草稿。完成后留在空间里就行。”

每轮会按当前用户话题自动检索少量相关经验和材料摘要。`autoRecallMode` 默认是 `auto`：实际 preset 为 `maoqiu` 时使用 `chat`，其他 preset 使用 `work`；也可显式设置 `work` 或 `chat`。rc3 可用 session projection 时以 projection 为准，缺少时回退到 session header。自动召回缓存按 agent、turn、query、mode、scope 和空间 revision 复用结果，项目范围或模式变化不会复用旧结果；经验正文仅前 500 字符参与匹配，每个文件预览最多读取 64 KiB，自动上下文摘要最多 1200 字符。闲聊、来访和自主活动可由模型再调用工具查看当前关注；`visit`/`activity` 模式会附最多 3 条最近更新的材料；`chat` 默认只保留相关材料与关注，显式 `include_recent=true` 时再带最近材料（路径、标题、摘要和更新时间），方便接着写；`activity` 模式另外列出未完成的 `planned`/`paused`/`failed` 活动。工作模式的自动召回仍只按话题检索，不塞入私人近况。摘要里的 `（更新 MM-DD）` 来自经验/材料/活动自身的更新时间。读取材料不要求主动插话。检索使用简单的中英文关键词匹配，语义近似但没有共同词的内容可能漏掉，可以用不同关键词再次查询或直接读取原文。

工作召回默认使用 `strict` 范围：路径 scope 优先匹配 `meta.project` 的真实工作目录，没有 project 时匹配路径形式的 `meta.scope`，支持目录及其子目录；文字 scope 精确匹配 `meta.scope`。query 不能覆盖范围边界。显式指定 `scope_mode=loose` 才会保留并标记跨范围结果。DSH 自动填充当前工作目录；维护 CLI 或 store API 不传 scope 可检索全空间。没有范围元数据的普通 notes 视为空间级材料。

经验默认是 `candidate`。保留采用可设 `active`，但这不代表已证明长期有效；状态和调用者填写的 `source.kind` 都不是认证或事实证明。运行时会补充真实 session、agent、entry 信息。修订和撤回随时可做；撤回后下一次检索立即生效，没有需要同步的独立索引。对用户的承诺与可自由放下的兴趣用 `kind` 分开。

自主活动复用当前 DSH agent 的工具循环和取消能力。`plan` 只保存意图，`run` 才执行小动作并回读；已完成活动重跑时只核对现有产物，不重建；支持暂停、恢复、取消、失败后修订和重试，成功运行可联动更新关注点进度。`space append` 按原文追加，不自动补换行；activity 的 draft 执行是替换全文。没有定时器，不会在 DSH 停止或关闭后继续活动，也不会自动对外发消息。第一版动作包括保存文字草稿、修改虚拟场景配置；场景没有图形渲染，不能当作现实天气。

自在时间、保护上限、冲突与单项恢复的完整说明见 [FREETIME.md](FREETIME.md)。

## 安装

本机沿用原有的本地目录链接安装，0.3.0 已完成原生组件重载和空白会话只读验收；三个新工具均实际调用成功，见 VALIDATION.md。实际安装源以插件详情页的“代码来源”为准，请保留该目录。DSH 默认只监听配置，替换链接源码后需触发插件配置重载；页面“刷新”只刷新列表。迁移目录请通过原生插件管理器安装新路径，空间数据仍保留在 `home`，不要用重启宿主打断其他会话。

先显式初始化空空间（不会制造日记、兴趣或历史经历）：

```powershell
node bin/maoqiu.js --home E:/maoqiu_home init
```

让 DSH 使用原生 Plugin Manager 安装本目录：

```text
plugin_manager(action="install_bundle", target="本插件目录的绝对路径")
```

包名为 `dsh-maoqiu`，Loader 行 id 为 `maoqiu`。纯 Node 真实宿主和桌面 rc3 验证结果见同目录 [`VALIDATION.md`](VALIDATION.md)。桌面 profile 由 DSH 管理；修改源码后重载插件即可，不要用 CLI 强行修改桌面 profile。

可安装源码目录或 `.tgz` 包。安装源码目录方便其他 agent 原地修改；目录移动后需重新安装。本地 link 通常由宿主 HMR 重载；查看插件版本与新工具确认生效。若宿主没有重载，可在插件页重载毛球组件，不必关闭 DSH。当前会话缺少 plugin_manager 时使用插件页，不要伪称已执行管理工具。

卸载插件使用 `plugin_manager(action="remove_bundle", target="dsh-maoqiu")`，独立空间的数据仍保留。

## 更改空间路径

插件配置 `home` 优先于环境变量 `MAOQIU_HOME`，两者未设置时使用 `E:/maoqiu_home`。在 profile 的用户 patch 中覆盖：

```yaml
- id: maoqiu
  name: dsh-maoqiu
  config:
    home: 'F:/maoqiu_home'
    autoRecall: true
    autoRecallMode: auto
    subagentAccess: read
    autoRecallInSubagents: false
    qqAccess: off
```

路径改变前先停止空间写入，复制整个 `E:\maoqiu_home` 到新位置，更新上述配置，然后重载插件并读取 `maoqiu_space(action="status")` 确认路径和内容。验证后再自行处理旧副本。只改 `home` 不会替你搬移旧数据。

硬盘离线或根目录缺失时暂停读写，不在 C 盘创建替代副本，也不排队待同步写入。恢复原路径后可继续；如果确实要创建新空间，再显式运行 `init`。

## 显式备份与恢复

备份和恢复是维护者通过 CLI 发起的操作，不是 agent 工具，也不会自动执行。操作前停止同一空间的写入；备份会把整个已初始化空间按文件字节复制到新目录或空目录，坏 JSON 也会原样复制，不会先解析或修复。目标和来源都必须是绝对路径，不能与空间互为目录。

```powershell
node bin/maoqiu.js --home E:/maoqiu_home backup --to E:/maoqiu_backup
node bin/maoqiu.js --home E:/maoqiu_home restore --from E:/maoqiu_backup
```

恢复不会覆盖已有非空目录；请先另存或清理目标后再恢复。`.history` 不会自动备份、轮转或清理，空间也没有后台备份任务。

## 数据与工具

| 数据 | 用途 |
| --- | --- |
| `evolution/experiences/*.md` | 经验正文和 JSON 元数据注释，包含范围、来源、状态、修订时间 |
| `space/active_interests.json` | 个人兴趣与用户承诺；活跃、暂缓、完成、归档、放弃可修改 |
| `space/notes/`、`drafts/`、`collections/` | 可直接阅读和修改的 Markdown / 文本 |
| `space/scene.json` | 虚拟场景设置与按稳定 id 保存的 objects |
| `space/free_time.json` | 机会、检查点、实际步骤、产物引用、用量与停止原因 |
| `space/activities.json` | 活动计划、状态与已执行结果 |
| `.history/` | 被覆盖文件的旧版本；完整备份请复制整个空间目录 |

Markdown 顶部的 `maoqiu-meta` HTML 注释内是 JSON，正文保持原文和空白。`.txt` 的元数据放在 `space/.metadata/`。其他 agent 可直接编辑正文和 JSON；下次读取即生效。JSON、Markdown 元数据或单个 `.txt` sidecar 损坏时会加入 `warnings`，跳过坏项并保留其他可读内容；写入失败会拒绝或明确返回 partial，不会静默覆盖修复。空间内文件不应使用符号链接跳出根目录。

| 工具 | 主要动作 |
| --- | --- |
| `maoqiu_recall` | `query` + `mode=work/chat/visit/activity`；先看摘要，再读原文；`visit`/`activity` 附最近材料，`chat` 显式选择，`activity` 附未完成活动 |
| `maoqiu_experience` | `save/read/list/revise/withdraw` |
| `maoqiu_interest` | `save/update/read/list`；兴趣与承诺分别保留 |
| `maoqiu_space` | `status/list/read/write/append/scene`，支持 expected_version |
| `maoqiu_activity` | `plan/revise/run/pause/resume/cancel/skip/read/list` |
| `maoqiu_object` | `list/read/upsert/archive`，稳定 id 局部更新 |
| `maoqiu_history` | `list/restore`，按文件/场景/单件物品恢复 |
| `maoqiu_freetime` | `start/status/recent/checkpoint/pause/resume/finish/disable` |

写入使用临时文件替换并保留被覆盖版本；同一 DSH 进程内按空间目录串行写入。不要同时启动多个 DSH 宿主写同一个空间；跨进程写入没有数据库事务或分布式锁。

### 模块

| 模块 | 负责范围 |
| --- | --- |
| `lib/freetime.js` | 有限机会、原生续接、预算、取消与写入前检查 |
| `lib/space-items.js` | 物品、版本检查和现有历史的单项恢复 |
| `lib/context.js` | 入口身份、访问级别、自动召回摘要和 1200 字符上下文上限 |
| `lib/recall.js` | 经验/材料/兴趣召回、关键词降噪、scope 边界和 warnings |
| `lib/backup.js` + `bin/maoqiu.js` | 显式 backup/restore/init/status/recall 维护命令 |

CLI 现在提供初始化、状态、召回以及显式 backup/restore；运行时写入仍使用 DSH 毛球工具。不要同时启动多个 DSH 宿主写同一个空间；跨进程写入没有数据库事务或分布式锁。

## 接入范围

主会话默认可读写；子 agent 默认只读且不自动召回，可用 `subagentAccess: write|off` 和 `autoRecallInSubagents: true` 显式调整。当前 QQ 入口按已有 session id 或 `qq-persona-` 前缀做保守识别，默认 `qqAccess: off`，可配置为 `read` 或 `write`。这是入口开关，不是可信身份认证、操作系统沙箱，也不能声称覆盖所有嵌套 QQ 路径。普通 QQ 聊天仍使用独立模型调用，不带 DSH 工具或空间上下文；QQ 群与其他人格不会自动获得这些私人材料。第一版没有把空间接入 QQ 日常聊天。若将来开放多人 DSH 或新建公共 agent 入口，接入者必须在那个入口沿用身份和访问边界，不能直接把私人空间提供给公共 agent。

`source.kind` 仍由调用者声明，不能作为权限或事实证明；运行时会在来源中补充 session、agent、entry，便于追溯实际入口。

当前没有 scheduler、UI、定时主动消息、垃圾箱、移动 API、向量库或新 manifest；也不做跨文件事务。单文件写入使用原子替换，同一进程内串行化；状态保存失败会明确报告 partial，`.txt` sidecar 失败不会伪装成完整成功。

## 开发

```powershell
node --test
node scripts/check.mjs
```

要重跑真实宿主烟测，先准备从当前 DSH `app.asar` 提取的 Web Host，然后把脚本实际读取的入口通过 `DSH_ENTRY` 传入。当前提取目录的入口示例是：

```powershell
$env:DSH_ENTRY = 'C:\Users\Lenovo\Documents\Codex\2026-10-24\yi\work\dsh-host-rc3\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
node scripts/dsh-smoke.mjs
```

脚本也支持 `DSH_HOST_ROOT`（默认使用本插件所在工作区的 `work/dsh-host`）、`DSH_NODE`（默认当前 `node`）、`MAOQIU_DSH_SMOKE_REPORT`（覆盖验证报告路径）和 `KEEP_SMOKE_DATA`（保留成功烟测的临时目录）。它会创建隔离的 `DSH_HOME`、profile 和毛球空间，不读取或写入配置中的 `E:\maoqiu_home`。

该烟测使用真实提取的 DSH Web Host、Cordis、live tool schema、session controller 和 Agent，但使用本地 mock model；它不验证 Electron 桌面 profile、QQ 链路、真实模型质量或付费 API。详细的已执行检查、限制和当前桌面安装状态见 [`VALIDATION.md`](VALIDATION.md)。

`lib/index.js` 负责 DSH 接入、来源补充和每 agent/turn/query/revision 的自动缓存，`lib/context.js` 负责摘要边界，`lib/recall.js` 负责轻量召回，`lib/tools.js` 是工具 schema，`lib/store.js` 负责文件格式和状态操作，`lib/backup.js` 负责显式备份恢复。扩展新宿主时复用 store；扩展新的低风险动作时修改 activity 执行部分和对应测试即可。

宿主烟测使用隔离目录和假模型检验真实 DSH 接口，不代表真实模型已经能稳定形成有益经验。长期的召回质量、打断感和表达效果需要实际使用观察。改进摘要见 [`CHANGES.md`](CHANGES.md)。
