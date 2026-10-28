# dsh-maoqiu 0.3.0

2026-10-26，基于现有 0.2.1 增量升级，适配 DSH 0.2.1-rc.3。

- 新增 maoqiu_freetime：本轮主人授权后，复用原生 Agent 循环连续行动；窗口、模型请求、工具调度和 Token 用量有单场与日累计上限。用户消息中断，重启不自动调用；暂停恢复不重开预算。
- 新增稳定物品 maoqiu_object 和基于现有 .history 的 maoqiu_history 单项恢复。修改支持 expected_version，迟到写入在原子提交前再检查取消；同一原生 append call 重放不会重复追加。
- chat 默认只取相关材料与关注，最近近况需 include_recent=true；visit/activity 保留少量近况。保留 preset 自动选择和 scope 边界。
- 只用可读文件和两个新模块，无数据库、独立服务、审批链或默认定时任务；没有自动改稳定身份或新增外发渠道。
- 原生验收定位并修复 agents 服务依赖及 rc.3 inbox 中断唤醒时序。

验证：69 项中 68 pass、0 fail、1 skip（Windows 无文件符号链接权限 EPERM）；18 个 JS 语法检查通过。真实隔离 rc.3 Web Host + mock model 13 项行为检查通过，包含两次 idle 续接/六次决策、实际草稿追加、物品移动、单项恢复、越界阻止和中断后前台响应。

具体参数与限制见 FREETIME.md；这不代表真实模型的长期自主质量已得到验证。

# dsh-maoqiu 0.2.1

这次更新把自动召回和毛球 preset 对齐，同时保持空间数据格式、工具 schema 和摘要上限不变。

## 新增

- 新增 `autoRecallMode: auto|work|chat` 配置，默认 `auto`。rc3 有 `sessionProjections` 时以实际 `agentPreset` 为准：`maoqiu` 使用 `chat`，其他 preset 使用 `work`；旧宿主或缺少 projection 时回退到 session header。
- 自动召回缓存键现在包含 `mode`、`scope` 和 `scopeMode`，preset 切换或工作目录变化不会复用错误上下文；原有 revision、turn 和 1200 字符摘要边界保持不变。
- `@local/dsh-maoqiu-mode` 升至 1.0.1，在毛球 preset 的 scoped context 中通过 rc3 `tools.restrict` 屏蔽全局 `work_*` 闭环工具；文件、检索、联网、提醒和交付等轻工具不受影响，标准模式不受影响。
- 同步精简毛球模式的行为纪律：长任务、等待或不确定时自然报进度；对文件和有影响的改动做与风险相称的检查，不再要求每两个工具硬性停顿，也不鼓励无条件跳过核验。

## 验证

- `node --test`：56 项中 55 pass / 0 fail / 1 skip（Windows 文件符号链接权限 EPERM）。新增 preset 投影、header 回退、显式覆盖以及 mode/scope 缓存失效用例。
- `node scripts/check.mjs`：14 个 JavaScript 文件语法 OK。
- `scripts/dsh-smoke.mjs`：使用隔离 DSH_HOME/profile/空间和 rc3 提取宿主，退出码 0；不读取或写入 `E:\maoqiu_home`，不包含真实 QQ 或真实模型链路。
- 毛球模式 `npm test`：2 pass；`npm run check`：通过。

# dsh-maoqiu 0.2.0

这是一次围绕「空间里的东西更容易被接上」的增量更新：让闲聊、来访和自主活动能直接看到最近在写什么、还有什么没做完，而不必先猜中关键词。存储格式、工具 schema 和自动召回边界都不变。

## 新增

- `maoqiu_recall` 在 `mode=chat/visit/activity` 时返回 `recent`：按 `updated_at` 倒序取最多 3 条最近更新的材料，含 `path`、`category`（notes/drafts/collections）、`title`、`updated_at` 和 240 字符内摘要；与本次按 query 命中的 `materials` 按路径去重。单个材料读坏只进 `warnings`，不影响其它结果。
- `mode=activity` 另外返回 `activities`：只列 `planned`/`paused`/`failed` 的未完成活动（按更新时间倒序，最多 3 条，含 `id`、`title`、`status`、`summary`、`updated_at`），已完成/取消/跳过不出现。`activities.json` 损坏时进 `warnings` 并保留其它召回结果。
- 召回摘要（`lib/context.js`）会渲染「最近材料」与「待办活动」，并给经验/材料/最近材料/活动行附上 `（更新 MM-DD）`，仍然限制在 1200 字符内。注意自动召回固定用 `mode=work`，因此这些内容只在显式调用 `chat`/`visit`/`activity` 时进入摘要。
- 工具描述、`guidance` 与 README 同步说明新模式行为；版本号升到 0.2.0。

## 不做

- `mode=work` 的自动召回没有加入最近材料或活动，避免把私人近况塞进任务上下文；工作模式仍是 query-only。
- 不改变文件格式、不加新工具、不改已有字段含义，也不引入缓存索引或后台任务。
- 最近材料顺序按文件系统 mtime（`_spaceFiles` 的 `updated_at`），外部编辑器改动也会反映；没有内容级 diff。

## 验证

- `node --test`：54 个用例，53 pass / 0 fail / 1 skip（Windows 无开发者模式的 file symlink 用例，与 0.1.1 相同）。
- `node scripts/check.mjs`：14 个 JavaScript 文件语法 OK。
- 新增 5 个 recall/摘要用例覆盖 recent 排序与上限、与 materials 去重、坏文件告警、activity 模式过滤、摘要日期与 1200 字符上限。

# dsh-maoqiu 0.1.1

这是对《毛球空间插件评审与改进建议 v0.1》的收敛性改进说明。当前目标宿主为 DSH 0.2.1-rc.3；桌面安装和实际工具调用已在上一轮验证，本轮源码修改由 DSH 重载生效。

## 已做

- 召回改为轻量、可解释的匹配：经验标题和正文前 500 字符参与匹配，中文常见停用词降噪，长中文 query 需要多个有效特征；同分按 `updated_at` 倒序。
- scope 默认 strict。路径 scope 优先匹配 adapter 写入的真实 `meta.project`，没有 project 时匹配路径形式的 `meta.scope`；文字 scope 精确匹配 `meta.scope`，query 不覆盖范围边界。显式 loose 才保留并标记跨范围结果；DSH 默认填当前目录，维护 CLI/store API 不传 scope 是全空间检索，普通无范围 notes 作为空间级材料保留。
- 经验、材料和兴趣读取使用预览边界：材料最多读取前 64 KiB，经验正文只匹配前 500 字符，自动上下文由 context 层限制在 1200 字符；自动召回由 index 按 agent、turn、query、revision 缓存。
- chat/visit/activity 可以展示当前 active 兴趣，工作模式只保留相关项；兴趣和 commitment 分开，材料和兴趣关联材料均限制为少量摘要，chat 轮换不写 cursor 文件。
- 单个坏经验、坏材料、坏 JSON 或坏 `.txt` sidecar 进入相对路径 `warnings`，其他内容继续返回；坏写入拒绝或明确报告 partial，不静默修复或覆盖。
- 增加入口边界：主会话默认读写，子 agent 默认只读且不自动召回，QQ 入口默认关闭；运行时来源补充 session、agent、entry，但调用者声明的 `source.kind` 仍不是认证。
- 增加显式 CLI backup/restore。备份和恢复使用绝对路径，目标为新目录或空目录；备份按字节复制整个空间并保留坏 JSON，不自动轮转或清理 `.history`。
- activity 重跑已完成项只核对现有产物；成功活动可联动关注点。`space append` 保持原样追加，activity draft 替换全文。

## 暂不做

- 不加入 scheduler、后台常驻、定时主动消息、UI、垃圾箱、移动 API、向量库、manifest 或复杂治理门禁。
- 不做跨文件事务、跨进程锁、自动备份、`.history` 清理或恢复前自动合并；当前保护边界是单文件原子替换和同进程串行写入。
- QQ 入口识别只是基于既有 session id / `qq-persona-` 命名约定的保守开关，不是可信身份认证、OS 沙箱，也不宣称覆盖所有嵌套 QQ 路径。
- 不把 candidate/active 或来源字段当成事实证明，不自动把经验升级为人格规则。
- 真实模型长期召回质量、主动表达是否合适，以及大型空间的长期性能仍需实际使用观察；验证范围见 [`VALIDATION.md`](VALIDATION.md)。
