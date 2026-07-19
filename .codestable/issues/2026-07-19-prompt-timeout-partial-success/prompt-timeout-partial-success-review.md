---
doc_type: issue-review
issue: 2026-07-19-prompt-timeout-partial-success
status: passed
reviewer: subagent
reviewed: 2026-07-19
round: 5
---

# prompt-timeout-partial-success 代码审查报告

## 1. Scope And Inputs

- Report：`prompt-timeout-partial-success-report.md`
- Analysis：`prompt-timeout-partial-success-analysis.md`
- Fix note：`prompt-timeout-partial-success-fix-note.md`
- Evidence：TDD 红绿记录、`pnpm run check`、tarball smoke、当前全局安装驱动的真实 MCP 双 Agent review
- Diff basis：当前工作树中可归因于本 issue 的 timeout、旧 fingerprint 兼容与测试改动
- Baseline dirty files：`agent-wait-many` feature 及 shared Workspace 既有改动不归本轮复审，未回滚或重审

### Independent Review

- Detection：按 owner 要求，用当前全局安装的 `cs-agent-mcp 0.2.4` 并行创建 Claude 与 Codex
- 环节 A：completed；Claude Agent `ba85d07d-6ed2-48cc-a468-8d93f77ebea7` / Turn `5afbef77-98e2-4a9a-92a6-73e86da77fae`，Codex Agent `4b433f38-ce83-408e-a7a2-c36ec6f14d53` / Turn `d9575cb7-a07a-41f6-83a2-4ebc07529343`
- 环节 B OCR CLI：`skipped-scope-ambiguous`；工作树包含本 issue 之外的既有 dirty scope，协议禁止裸扫
- Merge policy：两份最终 Message 均逐条按源码、测试和门禁输出本地核验；两者均为 `VERDICT: PASS`
- Gate effect：独立 reviewer 已完成，OCR 跳过不阻塞，`reviewer: subagent`

## 2. Diff Summary

- 产品修复：`src/mcp/facade/facade.ts`、`src/mcp/transport/server.ts`、`src/runtime/engine/prompt-turn.ts`、`src/session/conversation-model.ts`
- 测试：`test/mcp-facade.test.ts`、`test/runtime-manager.test.ts`、`test/mcp-e2e.test.ts`
- 文档：`README.md`、`docs/MCP_ARCHITECTURE.md`、`CHANGELOG.md`
- Issue 工件：report、analysis、fix-note、review、acceptance
- 风险热点：失败终态完整性、旧 snapshot v1、跨版本幂等 fingerprint、损坏持久化关联的 fail-closed 行为

## 3. Adversarial Pass

- 假设的生产 bug：旧 snapshot 的 fingerprint 迁移在损坏 timeout 或 receipt/Turn/Message 关联下错误放行
- 主动攻击：`null/string/object/0/负数/小数/超限/缺失` timeout、错误 Turn、内部 `turnId/messageId` 不一致、内容变化、旧/新 fingerprint 交叉重试
- 结果：前两轮复审分别发现 REV-001 跨版本冲突和 REV-001-MALFORMED；均已用先红后绿的回归修复。Round 5 未发现新的 blocking/important

## 4. Findings

### blocking

none

### important

none

### nit

none

### suggestion

- 后续可补 attachments-only 的 legacy 冲突专用测试；当前实现同时通过 linkage payload 和 fingerprint 校验，风险低，不阻塞本 issue。

### learning

- 改变持久化幂等 fingerprint 的字段组成必须同时设计旧记录回放；兼容迁移只能在旧格式与完整实体关联均精确匹配时执行。

### praise

- runtime timeout 的部分事件与最终 Message 在 Facade 层明确分离，失败 Turn 不会因存在输出而伪成功。
- legacy 迁移对合法旧 snapshot 保持可用，同时对损坏 timeout、错误实体和内部 ID 不一致全部 fail closed。

## 5. Test And QA Focus

- QA 重点：旧 fingerprint 正常重试复用并迁移；损坏 timeout/Turn/Message 拒绝；新格式仅 timeout 不同继续复用
- 当前证据：定向 4/4；`pnpm run check` 273/273；tarball smoke `toolCount:14`、`waitMany/lifecycle/diagnostics:ok`
- 全局安装：工作区与全局 binary SHA-256 均为 `e42a31d5f4f467cb4e77876081087b79ba3e6af79eb058954efcea502d32262e`
- 无法本机确认：Windows `.cmd` 实机 tarball E2E；继续由 CI runner 覆盖

## 6. Residual Risk

- `cs_agent_send.timeoutMs` 是保留兼容字段，不提供 per-task deadline；需要独立设计时另开 feature。
- runtime 全局 timeout 仍可能终止合法长任务，但会明确返回 `failed/TIMEOUT`，不会生成最终 Message。
- 未来若 snapshot v1 增加新的 Send 关联字段，legacy linkage 校验和迁移测试需同步扩展。

## 7. Verdict

- Status: passed
- Spec compliance: PASS
- Code quality: PASS
- Next: issue 验收与收尾；不自动 commit、push、tag 或发布
