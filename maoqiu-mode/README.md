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
