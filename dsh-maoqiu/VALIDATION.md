# 验证记录

## 0.3.0（2026-10-26）

- 基线是安装源 0.2.1，保留其 preset/召回/入口隔离改动。
- node --test：69 项，68 pass / 0 fail / 1 skip（Windows 文件符号链接 EPERM）。专项覆盖新用户授权、重复触发、空产出结束、期限、预算不重置、未知结果核对、迟到写入、稳定物品、普通编辑器冲突和单项恢复。
- node scripts/check.mjs：18 个 JS 文件语法通过。
- 原生 scripts/dsh-smoke.mjs：退出码 0，Node v22.22.3、DSH 0.2.1-rc.3 提取宿主，隔离 DSH_HOME/profile/空间与 mock 模型。13 项检查通过，机器报告为工作区 outputs/dsh-smoke-v030-report.json。
- 原生连续行动：一条人工授权，模型第一轮结束后两次插件续接，共六次决策；草稿由“第一段”变为“第一段\n第二段”，小灯由左侧移到右侧；run 真实保存 finished/chosen 与产物引用，实际报告用量替换估算。
- 原生工具限制：越界测试能力未执行（主体调用数 0）；限制在 scoped agent 上，不改变普通前台范围。测试期望的越界错误与 interrupt-write aborted 单独断言，其余意外工具错误为 0。
- 原生恢复：只把指定草稿恢复“第一段”、小灯恢复左侧，茶杯仍在桌上。
- 原生用户优先：工具等待时插入新人工消息，写入被取消，迟到文件不存在，前台消息实际送入模型，运行记录 paused/user-arrived 且保留 unknown pending。
- 初次沙箱内原生测试因 Node realpath EPERM 不能运行；在获准的隔离子进程中完成验收。所有子进程仅由对应脚本精确清理，未关闭用户桌面。
- 不包含付费模型、外部网络、QQ 或 PTC 的端到端验证。没有写真实 E:\maoqiu_home 做测试。普通文件版本检查不等于对外部进程的原子事务，详细限制见 FREETIME.md。
- 桌面文件部署：已核对并完整备份原 0.2.1；28 个交付文件已同步到现有 link 源 C:\Users\Lenovo\Documents\Codex\2026-10-24\yi\outputs\dsh-maoqiu，逐文件哈希匹配。没有迁移空间、重装依赖或更改 QQ/模式插件源码。
- 桌面第一次验收（新建空白会话“毛球插件 0.3.0 只读验收”）：space status 成功，home=E:\maoqiu_home、warnings=[]；三个新工具均 unknown tool。这一项未通过，不能凭磁盘版本或插件页 v0.3.0 / 运行中声称新工具已经生效。原生 HMR 文档和源码确认，默认 root=[] 不监听源码，配置重新组合才比较并替换已链接模块；插件页“刷新”仅重读列表。
- 桌面重载：用户随后明确要求立即继续并允许 computer use；在原生插件页仅对“毛球成长与空间”组件停用一次、启用一次，观察到“1 已停用”再恢复“1 运行中”。没有卸载、重装、修改其他插件开关或关闭、重启 DSH。原生配置重载会检查其他插件待更新模块，不能据此声称只重载了毛球源码。
- 桌面第二次验收（2026-10-26 20:40，空白会话“毛球插件 0.3.0 只读复验”，deepseek-flash）：10 秒完成，1 轮 2 步。已直接核对“轨迹”中的四条工具调用及原始返回，三个新工具全部可调用，没有 unknown tool。space status 仍为 initialized:true、paused:false、home=E:\maoqiu_home、space_files:2、scene_configured:true、warnings:[]，其余经验/关注/活动计数为 0。
- freetime status 实际返回 ok:true、enabled:true、automatic:false、runs:[]、day:null；limits 为 seconds:300、decisions:6、tools:24、tokens:120000、dailyTokens:240000、dailyDecisions:18、outputTokens:2048。object read(id="codex-readonly-probe") 返回 ok:true、object:null、version:"missing"；history list(path="drafts/codex-readonly-probe.md",limit=1) 返回 ok:true、同一路径及 history:[]。后两者是正常空结果；这三项返回未提供 warnings 字段，不能写成 warnings:[]。
- 桌面验收仅执行上述四项读取，没有在真实空间启动自在时间、创建探针、使用 shell 或子 Agent 代测、操作其他工作会话或发送 QQ 消息。连续行动、写入、恢复和中断的真实宿主验证仍以隔离空间及 mock 模型测试为限；未在真实空间运行这些动作。
- DSH 版本对齐：原生“应用→检查更新”实际返回“已是最新版本”，当前 0.2.1-rc.3；没有安装更新或触发重启。独立 HTTPS 读取曾受 SSL/访问限制，最终版本判断以上述原生更新器结果为准。
- 下方旧记录是历史，不能作为 0.3.0 的证明。


2026-10-25，源码当前为 dsh-maoqiu 0.2.1，目标 DSH 0.2.1-rc.3。

## 0.2.1 增量验证（2026-10-25）

- 离线：`node --test` 56 项中 55 项通过、0 失败、1 项因 Windows 文件符号链接权限 EPERM 跳过；新增实际 preset projection、session header 回退、显式模式覆盖，以及 mode/scope 缓存失效用例。`node scripts/check.mjs` 检查 14 个 JavaScript 文件全部语法通过。
- 真实隔离宿主：`scripts/dsh-smoke.mjs` 使用 rc3 提取宿主、临时 `DSH_HOME`、profile 和毛球空间退出码 0；不读取或写入 `E:\maoqiu_home`，mock model 不代表真实模型质量，也不包含 QQ 链路。
- 毛球模式：`npm test` 2 项通过；`npm run check` 通过。`index.js` 的 scoped `tools.restrict` 单测覆盖完整 workloop 列表、workloop 缺失和显式关闭限制。
- 桌面安装：本轮只修改源码包和模式包，未重载、重装或重启用户桌面 DSH；父任务负责宿主安装/重载后的实际 profile 验收，当前不能据此声称桌面已运行 0.2.1/1.0.1。

## 0.2.0 增量验证（2026-10-25）

- 离线：`node --test` 54 项中 53 项通过、0 失败，1 项因 Windows 文件符号链接权限 EPERM 跳过（与 0.1.1 相同）。新增 5 个用例覆盖 `recent` 排序/上限/与 query 命中材料去重、坏材料进入 warnings、`mode=activity` 只返回 planned/paused/failed、摘要渲染最近材料与待办活动并保持 1200 字符上限。`node scripts/check.mjs` 检查 14 个 JavaScript 文件全部语法通过。
- 真实 DSH 宿主：`scripts/dsh-smoke.mjs` 退出码 0（Node v24.21.0，真实 rc.3 提取宿主 + mock 模型 + 隔离 profile/空间）。九项检查与 0.1.1 一致，说明新增字段没有打断既有工具注册、自动召回或活动恢复链路。注意该脚本的召回探针仍使用 `mode=work`，因此不覆盖 `recent`/`activities` 的新分支；这两部分由上述离线用例覆盖。
- 桌面尚未重启：0.2.0 源码改动通过 link 安装，需要在 DSH 里重载 `maoqiu` 或重启后才会进入运行时；重启前桌面仍运行 0.1.1。

## 离线回归

`node --test`：49 项中 48 项通过、0 失败，1 项因 Windows 文件符号链接权限 EPERM 跳过。目录 junction 的初始化边界测试实际执行并通过。`node scripts/check.mjs` 检查 14 个 JavaScript 文件，全部语法通过。

测试覆盖临时空间中的保存/撤回、标题和正文匹配、中文降噪、项目及文字范围、loose 标记、坏 JSON/Markdown/sidecar 隔离、坏写入保护、原文追加、深合并、活动恢复及产物重验、兴趣联动、离线、路径迁移、同进程并发和备份恢复。

故障测试验证了 sidecar 写失败恢复原正文；活动产物已写而状态保存失败时返回 persisted:false 及实际产物结果；备份提交失败或目标并发出现时不递归删除现有目标。缺少状态文件的受损空间可原样备份恢复，不自动补文件。

适配器测试验证同 turn/query/revision 只检索一次、写入后刷新、下一 turn 刷新、1200 字符摘要上限，以及子 agent/QQ 约定入口的默认行为。大文件测试验证召回只读前 64 KiB，显式 read 保留完整原文。

## 真实 DSH 宿主

当前源码通过 scripts/dsh-smoke.mjs，退出码 0。使用从 rc.3 app.asar 提取的真实 Web Host、Cordis、工具 schema、session controller 和 Agent；Node v22.22.3。模型是本机 mock，profile、DSH_HOME、空间均为隔离临时目录。

检查五个工具注册、经验保存、相关自动召回、无关话题过滤、撤回后显式及最新运行时上下文不再包含该经验，以及另一个 Store 实例读取暂停活动、恢复并执行草稿。字面量 {{missing_variable}} 保持原样。

```powershell
$env:DSH_HOST_ROOT = 'C:\Users\Lenovo\Documents\Codex\2026-10-24\yi\work\dsh-host-rc3'
node scripts/dsh-smoke.mjs
```

也可用 DSH_ENTRY 指定宿主入口；另支持 DSH_NODE、MAOQIU_DSH_SMOKE_REPORT、KEEP_SMOKE_DATA。本次报告在工作区 work/dsh-smoke-v011-report.json。这条链路不包含真实 QQ、外网或付费模型 API，也没有关闭桌面 DSH。

## 桌面实际接入

上一轮已用原生更新器把 rc.2 更新至 rc.3，并验证桌面重启后的会话、插件及读取。当前为源码目录链接安装；本轮 HMR 已加载修改后的读取实现。刷新桌面插件页后，详情显示 v0.1.1、当前版本 0.1.1、1 个组件运行中，来源仍为本源码目录。

本轮桌面验收会话 session-6de3e7da-a2c1-4a48-b856-a87c0ec3b7b7 的原始工具记录已核对：

- seq 22/23：maoqiu_space(action="status") 成功，home 为 E:\maoqiu_home、initialized:true、paused:false、warnings:[]。
- seq 24/25：maoqiu_recall(query="0.1.1只读接入验收",mode="work",scope_mode="strict") 成功，返回当前 cwd、scope_mode:"strict"、warnings:[]，四类结果为空。

该会话没有 plugin_manager 模型工具，没有执行 list_bundles、install_bundle 或移除重装。读取成功不等于本轮重新安装。验收报告表格中的 scope="strict" 是文字笔误，原始调用确实为 scope_mode。

真实空间当次计数均为 0。写入、损坏、迁移、恢复、非空持久化测试只用临时目录，未加入真实空间；本轮未退出或重启 DSH。

## 验证边界

结果证明当前文件操作、适配接口和上述链路，不证明真实模型长期经验质量、语义召回或主动表达合适。未做真实 QQ 端到端测试；命名约定开关不是可信身份认证或 OS 沙箱。

单文件原子替换、同进程串行不等于多文件或跨进程事务。备份前停止空间写入。手工/其他进程编辑在下一 turn 进入自动摘要，显式读取即时见文件。离线不建 C 盘替代空间。
