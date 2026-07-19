---
doc_type: feature-goal-plan
feature: 2026-07-19-agent-wait-many
status: complete
created: 2026-07-19
---

# Agent Wait Many Goal Plan

## Inputs

- Design：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md`
- Checklist：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-checklist.yaml`
- Design review：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design-review.md`
- Baseline：`73a52d29ae0dabf9af854d3d8f47211f4dca0d6b`

用户于 2026-07-19 明确确认整体设计。独立 Task agent 经三轮设计审查后给出 blocking 0、
important 0，可以进入实现。

## Execution

- 严格按 S1-S4 推进，每步完成立即更新 checklist 与 goal-state ledger。
- 所有行为代码执行 RED → GREEN → VERIFY；不能先写实现再补测试。
- Facade 新增 `waitMany`、`waitAny`、`waitAll`；公开 MCP 只新增
  `cs_agent_wait_many(mode=any|all)`。
- 不修改 Facade snapshot v1，不新增 run/wait-any/wait-all MCP 工具，不实现 callback/webhook/outbox。
- 不升级版本，不自动 commit、push、tag 或发布。

## Core Evidence

- any 同轮返回全部 ready，all 等待全部终态；结果与 pending 均保持输入顺序。
- all 被权限或 timeout 中断后，两轮等待可按 Turn ID 累计完整结果。
- unknown/sibling Turn 整批失败，不泄露部分 ready 内容。
- 可计数 store 证明每轮只有一个 revision waiter。
- 真实 MCP SDK + ACP mock 多进程 E2E：文件 barrier 释放前至少两个不同 Agent Turn 同时 running。
- 自包含 tarball wrapper 临时安装包，发现 14 tools 并实际调用 wait-many。

## Validation

- `pnpm run build:test && node --test dist-test/test/mcp-facade.test.js dist-test/test/mcp-e2e.test.js`
- `pnpm run check`
- `pnpm run package:smoke:tarball`

定向验证必须记录非零通过数；package smoke 使用实际 `npm pack` tarball，不得直接运行源码或仅检查
tools/list。

## Gates

- Implementation：S1-S4 done，RED/GREEN/VERIFY evidence 和清洁度证据齐全。
- Review：独立 code review 分别确认 spec 合规与代码质量，无 unresolved blocking/important。
- QA：定向测试、全量 check、真实多进程 SDK E2E 与 tarball smoke 全部通过。
- Acceptance：独立 Task agent 按 12 个关键场景和 C01-C12 完成功能验收。

## Handoff

需要改变 approved design、公开契约或 feature 范围；独立 reviewer 无法完成；同一失败三轮不通过；
核心外部环境缺失；或用户要求暂停时，先写 `handoff/blocked` 再停止。
