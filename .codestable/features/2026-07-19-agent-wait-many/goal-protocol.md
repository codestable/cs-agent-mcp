---
doc_type: feature-goal-protocol
feature: 2026-07-19-agent-wait-many
status: complete
---

# Agent Wait Many Goal Protocol

## Recovery

每次恢复先读 design、checklist、goal-plan、goal-state，并用 git diff、测试产物、iteration evidence 和
ledger 校正状态；不重复执行 ledger 已完成的 step。

## Loop

1. 从第一个 pending step 开始，行为步骤严格执行 RED → GREEN → VERIFY。
2. 每步验证 exit signal、公开契约、清洁度和范围后，立即更新 checklist 与 goal-state ledger。
3. S1-S4 完成后生成 implementation evidence，运行 implementation gates，切换到 `review/ready`。
4. 进入 `cs-code-review`；独立审查有 blocking/important 时写 `review/fixing`，窄修复后重新审查。
5. review passed 后写 `qa/ready` 并进入 `cs-feat` QA；QA failed/blocked 时写 `qa/fixing`，修复后
   回到 review，依次重跑 review 与 QA。
6. QA passed 后写 `acceptance/ready`，由独立 Task agent 按 design 场景和 checklist 验收。
7. 所有检查通过后更新 checklist、长期文档和报告，先写 `complete/passed`，再输出
   `CS_FEATURE_GOAL_COMPLETE`。

## Goal Mode

goal 模式接管 implementation、review、QA、acceptance 的普通用户 checkpoint；只有命中 Handoff
条件才停止。Goal driver 不得自行批准 design，也不得省略独立代码审查或独立功能验收。

每个行为 step 都必须在 iteration evidence 中记录 RED、GREEN、VERIFY。确实不能 TDD 时必须写
`TDD exception`、原因和替代证据，否则 implementation gate 不通过。每次 stage/status 变化立即写回
goal-state；每完成一个 step 追加 ledger 项，`commit_range` 在未提交工作树中写
`working-tree (no commit requested)`。

## Constraints

- 公开 MCP 只有 `cs_agent_wait_many`；Facade wrappers 不扩张 MCP 工具数量。
- 单 snapshot 原子验证全部 Turn，任一 unknown/sibling 整批失败。
- all 权限/timeout 中断、调用方跨轮累计与稳定输入顺序必须保持。
- 每轮只建立一个 store revision waiter；无关 revision 唤醒后允许下一轮重建一个 waiter。
- timeout 不取消 Turn；Facade snapshot v1、旧 13 tools 与 Workspace 控制面不变。
- 不升级版本，不自动 commit、push、tag 或发布。

## Handoff

以下任一条件触发 owner-stop：改变 approved design、feature 范围或公开契约；独立 reviewer
pending/failed/blocked 且不能恢复；同一失败项三轮不通过；核心凭证或环境缺失；用户暂停或改方向。

触发时先把 goal-state 写为 `stage: handoff`、`status: blocked`，填写 `handoff_reason` 和
`handoff_next`，再输出：

```text
CS_FEATURE_GOAL_HANDOFF
Reason: <具体阻塞>
Next: <建议动作>
```
