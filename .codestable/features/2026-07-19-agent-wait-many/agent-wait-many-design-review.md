---
doc_type: feature-design-review
feature: 2026-07-19-agent-wait-many
status: passed
reviewed: 2026-07-19
round: 3
---

# Agent Wait Many feature design 审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md`
- Checklist: `.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-checklist.yaml`
- Intent / brainstorm: none
- Roadmap / requirement: none；本次是现有并发编排接口深化，不新增产品愿景
- Related docs: `README.md`、`docs/MCP_ARCHITECTURE.md`
- Code facts checked: `src/mcp/facade/facade.ts`、`src/mcp/facade/store.ts`、
  `src/mcp/facade/types.ts`、`src/mcp/transport/server.ts`、`scripts/package-smoke.mjs`、
  `test/mcp-e2e.test.ts`、`test/mock-agent.ts`、`.github/workflows/ci.yml`
- Compound: 未发现 wait-many / wait-any / wait-all 相关条目

### Independent Review

- Status: completed
- Detection: native-agent
- Provider / agent: `/root/wait_many_design_review`
- Raw output: Round 1 提出 6 项 important；Round 2 复核后剩余 2 项 important；Round 3 确认
  blocking 与 important 均为 0
- Merge policy: 主 agent 已逐条结合 design、checklist 和代码事实核验；修订后每轮均重新交由同一独立
  Task agent 只读复审
- Gate effect: none；可以进入 owner design confirmation
- Tool note: codebase-memory MCP 本轮返回 `Transport closed`，按 AGENTS.md 降级为只读文本搜索

## 2. Design Summary

- Goal: 为已异步 fan-out 的多个 Turn 提供统一 fan-in；公开 MCP 增加一个
  `cs_agent_wait_many(mode=any|all)`，Facade 封装 `waitMany`、`waitAny`、`waitAll`
- Key contracts: raw 1-64 IDs、首次顺序去重、单 snapshot 原子鉴权、稳定结果顺序、all 权限/timeout
  可中断并由调用方跨轮累计、每轮仅一个 store waiter
- Steps: 4 个；依次覆盖契约骨架、批量投影、并发等待、发布契约
- Checks: 12 个；覆盖工具面、Facade wrappers、等待语义、安全边界、并发证据、tarball 与兼容性
- Baseline / validation: 基线 `pnpm run check` 255/255；完成后运行全量 check、目标测试文件和自包含
  tarball smoke

## 3. Findings

### blocking

无。

### important

无。

### nit

无未处理项。

### suggestion

- [ ] FDR-001 `agent-wait-many-design.md#2.3` 实现 S4 时让
      `.github/workflows/release.yml` 也复用 `package:smoke:tarball`，避免 release 与本地/CI 的
      pack/install/env recipe 漂移；不阻塞设计确认。

### learning

- 顺序完成多个 `send` 不会串行化 Turn；`send` 返回 receipt 后由 Facade 异步调度。测试在 barrier
  释放前观察不同 Agent 的多个 Turn 同时为 running，足以证明 fan-out。

### praise

- 一个公开 wait-many 工具配合 Facade 三个方法，在保持 MCP 工具面紧凑的同时提供了明确的编程接口。
- 批量鉴权先于任何投影、单 revision waiter 和输入顺序稳定都与现有 Facade 所有权边界一致。

## 4. User Review Focus

- 用户需要重点拍板：公开 MCP 只增加 `cs_agent_wait_many`；`waitAny` / `waitAll` 仅作为 Facade
  便捷方法，不额外增加两个 MCP 工具。
- 用户需要重点拍板：all 是可被权限或 timeout 中断的等待；调用方按 Turn ID 跨轮累计 ready，后续
  message / terminal 覆盖较早的 action_required。
- implement 需要重点遵守：每轮单 snapshot 原子验证、单 store waiter、raw 1-64 边界、稳定顺序、
  timeout 不取消 Turn。
- code review / QA / acceptance 需要重点复核：文件 barrier 真实并发证据、timeout/权限两轮累计、
  tarball wrapper 失败清理和实际 wait-many 调用。

## 5. Evidence Confidence Ledger

| Check                         | Verdict | Evidence Class | Basis                                     | Follow-up               |
| ----------------------------- | ------- | -------------- | ----------------------------------------- | ----------------------- |
| Acceptance Coverage Matrix    | pass    | E              | design 3.1/3.3 覆盖 12 个场景及 step/命令 | QA 逐项取证             |
| DoD Contract                  | pass    | E              | design 3.4 与 checklist dod 对齐          | 实现 S4 新增 wrapper    |
| Steps and checks traceability | pass    | E              | 4 steps、12 checks 均指向具体契约或场景   | none                    |
| Roadmap contract compliance   | pass    | E              | 无 roadmap 输入                           | none                    |
| Module/interface design       | pass    | C              | 现有 Facade、store、MCP server 代码事实   | review 核对 helper 边界 |
| Baseline and validation       | pass    | C              | 255/255 基线及三个可执行命令              | QA 记录非零通过数       |
| Independent review gate       | pass    | E              | native Task agent Round 1-3 输出          | none                    |

## 6. Round History

- Round 1：6 important，覆盖累计语义、runtime instructions、单 waiter、真实 E2E、输入边界和 DoD。
- Round 2：4 项关闭；剩余 timeout 后累计与自包含 tarball wrapper 2 important。
- Round 3：2 项关闭；blocking 0、important 0，建议进入 owner design confirmation。

## 7. Verdict

`passed`。设计与 checklist 已具备实现、独立代码审查、QA 和功能验收所需的可证伪契约；design
仍保持 `draft`，必须等待 owner 整体确认后才能进入 goal package 和实现。
