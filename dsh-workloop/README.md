# 工作闭环（Workloop）— DSH 工作闭环与协作反馈插件（v0.2.0）

对齐 `DSH_WorkSkill_单插件方向方案 v0.3`：**只做一个插件**，把 Hermes Work-Skill 的三条主线（Loop 可信闭环、Radio 协作感知、经验反馈）蒸馏成 DSH 原生插件能力。它不替代 DSH 的执行引擎，也不建第二套学习系统。

## 1. 这个插件解决什么

提示词保不住的三种状态：

1. **任务边界与验收标准**：目标、范围、必过 Claim 一旦变化，旧结论需要重新评估，而不是靠记忆。
2. **证据与对象状态的联系**：结论必须能追到具体文件指纹、真实命令与观察，而不是“我跑过了”。
3. **协作信息是否真的被处理**：记录谁发现了什么、是否被确认，而不是“消息发出去就算对方知道了”。

它**不**负责：任务规划、子 agent 调度、团队/工作流编排、权限、沙箱、审批、长期记忆。这些继续由 DSH 原生能力和毛球空间负责。

## 2. 复用了什么

| 能力 | 归属 | 本插件的用法 |
|---|---|---|
| subagent / team task / workflow | DSH 原生 | 编排与分工完全交给宿主，插件只记录合同、证据与通知 |
| todo / plan / goal | DSH 原生 | 计划仍由宿主工具表达，插件不重复 |
| 权限、审批、沙箱 | DSH 原生 | 插件**只记录**动作声明，不宣称强制拦截或沙箱隔离 |
| 会话与事件 | DSH 原生 | 每个 Run 有自己的哈希链事件，不复制对话 |
| 毛球空间（`maoqiu_experience` 等） | 毛球插件 | 经验候选只生成不写入；由主会话确认后手动沉淀 |

## 3. 增加了什么

- 7 个 `work_*` 工具（合同、Claim、动作、证据、判定、通知、经验候选）
- 1 段系统提示（约 20 行，含四条硬规则）
- 每轮注入活动 Run 的有界摘要（默认 ≤700 字符；每个新 turn 都重新检查文件指纹）
- 中文/英文 Plugin Manager 名称、描述与原有 SVG 图标；包名和 loader id 仍保持 `@local/workloop` / `workloop` 兼容

数据默认在 `$DSH_HOME/work`（通常 `~/.dsh/work`），与插件目录、毛球空间都分开：

```
runs/<run-id>/
  contract.v{n}.json   current.json   state.json
  events.jsonl         evidence/EV-*.json
  actions.jsonl        notices.jsonl   learning/LX-*.json
  verdict.json
```

## 4. 三条主线怎么落地

### Loop：可信闭环

- `work_contract start` 冻结合同：目标、交付物、范围（allow/protected）、必过 Claim、复核策略。
- `work_claim add/update/remove`：Claim 定义变化 → 绑定旧定义的历史证据失效；目标/交付物变化 → **不机械清空**，只提升 `goalEpoch`，旧证据在结论里标记“待重新评估”。
- `work_evidence record`：证据绑定对象指纹（sha256）、Oracle、质量、观察摘要。**声明质量只是上限**：
  - `assert True` / `echo ok` / 裸退出码 → Q0
  - `tests_pass` 必须有真实命令、退出码为 0 且执行到至少 1 个测试；非零退出码、0 个测试和 `inconclusive` 都不能支撑通过
  - 证据 subjects 至少要有一个落在 Claim subjects 范围内；无关文件的“通过”不会满足该 Claim
  - Q0 永远不能满足完成，即便 Claim 错误地声明 `minQuality: Q0`
  - 缺对象指纹 / 缺观察摘要 / Oracle 不在允许列表 → 最高 Q1
  - 声明 Q3 但无独立来源 → 降到 Q2
  - 命令型证据在非 host 后端执行 → 附带副作用边界限制
- `work_verdict`：结论由当前合同、当前指纹、有效证据算出。
  - 必过 Claim 全过 + 无限制 → PASS
  - 全过但有限制 → DEGRADED
  - 部分过 → PARTIAL；全没过 → FAIL；显式 block → BLOCKED
  - 非 PASS 收尾必须 `acknowledgeGaps=true` + `knownGaps`，否则拒绝收尾
  - 复核必须使用 supporting、至少 Q2 的 `review_record`；`inconclusive` 或低质量复核不算完成

### 宿主证据（v0.2.0 新增）

- 插件监听 `tools/post-execute`，对完成的前台 `bash` 调用记录命令、退出码、输出尾部与 sha256、从输出解析出的测试数（node --test / pytest / jest / vitest / unittest），编号 `HX-n`。钩子只记录，始终原样放行（`next()`），不改写、不拦截任何结果。
- `tests_pass` / `command_output` 证据记录时，按 `observed.captureId` 或同一 `command` 匹配本会话（子 agent 归到父会话）最近的采集；匹配到时命令、退出码、测试数以宿主为准，模型填写的数字被覆盖。
- 匹配不到 = 模型自报，最高 Q1；宿主输出里解析不到测试数的 `tests_pass` 不能支撑通过。
- `work_evidence action=captures` 列出本会话已采集的结果。
- 采集只存在进程内存（每会话最多 50 条），宿主重启后丢失，证据会诚实地回落到“自报”。
- 非命令型 Oracle（文件指纹类、复核、用户接受）规则不变：文件指纹本来就由插件自己计算。

### Radio：协作感知

`work_notice post/list/ack/resolve`，只记录六类信息（discovery/conflict/blocker/request/suggestion/challenge）：

- 按 `kind + topic + 摘要` 在 30 分钟内去重，抑制重复通知；
- 每个 Run 未解决通知上限（默认 50），超出要求先合并；
- **通知记录不代表送达或已读**：实际投递仍用 DSH 原生消息/团队任务，收到方 `ack` 才算确认；
- 未确认的 blocker 进入最终结论的限制项，未确认的 conflict 进入警告。

### 经验反馈

`work_learn propose/list`：

- 必须给出 title、content、scope、source；可引用 `EV-*` 证据；
- 自动判断验证程度：全部引用证据当前有效且 ≥Q2 → `verified`，否则 `observed`；无证据且来源为推断 → `inferred`；
- 只写到 `runs/<id>/learning/`，**不写毛球空间**；list 会输出可直接交给 `maoqiu_experience` 的交接文本；
- 子 agent 不得调用（不写长期材料）。

## 5. 子 agent 与私人空间边界

默认 `subagentAccess: collaborate`：

| 入口 | 合同/Claim/动作/收尾 | 证据/通知 | 只读查询 |
|---|---|---|---|
| 主会话 | ✅ | ✅ | ✅ |
| 子 agent（collaborate） | ❌ | ✅ | ✅ |
| 子 agent（read） | ❌ | ❌ | ✅ |
| 子 agent（off） | ❌ | ❌ | ❌ |

经验候选永远只由主会话提出；毛球空间仍然只由主会话按原有权限访问，插件不代理、不缓存、不注入私人材料。

### Run 与会话归属

- 主会话开始 Run 时记录创建会话；子 agent 通过 `parentSession` 继承父会话归属。
- 省略 `runId` 的工具调用只会自动选择“当前工作区 + 当前会话”的 active Run，不会把同一工作区另一个会话的 Run 串进来。
- 旧版本没有会话归属的 Run 不会被自动选中，但仍可显式传 `runId` 读取、补证据或收尾。
- 毛球预设（`agentPreset=maoqiu`）不注入工作闭环指导和 active Run 摘要；预设通过 DSH 的 `sessionProjections.stateOf(session, 'agentPreset')` 读取，旧宿主回退到 session header。

## 6. 使用流程示例

```text
work_contract start  goal="只修下载模块的断点续传，不顺手重构"
                     scope={allow:["src/download/**"], protected:[".env"]}
                     claims=[{id:"AC-01", statement:"中断后能继续下载",
                              oracle:["target_state","tests_pass"], minQuality:"Q2",
                              subjects:["src/download/resume.py"]}]
work_action declare  kind=write intent="改 resume.py" targets=["src/download/resume.py"]
work_evidence record claimId=AC-01 oracle=tests_pass quality=Q2
                     subjects=["src/download/resume.py"]
                     observed={command:"pytest tests/test_resume.py -q", exitCode:0,
                               tests:4, summary:"4 passed"}
work_verdict preview → PASS / DEGRADED（附限制）
work_verdict finalize summary="..."
work_learn propose   title=... content=... scope="src/download" evidenceIds=["EV-01"]
```

**简单任务不要开 Run**：系统提示与工具描述都明确要求闲聊、解释、一步能完成的小事直接用原生工具。

## 7. 安装

```text
plugin_manager(action="install_bundle", target="<本插件目录绝对路径>")
```

Loader 行 id 为 `workloop`，包名 `@local/workloop`。可选配置（写进 profile 的用户 patch 覆盖）：

```yaml
- id: workloop
  name: '@local/workloop'
  config:
    home: '<DSH_HOME>/work'              # 绝对路径；省略时默认 $DSH_HOME/work
    tools: true
    prompt: true
    activeContext: true
    activeContextMax: 700
    subagentAccess: collaborate          # off | read | collaborate | write
    maxNotices: 50
    noticeDedupeSeconds: 1800
    hostEvidence: true                   # 通过 tools/post-execute 采集真实命令结果
    captureTools: [bash]                 # 采集哪些宿主工具的结果
```

命令行安装（隔离验证用）：`dsh plugin --profile <profile> add <本插件目录>`，再用 `dsh --profile <profile> --dump-config` 确认出现 `# == @local/workloop` 层。

卸载：`plugin_manager(action="remove_bundle", target="@local/workloop")`，数据保留在 `home`，不自动删除。

## 8. 验证到什么程度

已执行（`node --test`，55 个用例全部通过；`node scripts/check.mjs` 结构检查通过）：

- 合同冻结、版本升级、事件哈希链、外部篡改可检测；
- Claim 变化使对应证据失效；目标变化只提升 epoch 并要求重新评估；
- Q0 占位命令、缺指纹、缺摘要、未知 Oracle、Q3 无独立来源的下调；
- 测试失败退出码、零测试、不确定证据、Q0 最低质量和无关 subjects 不得伪装成 PASS；
- 复核质量/状态校验、同一工作区会话隔离、旧 Run 显式 runId 兼容；
- 文件变化后证据失效；
- 动作门禁：保护路径、越界、空 allow、execute 缺副作用、高风险确认；
- 结论：PASS / DEGRADED / PARTIAL / FAIL / BLOCKED / NOT_READY，finalize 拒绝假完成；
- 通知去重、ack 语义、未确认 blocker 进入限制；
- 经验候选的 verified/observed/inferred 与证据校验；
- 插件注册 7 个工具、1 段系统提示、1 个上下文注入、`agent/pre-step` 钩子；新 turn 会重新刷新文件指纹；
- 毛球预设不接收工作闭环指导/活动摘要；locale 资源可解析并随包发布；
- 子 agent 权限矩阵（主会话/协作/只读/关闭）。

**未验证**（不宣称）：

- 尚未在真实 DSH 桌面宿主重启后验证 Plugin Manager 的 locale 实际渲染与毛球预设切换；本轮已针对 rc.3 的 `sessionProjections.stateOf` 接口做兼容实现，离线测试使用 mock projection。
- 尚未在真实长会话中测量每 turn 重新指纹带来的 I/O 开销；摘要仍有字符上限，性能只做了定向单元/集成测试。
- 未验证 pre-execute 拦截（不做）；`enforcement: 'recorded'` 是诚实级别。
- 宿主证据只覆盖 `bash`（`tool-bash` 的 foreground 结果形状）；pwsh、后台任务、被提升为后台的长命令不采集。
- 工具层能保证“调用了 finalize 就出不了假 PASS”，但**不能阻止模型完全不调用工具直接宣称完成**——这需要宿主级钩子，属后续阶段。
- 通知的送达/已读仍取决于 DSH 原生消息机制，本插件只记录声明与确认。

## 9. 取舍说明

- **不做 Python runtime / 独立 CLI**：每步子进程调用的仪式开销直接变成 token 与延迟，违背 v0.3「不要僵硬仪式」。
- **不做 HMAC 信任回执**：Hermes 需要它是因为插件跨进程不可信；DSH 插件同进程，session 即身份。
- **不做消息总线**：DSH 已有 subagent/team message；这里只补“去重 + 已确认/已处理”的语义缺口。
- **不机械全失效**：目标变化只提升 epoch 并标记待重评，避免为形式清空仍有效的证据。
- **不做第二套学习系统**：经验候选交给毛球空间现有接口，插件不建索引、不注入。

## 10. 后续（按验证结果决定，不预支）

1. 真实会话试用 5–10 个任务，观察是否减少假完成、陈旧证据与噪声；收益小于成本就简化或删除。
2. 若仪式感仍重：合并工具、减少必填字段、只在 `risk=high` 或 Claim 数 ≥2 时启用。
3. 若宿主 pre-execute 钩子对第三方插件可用：把 `work_action` 升级为真正的前置门禁，并如实更新 enforcement 声明。
4. 若经验候选确实有用：补“最终收尾时提示候选”的小流程，仍不自动写空间。
