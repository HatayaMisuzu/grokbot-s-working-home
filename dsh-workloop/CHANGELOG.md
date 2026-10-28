# Changelog

## 0.2.0 — 2026-10-28

### 新增
- 宿主证据：监听 dsh `tools/post-execute`，采集前台 `bash` 调用的命令、退出码、输出尾部/sha256 与测试数（`lib/host.js`）。钩子只记录、原样放行。
- `work_evidence action=captures` 列出本会话宿主采集；`observed.captureId` 可显式引用 `HX-n`。
- 配置项 `hostEvidence`（默认 true）、`captureTools`（默认 `[bash]`）。

### 变更（判定语义）
- `tests_pass` / `command_output` 证据没有匹配的宿主采集时视为模型自报，最高 Q1；有匹配时命令、退出码、测试数以宿主为准。
- `engines.dsh` 收紧为 `>=0.2.1-rc.2 <=0.2.1-rc.4`。
- README / cordis.patch.yml 中的个人硬编码路径改为 `<DSH_HOME>` 占位符。

### 测试
- 新增 `test/host.test.js`（7 个用例）；共 55 个用例。

## 0.1.1
- 首个导入版本（合同、Claim、证据分级、判定、通知、经验候选）。
