# dsh-maoqiu 维护说明

这是一个面向 DSH 0.2.1-rc.3/rc.4 的 Host 插件，当前版本为 0.5.0，同时提供毛球模式预设（lib/mode.js）。Windows 默认空间是 `E:\maoqiu_home`；源码目录采用本地链接安装。真实空间只做明确授权的读写，不把测试数据写入其中。

## 设计边界

- 保持一个 Host、可读文件和少量清晰模块；不要为了“完整产品化”引入数据库、向量库、manifest、评分/审批系统、后台服务或额外治理门禁。
- 单文件写入使用原子替换，同一 DSH 进程内按空间串行；不假设跨进程事务或分布式锁。状态保存失败必须显式返回失败或 partial，不能伪装成完整成功。
- activity 的 `plan` 只是意图，`run` 成功回读才是执行结果；已完成活动重跑只核对已有产物，不重建。关注点可由成功活动联动更新。
- `space append` 原样追加，不自动补换行；activity draft 执行替换全文。连续自在时间复用 DSH Agent；没有默认 scheduler、独立 UI、定时主动消息、垃圾箱或向量检索。

## 模块职责

- `lib/index.js`：DSH 接入、入口访问边界、运行时来源补充，以及按实际 agent preset 选择 chat/work 的每 agent/turn/query/revision/mode/scope 自动召回缓存。
- `lib/freetime.js`：手动机会、检查点、原生续接、预算与用户中断；不要另建模型循环。运行状态写入不生成逐步备份。只由主人本轮真实消息授权（运行时 source.kind=user），不得新增定时、日程或自动触发源；不设每日上限，只有可配置软上限，超了停下问主人，不悄悄截断。
- `lib/space-items.js`：稳定物品、版本检查和现有 .history 单项恢复。
- `lib/context.js`：入口身份、访问级别和不超过 1200 字符的可读召回摘要。
- `lib/recall.js`：经验、材料和兴趣召回；经验正文只匹配前 500 字符，材料读取最多预览 64 KiB；负责中文降噪、scope 边界和 warnings。不要在这里再增加 turn 缓存；兴趣轮换只允许使用有限的 WeakMap 游标。
- `lib/store.js`：Markdown/JSON 格式、状态操作、原子保存和 helper 读取；不要把 DSH API 依赖倒灌进 store。
- `lib/backup.js`、`bin/maoqiu.js`：维护者显式执行的 backup/restore/init/status/recall 命令，不是 agent 工具。
- `lib/tools.js`：工具 schema、动作描述和参数边界。
- `test/`：临时目录测试；`scripts/dsh-smoke.mjs`：隔离目录中的真实 DSH Web Host 与 mock model 烟测。

## 召回约定

- `work` 默认 `scope_mode=strict`。路径 scope 优先匹配 `meta.project` 的真实 cwd，没有 project 时匹配路径形式的 `meta.scope`，允许目录和子目录；文字 scope 精确匹配 `meta.scope`。query 不能覆盖范围边界。`loose` 需显式请求，跨范围结果标为 `cross_scope`。
- DSH adapter 默认填当前 cwd；维护 CLI/store API 不传 scope 可全空间检索。没有 scope/project 的普通 notes 是空间级材料，不应被 strict 当成另一个项目而过滤。store API 的 scope 数组任一范围命中即可。
- candidate/active 是记录状态，不是事实认证；`source.kind` 是调用者声明，不是权限证明。运行时来源应补充真实 session、agent、entry。
- visit/activity 和空 query 的 chat 可展示 active 的无关兴趣；带话题的 chat 默认只相关，include_recent=true 显式浏览近况；工作模式只返回相关兴趣。兴趣与 commitment 分开，材料摘要最多 3 条；chat 轮换按更新时间排序，游标按 `limit` 前进且不写文件。
- 单个坏经验、坏材料、坏 JSON 或坏 `.txt` sidecar 应进入相对路径 `warnings`，其余内容继续返回；不得泄露绝对路径。未知整体错误不能静默伪装成空结果。

## 入口与权限

主会话默认可读写。子 agent 默认只读且不自动召回，可显式配置 `subagentAccess: write|off` 和 `autoRecallInSubagents: true`。QQ 现有 session id 或 `qq-persona-` 前缀只用于保守入口开关，默认 `qqAccess: off`；它不是可信身份认证、操作系统沙箱，也不能宣称覆盖所有嵌套 QQ 路径。

不要把 `source.kind`、消息中自报的 owner 或路径字符串当成权限检查。扩展入口时沿用 `accessFor` / `isOperationAllowed` 等已有边界，并明确区分主会话、子 agent、QQ 和公开聊天。

## 空间、备份与编辑

- 默认空间路径为 `E:\maoqiu_home`，改变路径前先停止写入并复制完整空间；只改配置不会搬迁数据。
- 显式备份：`node bin/maoqiu.js --home ABS backup --to ABS_DIR`；显式恢复：`node bin/maoqiu.js --home ABS restore --from ABS_DIR`。两端必须绝对路径，目标需新建或为空；恢复不覆盖已有非空目录。备份按字节复制整个空间，坏 JSON 也保留原样；不自动备份、轮转或清理 `.history`。
- Markdown 的 `maoqiu-meta` 和 `.txt` sidecar 必须保持合法 JSON。其他 agent 可直接编辑，但损坏项应被隔离并报告 warnings。不要使用符号链接把空间文件带出根目录。

## 修改与验证

先查看当前源码、未提交改动和真实运行状态，再做最小修改。安装源以 DSH 插件详情页“代码来源”为准，工作副本不一定就是运行源。默认 HMR 只监听配置，源码替换后须重载并实际调用新工具；不要把包版本标签或列表刷新当作新代码已生效的证明。配置重载还会检查其他插件待更新模块，用户工作时应避开；用户明确允许立即重载时按其选择进行。不要 reset、覆盖用户文件、批量终止 DSH、重启或关闭用户桌面，也不要把测试数据写入 `E:\maoqiu_home`；真实空间验收只执行明确授权的读取。

涉及实现时按需执行：

```powershell
node --test
node scripts/check.mjs
```

真实宿主烟测只使用隔离的 `DSH_HOME`、profile 和临时毛球空间；桌面验证记录与限制见 [`VALIDATION.md`](VALIDATION.md)。不要把 smoke test、mock model 或静态检查包装成真实模型长期效果。
