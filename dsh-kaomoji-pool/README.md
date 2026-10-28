# DSH 自由字符画与颜文字 · 2.0.1

让 DSH 根据当前交流**自己构图、自己绘制，再继续修改**。字符画部分不提供角色成品库，不通过题材名返回现成图，也不接入另一个模型。保留原来的 738 条颜文字作为辅助能力。

包名仍是 `@local/kaomoji-pool`，bundle 行 id 仍是 `kaomoji-pool`。在 DSH 0.2.1-rc.4 的真实 Node Host 上完成过隔离集成验收，详见 `VALIDATION.md`。

## 能力如何组成

| 部分 | 职责 | 何时加载 |
|---|---|---|
| 自由字符画技能 `text-art-freehand` | 教 DSH 从意图出发，处理轮廓、姿态、接触、遮挡、场景、明暗和连续改画 | 毛球会话登记短摘要；读取技能时才加载正文 |
| `text_art` 工具 | 接受 DSH 自己写的原画或自定义图层，提供画布、几何线条、检查与编辑 | 毛球会话注册；实际绘图时才加载画布引擎 |
| `kaomoji` 工具 | 保留分类、跨类取样、去重、排除和最近记录 | 毛球会话才加载原颜文字模块 |
| 轻量模式桥 | 跟随 agent preset 挂载和移除贡献 | profile 启动时加载小入口 |

这是运行时技能指导与绘图工具的组合，不是修改或训练模型权重。模型仍需负责理解、想象和审美；画布检查通过不等于画得像。题材自由来自 DSH 自绘的任意文本和几何坐标，不依赖扩充案例条数。

## 在聊天里怎么用

切到毛球模式后，可以直接说：

- “自己画一幅毛球坐在漂浮的小岛上钓星星的字符画。”
- “保留刚才的主体，让它转身，把手里的东西改成一盏灯。”
- “做成上下两格，用动作表达变化，不要只换一句配文。”
- “把这幅画保存到空间，下次继续改。”

这些是创作要求，不是检索口令，没有对应预设作品。DSH 应先读取技能指导，再自主绘制，并在回复中展示成品。简单小图无需强制执行很多轮工具调用。

有原生 skill 工具时可读取 `text-art-freehand`。当前 preset 没有 skill 消费工具时，`text_art(action="guide")` 提供相同正文；不因此修改毛球原有 preset 的完整插件树。

## 自由字符画技能

主技能在 `skills/text-art-freehand/SKILL.md`，按需补充四个主题：

| `guide.topic` | 学习内容 |
|---|---|
| `basics` | 意图 → 视角与体量 → 外轮廓 → 内部结构 → 自检；画布使用方法 |
| `contours` | 锚点、逐行左右边界、弧线与斜率、部件连接和接触点 |
| `composition` | 前后遮挡、身体姿态、空间关系、分格与连续场景 |
| `shading` | 光源、疏密、接触阴影、材质和纹理 |
| `unicode` | 字素、列宽估计、字体回退和文本保护 |

技能只讲构造方法，不包含可供检索的角色图集。引擎也不接收“猫”“毛球”“小屋”等题材参数；所有可见内容由模型本轮提交。

## `text_art` 接口

| action | 输入 | 作用 |
|---|---|---|
| `guide` | 可选 `topic` | 按需读取上述画法与工具指导，不创建作品 |
| `draw` | `text` 或 `objects` 二选一 | 保存自主绘制的原文或通用图层，返回真实 `artId` |
| `edit` | `artId`（默认 `latest`），以及 `text` 或 `changes` | 整幅改写或局部编辑，生成新的 `artId` 并保留短期旧版本 |
| `check` | `text` | 检查列宽、行数与排版问题，不占作品历史 |
| `inspect` | 可选 `artId` | 回读成品及原始画布对象，方便继续修改 |

### 原文画

`draw` 的 `text` 是 DSH 自己写出的多行字符画。保留前导空格、行尾空格、空行和反斜线；统一 CRLF/CR 为 LF，Tab 按 4 列制表位展开。不会对字符画使用颜文字的 NFKC 或去空白归一化。

原文画可以通过 `edit(text=修改后的全文)` 继续创作。工具不会猜测原文中哪几个字符属于“左手”或“屋顶”；需要按部件编辑时，从一开始就使用图层。

### 自定义图层

每层可指定 `id`。坐标从左上角开始，x 是列、y 是行。数组后面的图层覆盖前面的图层。

| kind | 主要字段 | 内容 |
|---|---|---|
| `text` | `text`、可选 x/y/transparent | 任意自绘局部；不是从图集中选择部件 |
| `line` | x/y/x2/y2、可选 char | 任意起终点的网格直线 |
| `box` | x/y/width/height、可选 char/fill | 通用矩形边框和内部填充 |
| `ellipse` | x/y/width/height、可选 char/fill | 通用椭圆轮廓和内部填充 |

`text` 的空格默认透明；`transparent:false` 可以用空格擦掉下面的内容。char/fill 接受一个单列字素；多列符号放进自绘 text 图层。

`draw` 不指定 width/height 时按对象范围计算；指定后按实际尺寸检查。越界会说明哪个图层有问题，不自动裁切。`style: "unicode"` 只切换通用矩形框线，任意 text 内容始终由模型自绘。

局部 `edit.changes` 的规则：

- 已有 id：合并提供的字段，其余图层和字段保持。
- 新 id：带上 kind 与绘制字段，追加到前景。
- `{"id":"要删除的层","remove":true}`：删除指定图层。
- 修改 line 的位置时，同时更新 x/y 与 x2/y2。
- 新内容越过旧边界时，在 edit 顶层同时增大 width/height。

当前没有旋转、语义抠图、自动透视或照片转字符画。可以直接重画需要变化的 text 图层，不把这些能力包装成已实现。

### 作品状态与保存

默认每个 agent 保存最近 8 个版本，agent 之间隔离。`artId` 只在当前运行 agent 的内存历史中有效；重启、会话重新装载或版本淘汰后可能失效。工具本身不会写文件。

跨会话保存使用 DSH 已有文件工具或毛球空间工具：保存完整原文；需要继续按图层编辑时，也保存 `inspect.document`，下次用 `draw(objects=...)` 重建。毛球空间的摘要会压缩空白，只用于找作品，不能拿摘要恢复原画。保存和重建流程尚未在真实毛球空间中做端到端验收。

返回文本使用足够长的 Markdown 围栏保护；即使作品含三个反引号，也不会提前关闭代码块。最终展示应原样复制工具返回的画面。

## 模式与工作减负

默认 `activation: auto`，仅在 preset id 为 `maoqiu` 的根 agent 挂载能力。工作 preset（如 `standard`）不增加 `text_art` / `kaomoji` schema、不登记本技能、不注入本插件提示段，也不读取技能正文或导入画布/颜文字模块。

毛球空间是场景和存储工具，不是独立的休闲模式信号。工作会话仅仅读取了空间文件，不会因此启用字符画。遇到工作或严肃话题，毛球里的短提示也要求自然停止装饰。

支持 DSH rc.4（已实测） 在首轮开始前更换 preset 时，移除或恢复字符画贡献。首轮后的 preset 切换限制由 DSH 原生规则决定。若同一进程此前用过毛球，Node 已导入模块可能仍驻留缓存；这里实现的是工作请求和首次导入减负，不保证进程内存自动归零。

### 配置

profile `cordis.patch.yml` 按稳定行 id 覆盖：

```yaml
- id: kaomoji-pool
  name: '@local/kaomoji-pool'
  config:
    enabled: true
    activation: auto
    chatPresets: [maoqiu]
    includeSubagents: false
    art: true
    tool: true
    prompt: true
    maxWidth: 120
    maxHeight: 80
    historySize: 8
    defaultCount: 8
    maxCount: 24
    avoidRecent: 24
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关；false 时不挂载贡献 |
| `activation` | 默认 auto；scoped 只用于明确放进休闲 preset 的插件行，直接在该作用域挂载 |
| `chatPresets` | auto 允许的 preset id 列表。其他休闲模式使用真实 id 加入此处，不按聊天关键词猜模式 |
| `includeSubagents` | auto 默认不挂载子 agent；需要时显式开启 |
| `art` | 注册自由字符画技能与 text_art，默认 true |
| `tool` | 保留原含义：是否启用 kaomoji，默认 true |
| `prompt` | 是否注入一段短的聊天使用提示，默认 true |
| `maxWidth` / `maxHeight` | 默认 120×80；可配置范围 16–240 列、8–160 行 |
| `historySize` | 每个 agent 保留的版本数，默认 8，范围 1–32 |
| `defaultCount` / `maxCount` / `avoidRecent` | 原颜文字工具参数，默认 8 / 24 / 24 |

旧的 `inlineCategories` / `inlinePerCategory` 不再用于主入口的提示段：2.0 不把分类示例逐类塞进上下文。颜文字取样接口及语料保持兼容。不要同时在 profile 用 auto、又在毛球 preset 重复添加 scoped 行。

## 固定节奏与成本

每幅画按"draw 1 次 → check 1 次 → 最多 edit 2 次 → 交付"进行。`draw`/`check`/`edit` 的返回带 `pace`（按 agent 计数的 draws、redraws、checks、edits 和下一步提示）；draw 的提示要求交付前先调用 `check(elements=[...])` 核对要素。工具只提示，不会强行拦截调用。

插件本身不改模型配置。想压低思考开销，可以在 profile 的配置覆盖里给 `@deepseek-ai/dsh-agent-default-model` 设 `reasoningEffort: low`（DeepSeek 适配器接受 `off | low | high | max`）。dsh 0.2.1-rc.4 的配置 schema 里没有限制 agent 轮数的字段。

## 安装与更新

插件没有生产第三方依赖，也不需要新增模型或 API key。Node 声明最低 22.13.0，本次实际 Host 使用 DSH 随附 Node 24.21.0；其他 DSH 版本未逐一验证。

本机原来通过 link 安装了同包名插件，指向 `C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/dsh-kaomoji-pool`。更新该目录后，现有 profile 和 junction 可以继续使用；不需要改毛球 preset 的插件树。

在其他环境首次安装：解压到固定位置，通过 DSH 的插件管理器将这个目录作为本地 bundle 安装。保留目录，避免 link 失效。ESM 代码变更应在重启 DSH 后验证；已经开始的旧对话可能保留旧的上下文内容，建议新建毛球对话检查新技能。

## 验证与边界

在插件目录执行：

```powershell
node --test
node scripts/check.mjs
node scripts/validate-pool.mjs
node scripts/smoke.mjs
```

真实宿主验收另需提供本机已有 DSH 的 `lib/bin.js`，不会自动安装或联网下载：

```powershell
$env:DSH_ENTRY = '你的DSH目录/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
$env:DSH_NODE = '你的DSH随附Node路径/node.exe'
# 可选：验证已有毛球 bundle；不提供时使用同 id 的最小测试 preset。
$env:DSH_MAOQIU_BUNDLE = '你的maoqiu-mode目录'
node scripts/dsh-smoke.mjs
```

该脚本复制到隔离临时 profile，清除真实 API 凭据环境，使用脚本模型，保留报告和画布输出，再关闭自己启动的子进程。它验证真实 schema、技能作用域、Agent 工具调用链和文本保真，**不证明真实模型能把任意题材画好**。测试脚本里的少量图形是调用链路测试输入，不会被生产工具读取。

Unicode 使用字素分段与列宽估计；实际 DSH 字体、emoji 回退和窗口宽度仍会影响显示。未进行桌面渲染截图验收；严格对齐的作品优先使用 ASCII。

## 文件职责

`index.js` 是轻量模式桥；`art/` 是通用画布、工具和指导读取；`skills/` 是可学习的画法；`kaomoji.js` 与 `pool.js` 保留原工具实现和原语料；`test/` 与 `scripts/fixtures/` 只做验证。
