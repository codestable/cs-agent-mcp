---
doc_type: issue-acceptance
issue: 2026-07-19-prompt-timeout-partial-success
status: passed
accepted: 2026-07-19
auditor: cs-agent-mcp-claude-codex
round: 2
---

# prompt-timeout-partial-success 功能验收报告

## 1. 验收范围

- 问题报告、确认的组合修复方案、fix-note 与独立代码审查报告
- MCP send、Facade Turn/Message 投影、ACP prompt timeout、事件与持久化兼容边界
- 正式 unit/integration/E2E、全量质量门、tarball 临时安装 smoke
- 当前全局安装驱动的真实 Claude/Codex 双 review 与 runtime timeout 临时集成

Auditor：Round 5 由当前全局安装的 CS Agent MCP 创建 Claude 与 Codex 独立 reviewer；主 Agent 只负责事实核验与汇总。

## 2. 验收检查

- [x] C01：`cs_agent_send.timeoutMs` 不进入新 Turn、不传 runtime，也不限制任务完成。
- [x] C02：同一逻辑任务和 idempotency key 仅 timeout 不同时复用原 receipt。
- [x] C03：当前全局安装创建的 Claude/Codex review 均返回完整 Message，新 Turn 不含 `timeoutMs`。
- [x] C04：runtime 全局 timeout 命中后为 `failed/TIMEOUT`，无最终 Message/resultMessageId，部分 text event 仍保留。
- [x] C05：single wait、wait-many、events 与 diagnostics 以真实 Turn/Message 终态为准，不把部分事件投影成最终回复。
- [x] C06：Facade snapshot v1 保持兼容；旧 `Turn.timeoutMs` 字段仍可读取但执行忽略。
- [x] C07：`pnpm run check`、tarball 临时安装和 MCP SDK 14 tools smoke 证据互相一致。
- [x] C08：README、架构文档与 CHANGELOG 和实现一致；没有新增 task deadline API。
- [x] C09：本 issue 未回滚或破坏 wait-many 与 shared Workspace 行为。
- [x] C10：升级前含 timeout 的旧 fingerprint 可复用并惰性迁移；损坏 timeout、错误 Turn/Message 关联与内部 ID 不一致均 fail closed。

## 3. 真实功能证据

- Send timeout：stdio/mock-ACP 的 `sleep 100` 配 `timeoutMs: 50` 返回完整 `slept 100ms` Message。
- Runtime timeout：当前全局安装 + 临时 HOME + mock ACP + `timeout: 0.5`，执行 `stream-sleep 1500 partial-review`；结果为 `terminal_without_message`、Turn `failed/TIMEOUT`、无 `resultMessageId`，events 含 `partial-review`。
- 真实 Agent：Claude Turn `306042d0-0f5c-4cd5-9ec5-abf46e4dff20` 与 Codex Turn `fe47a5bb-4ac2-42c6-9e05-f7c17d103ec1` 均 `completed`，Message 长度 2608/2747，首行为 `VERDICT: PASS`，Turn 不含 `timeoutMs`。
- Package smoke：实际 tarball 临时安装输出 `toolCount:14`、`waitMany:ok`、`lifecycle:ok`、`diagnostics:ok`。
- 独立审查：Round 5 Claude Turn `5afbef77-98e2-4a9a-92a6-73e86da77fae` 与 Codex Turn `d9575cb7-a07a-41f6-83a2-4ebc07529343` 均返回完整 `VERDICT: PASS`，无 blocking/important。
- 跨版本幂等：合法旧 snapshot 回放会复用 receipt 并迁移到新 fingerprint；malformed timeout、错误 target Turn 与内部 ID 损坏均返回 `IDEMPOTENCY_CONFLICT`。
- 当前门禁：`pnpm run check` 273/273；全局/工作区 binary SHA-256 均为 `e42a31d5f4f467cb4e77876081087b79ba3e6af79eb058954efcea502d32262e`。

## 4. Cleanup 核验

- Round 5 harness 对两个 reviewer 执行普通 destroy，结束后 `cs-agent-mcp agents list --json` 返回空数组。
- 手工 `npm pack` tarball 在最终核验后删除；`git diff --check` 作为收尾门禁执行。

## 5. Blocking / Important

- blocking：none
- important：none

## 6. Residual Risk

- 旧 snapshot 的 timeout fingerprint 兼容与损坏关联 fail-closed 已有定向回归；文件 store 的逐字段深层 schema 校验仍保持 v1 既有边界。
- Windows `.cmd` 路径有纯函数回归，但本机无法执行 Windows 实机 tarball E2E。
- 独立公开 task deadline 仍未设计；当前只允许全局 runtime timeout、显式 cancel 和 maxTurns 管理任务。

## 7. Verdict

PASS。修复满足问题报告的期望行为，代码审查、功能验收、全量检查、tarball smoke 和真实 Agent dogfood 均无 blocking/important。
