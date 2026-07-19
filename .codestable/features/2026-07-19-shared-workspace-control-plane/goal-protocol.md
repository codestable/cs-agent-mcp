---
doc_type: feature-goal-protocol
feature: 2026-07-19-shared-workspace-control-plane
status: complete
---

# Workspace 共享控制面 Goal Protocol

## Recovery

每次恢复先读 design、checklist、goal-plan、goal-state，并以 git diff、测试产物和 ledger校正状态。

## Loop

1. 从第一个 pending step开始，行为步骤执行 RED → GREEN → VERIFY。
2. 每步验证退出信号、清洁度和范围后，立即更新 checklist与 ledger。
3. S0-S6完成后生成 evidence pack，切换到 review/ready。
4. 独立 code review有 blocking/important时进入 review/fixing，窄修复后重审。
5. review passed后进入 QA；QA失败则修复并重跑 review+QA。
6. QA passed后进入 acceptance，同步长期文档与 requirement。
7. 全部通过后写 complete/passed并输出 `CS_FEATURE_GOAL_COMPLETE`。

## Constraints

- 单 Workspace始终只有一个 Facade写者；不得用多进程共享 snapshot替代 Broker。
- 根 Broker session与 managed loopback认证、SSE和 actor语义分离。
- reverse-ready有界失败，不误报 roots非法；grace期间不释放/重取 Workspace lock。
- diagnostics/TUI保持跨 Workspace只读，不连接 Broker或持有 credential。
- 不自动 commit、push、tag或发布。

## Handoff

设计/范围/公开契约变化、独立 reviewer阻塞、同项三轮失败、核心外部环境缺失或用户暂停时，先更新
goal-state为 handoff/blocked，再输出 `CS_FEATURE_GOAL_HANDOFF`。
