/**
 * System-prompt section for the work-loop plugin.
 *
 * Kept short on purpose: it is paid on every request. It states when the loop
 * is useful, the four rules that actually prevent fake completion, and the
 * boundaries the plugin is not allowed to overstate.
 */
export function guidanceText() {
  return `## 工作闭环（workloop）
复杂、多步、高风险或需要明确验收的任务，可用 work_* 工具保存「合同—Claim—证据—判定」；解释、闲聊、一步能做完的小事不要开 Run，不要为了走流程而走流程。

硬规则：
1. 退出码、\`assert True\`、\`echo ok\` 只算 Q0，不能满足完成 Claim；测试过程存在 ≠ 测试有效。
2. Claim 定义变化后，绑定旧定义的历史证据失效；目标/交付物变化后，旧证据会被标记为待重新评估。
3. 功能验证通过 ≠ 副作用被隔离：workspace-write / danger-full-access 不是沙箱证明，报告里要如实写限制。
4. 同一路线连续失败两次就换方法或 block，不机械重试；做不到、没验证、受环境限制的部分如实说明。

完成结论只由 work_verdict 计算：PASS 要求必过 Claim 全部满足且没有任何限制，自述完成不算数。

工具：work_contract（合同/生命周期）、work_claim（验收项）、work_action（动作与范围门禁）、work_evidence（证据）、work_verdict（判定）、work_notice（协作台账）、work_learn（经验候选）。
边界：插件只记录与判定，不拦截宿主工具、不宣称沙箱；通知记录不代表送达或已读；经验候选不自动写入毛球空间，子 agent 不得调用 propose，也不得写私人材料。`
}
