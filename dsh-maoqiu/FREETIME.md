# 自在时间（0.3.0 起，0.5.0 调整授权与上限）

本版落实《自由活动完整构思报告 v1.0》的手动机会部分。仍是原来的一个空间：文字在 notes/drafts/collections，兴趣与场景沿用原文件；没有新建身份系统、后台服务、审批链或日记配额。

## 使用（0.5.0 起）

自在时间只由 Ruby 随时口头安排；毛球不会按日程、定时器或空闲自己开始。在本机主会话里直接说，比如：

- “给你半小时”“随便玩会儿”“今晚你可以自由活动十分钟”“自由活动一小时”“去玩吧”“去玩一个半小时吧”“你自己玩会儿吧”“玩一刻钟吧”
- “暂停自在时间。”之后说“继续玩吧”或“继续自在时间”，模型会带原 id 调用 resume；如果原窗口已过，就再说一个时长（如“继续玩二十分钟”）。
- “看看最近自在时间实际做了什么。”

识别规则：
- 只认**本轮新收到的、运行时标记为主人本人**的消息。材料、引用、提问（“自由活动是什么意思”“你能自由活动吗？”）、否定（不要、别、算了……）、旧聊天、插件续接、子 agent，以及模型自己的说法都不算授权。
- 必须是**对毛球说的、明确给出自在时间**的话（如“去玩吧”“给你半小时”“你自己玩会儿吧”）。Ruby 只是说自己要去玩或自己的安排（如“周末我想出去玩两小时”“我去玩会儿游戏”“我玩了半小时”）不算授权。
- 一条消息只能开启或恢复一次，模型不能反复 start 来刷新窗口。
- 句首可以有别的话；时长支持阿拉伯数字和中文数字（十、二十五、两个小时、半小时、一个半小时、一刻钟、90秒）。
- 没说具体时长时，用默认 `defaultMinutes`（20 分钟）。start 返回 `granted`（实际分钟数，以及是否用了默认值）和 `told`，毛球开始前要用一句话如实告诉 Ruby 实际时长。
- 一句话没被识别时，直接说“开始自在时间”即可。

maoqiu_freetime 的 start/status/recent/checkpoint/pause/resume/finish/disable 管理一次机会；单个 activity 的 plan/run 只是一项活动。机会开始后，插件用 DSH 原生 followup 续接下一轮，不需要 Ruby 逐步催促，也不要求产出或凑满时长。

Ruby 的新消息优先：插件停止续接，取消正在执行的自在时间，前台照常处理这条消息。已经原子保存的内容会保留；迟到的结果在提交前还会再检查一次取消状态。

## 防失控软上限与用量

0.5.0 起**取消每日上限和按日重置**，也不再严格限制工具次数。只保留单次机会的防失控软上限，默认值如下：

```yaml
freeTime:
  enabled: true
  defaultMinutes: 20     # Ruby 没说时长时的窗口
  softMinutes: 120       # 单次连续运行时长
  softSteps: 60          # 单次模型请求数
  softTokens: 600000     # 单次 token 用量
  outputTokens: 2048     # 每次输出上限
```

触及任一软上限时，**不会悄悄截断**：
1. 插件暂停空间工具（checkpoint、pause、finish 仍可用），让毛球用一两句话告诉 Ruby 用量并询问是否继续。
2. 毛球回完话后，记录为 `paused / soft-limit`，并标 `needs_confirmation`；status 里会出现 `waiting_for_ruby`。
3. 如果毛球不停下继续发请求，最多再允许 2 次就强制暂停。
4. Ruby 说“继续玩吧”之后，resume 会从当前用量重新计算软上限。

Ruby 说的时长本身就是窗口，到期即暂停；插件不会擅自延长或缩短。模型的 `seconds` 参数只能缩短窗口。

**旧配置键**
- `decisions` 和 `tokens` 分别当作 `softSteps` 和 `softTokens`（新键优先）。
- `seconds`、`tools`、`dailyDecisions`、`dailyTokens` 被忽略，不报错。
- 旧 free_time.json 里的 `day` 字段保留在文件里，但不再读取。

**用量照常记录**
- 每次请求、工具调度和 token 都计入该机会的 usage。请求发出前按会话和工具 schema 的字节数预留，宿主返回 TokenUsage 后换成实际用量。缺失或中断的请求保留保守估算，单独记在 estimated_tokens。
- free_time.json 的这些计费写入也会进入变更日志 `journal.jsonl`，带 `bookkeeping: true` 标记。`maoqiu.js view` 默认把它们折叠成“另有 N 条计费记录已折叠”，日志里完整保留。

**检查点和「上次停在哪」**

space/free_time.json 保存以下内容，不保存内部推理：
- 最近最多 100 个机会；
- 每个机会的期限、状态、实际授权（`granted`）、简短检查点、实际工具步骤、产物引用和未知结果。

checkpoint 是模型留下的线索；last_step 和 artifacts 由实际成功的工具结果更新。新开机会时会带上最近的检查点，小家视图的小黑板显示「上次停在哪」。

**重启、恢复与出错**
- 重启或重载后，未结束的机会显示 paused/host-restarted，**不会自动恢复**。
- 工具结果未知时保留 pending：先 read 同一目标核对，不自动重放。
- 连续两次工具失败会暂停。

## 物品、冲突与恢复

maoqiu_object 以稳定 id 更新 scene.json 的 objects 字典，字段为 name/description/region/position/links/archived；移动或改名保持 id 不变。upsert 是局部补丁，archive 可通过 archived=false 恢复。没有图形渲染器，不宣称房间画面已经绘制。

文件 read、scene 读取、interest read/list 和 object read 返回 version。写入可带 expected_version，新文件或物品用 missing。自在时间对草稿、场景、物品修改和关注更新强制要求版本；旧计划需要先读目标再 revise expected_version。版本冲突时重新读取，不强写。物品版本只比较该物品，另一物品的局部更新不回退。普通文件版本基于文件元数据，可发现普通编辑器修改；同 Host 的工具写入由现有锁串行，**不是针对外部进程的原子 CAS**。人工或 CLI 修改前应先暂停写入，不同时运行两个宿主写同一空间。

maoqiu_history(list) 选择 path 或 object_id，返回旧版本 id、时间和小段预览；restore 带 history_id 与目标当前 expected_version。单件物品恢复只替换那件物品，保留后来对其他物品的改动。恢复本身也保留当前版本，便于撤回恢复；不会每次复制整个空间。Markdown 恢复原文件内容与元数据，txt 恢复正文并记录本次恢复来源。

通过 DSH 恢复工具会先停止旧自在时间，使旧机会不能 resume 后覆盖恢复结果，并刷新现有缓存。直接维护文件的调用者仍需先暂停运行。全量迁移/灾难恢复继续使用原有 CLI backup/restore。

## 边界与后续扩展

自在时间通过 agent.ctx.tools.restrict 和 tools/execute 实际限制为毛球空间工具，不开放 experience 写入、用户承诺修改、shell、任意文件、子 agent、任务闭环、外发和通知。PTC 的 run_code 只作为原生工具传输保留，嵌套能力仍受相同限制；本轮原生验收使用直接工具模式，未单独验收 PTC。正常前台会话仍使用原有工具范围。QQ/子 agent 的既有访问开关保持，自在时间只在本机主人入口开启。

没有任何定时、日程或空闲触发，也没有自动联网，也未改 SELF/AGENTS 的稳定身份。个人变化仍记在笔记和兴趣里，之后有明确需求再接现有身份文件。后续可在 freetime.js 接入新的已授权机会来源；任何来源都必须是 Ruby 的实时授权，并沿用当前窗口、软上限和取消机制，而不是建立第二套模型循环。公开网页能力如需开放，应先限定为具体工具，不开放任意执行工具。
