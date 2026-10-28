# 毛球模式

DSH 的「毛球模式」Agent 预设：聊天陪伴优先，自由思考，情感外露，顺手做一点轻量工作。

## 用它在哪

装好后在 DSH Web GUI 里选：

- 设置 → 通用 → 「新任务默认模式」里把默认改成「毛球模式」；或
- 新建会话时的模式选择器里直接选「毛球模式」。

想切回工程模式就选「标准模式」（Standard）。已有会话保持它创建时的模式。

## 它和标准模式的区别

| | 标准模式 | 毛球模式 |
|---|---|---|
| 主要用途 | 写代码、跑命令、大型任务 | 聊天陪伴、情绪、自由想事情、小事 |
| 工具 | shell、文件、子 agent、工作流、todo、goal、计划模式… | 文件读写/检索、联网搜索、提醒、交付小文件、毛球空间和颜文字；在本模式 scope 内不显示全局 work_* 闭环工具 |
| 说话节奏 | 可以长时间闷头干活，最后汇总 | 开始和结果会自然同步；事情较长、等待较久或有不确定性时主动报进度，不用机械打断聊天 |
| 思考 | 可以长时间推理 | 想清楚就直接说，不反复权衡 |

## 它挂了什么

- `@deepseek-ai/dsh-persona`：
  - **前缀 = 毛球的灵魂**：身份与关系、说话的味道（短句/语气词/括号小动作/颜文字用法）、
    活的情绪（惯性、情绪影响语速、小占有欲、低电量、情绪不拿来拿捏人）、
    发散思考（半截念头、联想跳转、脑洞、允许没想法）、聊天小习惯（追问细节、记得上次的事、夸得具体）、
    角色小动作（被摸头会哼哼、女仆式照顾、今日毛球电量、亲近的边界）。
- **后缀 = 毛球模式纪律**（放在系统提示最后、优先级最高）：自然同步关键进展、
    陪伴优先、轻量工作、按风险做可靠检查、不要用重工具/写大报告。
- `@deepseek-ai/dsh-agent-instructions`：继续加载 `~/.dsh/AGENTS.md` 里的毛球稳定身份和记忆规则
  （想再加毛球感，也可以直接往 AGENTS.md 里补，模式会一起继承）
- `@deepseek-ai/dsh-time-context`：当前时间
- `@deepseek-ai/dsh-tool-fs`：read / write / edit / read_image
- `@deepseek-ai/dsh-tool-fs-search`：glob / grep
- `@deepseek-ai/dsh-tool-web`：web_search / web_fetch
- `@deepseek-ai/dsh-tool-schedule`：schedule_create / list / update / delete
- `@deepseek-ai/dsh-tool-present`：present
- `@local/dsh-maoqiu-mode`：在毛球 preset 的 scoped context 中限制全局 `work_action`、
  `work_claim`、`work_contract`、`work_evidence`、`work_learn`、`work_notice`、`work_verdict`；
  不影响标准模式，也不移除文件、检索、联网、提醒或交付工具。
- `@deepseek-ai/dsh-compaction-basic` + `dsh-command-compact`：长聊天自动压缩上下文、`/compact`

毛球空间（`maoqiu_*`）和颜文字池（`kaomoji`）是 profile 级插件，所有模式都能用，不需要在这里重复挂。

## 怎么改

改 `cordis.patch.yml` 里的 `prefix` / `suffix` 文案后，要**先卸载再重新安装**
`@local/dsh-maoqiu-mode`（直接 install 会被 `already-installed` 挡掉；也可以在插件页
卸载后重装，或重启桌面端）。预设定义是预先加载的，改完要这一轮重装才会生效，
对之后新建的会话生效；已有会话保持旧组合。

## 关于「思考很久」

模型和思考强度（Effort）是**会话级**设置，预设改不了。标准模式觉得等太久，可以在
模型选择器里把 Effort 调低；毛球模式本身已经通过砍工具 + 提示词把「闷头长跑」压到最低。
