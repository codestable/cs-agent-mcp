---
doc_type: feature-goal-plan
feature: 2026-07-19-shared-workspace-control-plane
status: complete
created: 2026-07-19
---

# Workspace 共享控制面 Goal Plan

## Inputs

- Design：`.codestable/features/2026-07-19-shared-workspace-control-plane/shared-workspace-control-plane-design.md`
- Checklist：`.codestable/features/2026-07-19-shared-workspace-control-plane/shared-workspace-control-plane-checklist.yaml`
- Design review：`.codestable/features/2026-07-19-shared-workspace-control-plane/shared-workspace-control-plane-design-review.md`
- Baseline：`3a5f14466a15c6b961dce45900fd0988c4f40964`

用户于 2026-07-19 确认共享 Agent 树、Top 跨 Workspace 和最终设计。Claude Opus 4.8 high thinking
独立审查 Round 2 为 passed。

## Execution

- 严格按 S0-S6 推进；每步完成立即更新 checklist 和 goal-state ledger。
- 行为步骤执行 RED → GREEN → VERIFY；纯搬迁 S0 记录 TDD exception 并用类型、现有测试和 diff 证明。
- 不改变 13 tools、Facade v1、diagnostics v1、runtime 支持矩阵或 diagnostics 只读边界。
- 不自动 commit、push、tag 或发布；用户明确要求后再执行交付动作。

## Core Evidence

- 双 stdio SDK client 同 Workspace 交叉管理 Agent。
- 单 Broker pid、单 Workspace lock token、首连接退出后长 Turn继续。
- roots reverse-ready 延迟、GET 405、SSE断开和 session id隔离。
- 不同 Workspace隔离、Broker/frontend SIGKILL、版本冲突、credential脱敏。
- Top跨 Workspace、tarball smoke、TUI PTY和 Codex/Claude实机。

## Validation

- `pnpm run check`
- 定向 Node test runner
- `pnpm run test:tui-e2e`
- `pnpm run package:smoke`
- tarball临时全局安装

## Gates

- Implementation：S0-S6 done，RED/GREEN/VERIFY或 TDD exception证据齐全。
- Review：独立 code review无 unresolved blocking/important。
- QA：17个验收场景和 C01-C18有证据。
- Acceptance：文档、requirements、checklist和最终 diff一致。

## Handoff

需要改变 approved design、公开 schema/错误语义、同一失败三轮不通过、外部环境阻断核心实机验证，
或用户要求暂停时，写 `handoff/blocked` 后停止。
