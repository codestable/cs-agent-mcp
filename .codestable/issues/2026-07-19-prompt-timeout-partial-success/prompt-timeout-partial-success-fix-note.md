---
doc_type: issue-fix
issue: 2026-07-19-prompt-timeout-partial-success
path: standard
fix_date: 2026-07-19
related:
  - prompt-timeout-partial-success-analysis.md
tags:
  - acp-runtime
  - timeout
  - result-integrity
---

# Prompt 超时将部分输出标记为成功修复记录

## 1. 实际采用方案

采用分析中的组合方案 C：

1. `cs_agent_send.timeoutMs` 保留为兼容输入字段，但不再进入幂等任务指纹、不再写入新 Turn，也不再传给 ACP runtime；旧 snapshot v1 中已有的 `Turn.timeoutMs` 仍可读取，但执行时忽略。
2. runtime prompt 真正命中 timeout 时，取消 active prompt并短暂等待已到达的 session updates 收敛，随后始终抛出原 `TimeoutError`；删除“任意 Agent 文本或 tool result 即视为完整回复”的 salvage 分支。
3. Facade 继续记录 timeout 前已到达的 `turn.text_delta` 等事件，但失败 Turn 不创建最终 Message，也不设置 `resultMessageId`。

未新增 task deadline 字段、公开工具、状态枚举或 snapshot schema；显式任务执行期限留待后续独立设计。

## 2. 改动文件清单

- `src/mcp/facade/facade.ts`：停止 send timeout 的持久化、runtime 传播和幂等指纹参与。
- `src/mcp/transport/server.ts`：明确兼容字段不限制任务完成时间。
- `src/runtime/engine/prompt-turn.ts`：timeout 后只允许失败终态，保留 best-effort update drain。
- `src/session/conversation-model.ts`：删除无法证明最终完成的 `hasAgentReplyAfterPrompt` 启发式。
- `test/mcp-facade.test.ts`：覆盖 timeout 不传播、不同 timeout 重试幂等，以及部分事件不生成最终 Message。
- `test/runtime-manager.test.ts`：把既有错误 salvage 预期改为 `failed/TIMEOUT`，同时验证过程 chunks 保留。
- `test/mcp-e2e.test.ts`：真实 stdio/mock-ACP 验证任务执行超过 send timeout 后仍返回完整 Message。
- `README.md`、`docs/MCP_ARCHITECTURE.md`、`CHANGELOG.md`：同步公开语义、失败终态与诊断事件边界。
- `.codestable/issues/2026-07-19-prompt-timeout-partial-success/`：问题报告、根因分析和本修复记录。

当前工作区同时存在 owner 已确认的 `agent-wait-many` feature 改动；本 issue 未回滚或重写这些既有改动。

## 3. 验证结果

- 红测阶段：3 条定向断言稳定失败，分别观察到 `Turn.timeoutMs=25` 和两次错误的 `completed/end_turn`。
- 修复后定向测试：4/4 通过，覆盖提交 timeout 边界、部分事件无最终 Message，以及单/多 chunk 的 runtime timeout。
- 原始最小复现：`node --test /tmp/prompt-partial-output-repro.test.mjs`，1/1 通过；过程 chunk 不再把永不完成的 prompt 转成成功。
- MCP E2E：`test/mcp-e2e.test.ts` 6/6 通过；`sleep 100` 配合 `timeoutMs: 50` 最终返回完整 `slept 100ms` Message。
- 真实 runtime timeout 集成：当前全局安装 + 临时 HOME + mock ACP + 全局 `timeout: 0.5`；`stream-sleep 1500 partial-review` 最终返回 `terminal_without_message`、Turn `failed/TIMEOUT`、无 `resultMessageId`，同时 events 保留 `partial-review` text delta。
- 全量质量门：`pnpm run check` exit 0；格式、Markdown、类型、类型感知 lint、构建、273/273 测试和 pack dry-run 全部通过。
- tarball：使用 `/tmp/cs-agent-mcp-npm-cache` 执行 `pnpm run package:smoke:tarball`，临时安装后输出 `toolCount:14`、`waitMany:ok`、`lifecycle:ok`、`diagnostics:ok`。
- 本机安装：全局 `cs-agent-mcp 0.2.4` 的 `dist/mcp-cli.js` 与当前工作区构建 SHA-256 一致（`e42a31d5f4f467cb4e77876081087b79ba3e6af79eb058954efcea502d32262e`）。
- 真实 MCP 双审查：通过全局安装创建 Claude Agent `d35df0e9-9e36-4dbb-ae61-29b992a7422c` / Turn `306042d0-0f5c-4cd5-9ec5-abf46e4dff20` 与 Codex Agent `70c640df-5f17-4404-ab0a-352ee11d8cd8` / Turn `fe47a5bb-4ac2-42c6-9e05-f7c17d103ec1`；send-all 后使用 `wait_many(all)` 收到两份完整 `VERDICT: PASS` Message，长度分别为 2608 和 2747 字符，两个新 Turn 均不存在 `timeoutMs` 字段，随后成功销毁 Agent。

## 4. 遗留事项

- 当前没有独立的公开 task deadline；需要时应另开 feature 设计明确字段、取消、恢复和持久化语义，不能复用提交 timeout。
- runtime 全局 timeout 仍会保留取消前的部分事件和会话诊断内容；调用方必须以 Turn/Message 终态判断最终结果，不能从事件流自行拼装成功答案。
- MCP E2E 可直接证明 send timeout 不限制任务；runtime 真 timeout 的完整性已由 runtime manager、Facade 边界测试，以及临时全局配置触发的 stdio/mock-ACP 集成验收共同证明。
- Windows 实机 tarball E2E 不在本机环境可验证，继续由 CI runner 覆盖。

## 5. Review Fix Round 2

- REV-001 RED：构造 snapshot v1 旧记录，其 fingerprint 包含 `timeoutMs: 25` 且关联 Turn 保留该值；升级后用同 key、同内容和 `timeoutMs: 50` 重试，稳定得到 `IDEMPOTENCY_CONFLICT`。
- REV-001 GREEN：当前 fingerprint 直接比较失败时，仅从原 receipt 的关联 Turn 读取历史 timeout 并重建旧 fingerprint；旧格式精确匹配才复用 receipt，并把记录惰性迁移为不含 timeout 的新 fingerprint。
- 反例保护：旧 fingerprint 下改变 content 仍返回 `IDEMPOTENCY_CONFLICT`；兼容分支不放宽目标、内容或附件身份。
- 定向验证：旧 snapshot 回放、既有幂等 send 和 MCP 错误契约 3/3 通过。

## 6. Review Fix Round 3-5

- Round 3 finding：legacy 分支只判断 `timeoutMs !== undefined`，畸形 snapshot 的非 number timeout 可能被当作旧格式证据；receipt 指向错误 Turn 时关联也不完整。
- TDD RED：`null` timeout 与错误 target Turn 均出现 `Missing expected rejection`；内部 `turn.turnId` / `message.messageId` 与 map key 不一致时同样错误迁移。
- TDD GREEN：仅接受原公开约束内的正整数 timeout（最大 `86_400_000`），并在迁移前验证 receipt、Turn、inbound Message 的内部 ID、root、actor、target、content 和 attachments 完整一致。
- 边界覆盖：`null/string/object/0/负数/小数/超限/缺失` timeout、错误 Turn、内部 Turn/Message ID 损坏全部返回 `IDEMPOTENCY_CONFLICT`；合法旧 snapshot 仍迁移成功。
- 最终验证：定向 4/4、`pnpm run check` 273/273、tarball smoke 全绿。
- Round 5 双审查：Claude Agent `ba85d07d-6ed2-48cc-a468-8d93f77ebea7` / Turn `5afbef77-98e2-4a9a-92a6-73e86da77fae` 与 Codex Agent `4b433f38-ce83-408e-a7a2-c36ec6f14d53` / Turn `d9575cb7-a07a-41f6-83a2-4ebc07529343` 均返回完整 `VERDICT: PASS`，无 blocking/important。
