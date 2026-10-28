# grokbot-s-working-home

四个 DSH（DeepSeek Harness）插件的源码快照，每个插件一个独立目录，互不覆盖，可单独安装。

| 目录 | 插件 | 包名 | 版本 | 作用 |
|---|---|---|---|---|
| [`dsh-workloop/`](dsh-workloop/) | 工作闭环 | `@local/workloop` | 0.1.1 | 合同 · Claim · 证据 · 判定，给出诚实的完成结论；附带动作台账、协作通知与经验候选 |
| [`dsh-kaomoji-pool/`](dsh-kaomoji-pool/) | 颜文字 | `@local/kaomoji-pool` | 2.0.0 | 颜文字池（738 条）＋ `text_art` 自由字符画工具与 `text-art-freehand` 技能 |
| [`dsh-maoqiu/`](dsh-maoqiu/) | 毛球空间 | `dsh-maoqiu` | 0.3.0 | 有范围的经验、关注与材料空间；按话题自动召回；有预算的连续自在时间 |
| [`maoqiu-mode/`](maoqiu-mode/) | 毛球模式 | `@local/dsh-maoqiu-mode` | 1.0.1 | 「毛球模式」Agent 预设：聊天陪伴优先、自由思考、顺手做轻量工作 |

## 目录内容

每个目录都是一份可直接安装的插件源码，包含 `package.json`、`cordis.patch.yml`、入口文件、`locale/`、`test/` 与各自的 `README.md`。不含 `node_modules`、构建产物和个人数据。

- 工作闭环的运行数据在 `$DSH_HOME/work`（通常 `~/.dsh/work`）。
- 毛球空间的经验、材料与活动数据在插件 home（默认 `E:\maoqiu_home`），不在本仓库。
- 颜文字池的字符画由模型实时绘制，不含预置成品图集。

## 安装

依赖 DSH `>= 0.2.1-rc.3`、Node.js `>= 22.13`（以各 `package.json` 的 `engines` 为准）。

在 DSH 内用原生插件管理器安装源码目录：

```text
plugin_manager(action="install_bundle", target="<本仓库某插件目录的绝对路径>")
```

或在 profile 的 `package.json` 中 link 本地目录后重载插件。四个插件互相独立，可只装其中一个。

## 说明

- 这是临时仓库，内容为当前本地生效版本的源码快照，不代表上游版本管理历史。
- 各插件具体用法、验收记录与限制，见对应目录内的 `README.md` / `VALIDATION.md`。