# 2.0.0 验证记录

日期：2026-10-26。验证对象为本目录最终的自由字符画实现，不以原版测试替代新增功能验收。

## 已通过

| 验证 | 实际结果 |
|---|---|
| `node --test` | 22 项通过，失败 0，跳过 0 |
| `node scripts/check.mjs` | 16 个 JavaScript 文件语法检查通过，所有 JSON 可解析 |
| `node scripts/validate-pool.mjs` | 20 分类、738 条，违规 0；语料保留 |
| `node scripts/smoke.mjs` | 原 kaomoji 实现回归通过；此项单独测试 `kaomoji.js` |
| `node scripts/dsh-smoke.mjs` | 实际 DSH 0.2.1-rc.3 Node Host 集成通过，agent 错误 0 |

离线检查使用 Node 26.5.1；真实 Host 使用 DSH 随附 Node 24.21.0。Host 测试加载实际本地 `maoqiu-mode` 1.0.1 bundle，而非仅使用模拟 preset。

新增测试覆盖：原文空白和换行、Tab 展开、CJK/emoji/组合字素、代码围栏、透明与擦除、宽字符覆盖、任意图层顺序、几何边界、重复 id、越界报错、连续编辑、旧版本保持、失败原子性、作品隔离、历史淘汰、取消、按需指导、挂载/卸载和 preset 切换。

另在干净 Node 子进程跟踪模块解析：只创建工作 agent 时没有导入 `art/`、`kaomoji.js` 或 `pool.js`。

## 真实宿主检查

1. 工作 agent 没有 text_art / kaomoji schema，没有本技能条目或 `text-art:chat` 提示段。
2. 毛球 agent 能看到工具和原生技能；工具 schema 被实际宿主接受。
3. 空白会话在首轮前切换 maoqiu → standard → maoqiu，字符画贡献随之移除和恢复。
4. 实际 Agent 请求循环完成 guide → 自定义图层 draw → 局部 edit → 原文画；空格、反斜线、三个反引号及 `{{}}` 得以保留。
5. 聊天完成后，同一 Host 内工作 agent 仍无字符画工具和技能贡献。

该测试使用临时 DSH_HOME、profile、工作目录和脚本模型。没有加载真实 API key，没有改动真实毛球空间，也没有让脚本模型成为产品的一部分。通过说明工具调用链、作用域与文本处理可用，不说明真实模型已经具备特定美术水平。

最终一轮 Host 报告原始目录：`C:/Users/Lenovo/AppData/Local/Temp/text-art-dsh-IZMOiq`。交付目录的 `verification/dsh-host-report.json` 保存其报告副本；测试原画与局部修改输出也保留作可检查的调用链证据，不供生产工具检索。

## 尚未验证

- 未使用真实 DeepSeek 模型评测任意题材的可辨认度、动作表达、原创程度或长期一致性。
- 未进行 DSH 桌面渲染截图检查，Unicode 对齐仍受字体影响。
- 未读写真实毛球空间验证跨会话保存与重建。
- 未逐一验证 DSH 其他版本与 Node 最低声明版本。

已实现运行时技能与通用绘图工具；没有训练模型权重，也没有用测试结果宣称模型已经永久掌握绘画。
