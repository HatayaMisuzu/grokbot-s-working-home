# 毛球模式（已并入 dsh-maoqiu 0.4.0）

`@local/dsh-maoqiu-mode` 已停止维护。毛球模式预设（preset id `maoqiu`）和 `work_*` 屏蔽（`restrictWorkloop`）从 0.4.0 起随 [`dsh-maoqiu`](../dsh-maoqiu/README.md) 一起安装：

- 预设：`dsh-maoqiu/cordis.patch.yml` 中的 `preset-maoqiu`
- 屏蔽逻辑：`dsh-maoqiu/lib/mode.js`（Loader 名 `dsh-maoqiu/mode`）
- 测试：`dsh-maoqiu/test/mode.test.js`、`dsh-maoqiu/test/preset.test.js`

本目录不再包含可安装代码，避免两个同名 `maoqiu` 预设同时注册。

## 升级步骤

1. 先卸载旧包：`plugin_manager(action="remove_bundle", target="@local/dsh-maoqiu-mode")`。两个包都声明 preset id `maoqiu`，不卸载会导致预设注册失败。
2. 若已装 dsh-maoqiu 0.3.x，再 `remove_bundle dsh-maoqiu`，然后 `install_bundle` 指向新的 `dsh-maoqiu` 目录（0.4.0）。毛球空间数据（`home`）不受卸载影响。
3. 新建会话选择「毛球模式」。已有会话保持创建时的组合。

## 旧版已知问题：`work_*` 屏蔽可能静默失效

旧 `@local/dsh-maoqiu-mode` 在预设作用域激活时调用 `tools.restrict({ deny: [work_*] })`。如果 workloop 的工具在这之后才注册（加载顺序靠后，或之后热安装），DSH 会因名字未知而拒绝这次屏蔽，旧插件没有重试，毛球模式里就会照样露出 `work_*`。在 dsh 0.2.1-rc.4 上已复现。

0.4.0 的 `dsh-maoqiu/lib/mode.js` 先屏蔽已经注册的那部分，再在 `tools/change` 时重新同步，所以加载顺序不再影响结果。联测见 `dsh-plugins-team/maoqiu/03-smoke-and-joint.md`（6 种顺序结果一致）。还在用旧包的话，请按上面的步骤升级，不要只调整加载顺序来绕开。
