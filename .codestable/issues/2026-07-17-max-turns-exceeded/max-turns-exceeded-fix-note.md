---
doc_type: issue-fix
issue: 2026-07-17-max-turns-exceeded
path: standard
fix_date: 2026-07-17
related: [max-turns-exceeded-analysis.md]
tags: [claude, error-normalization, max-turns]
---

# Claude maxTurns 耗尽错误不可诊断 修复记录

## 1. 实际采用方案

采用分析中的方案 B：保留 `sessionOptions.maxTurns` 硬上限和 Turn `failed` 语义，窄识别 Claude
ACP 的 `error_max_turns` 或 `Reached maximum number of turns` 提示，将其公开归类为
`MAX_TURNS_EXCEEDED`，标记为不可对同一请求自动重试，并返回提高或省略配置的恢复建议。

同时在 MCP 工具 schema 和 README 中说明 `maxTurns` 计数的是单个任务内部的 agentic turns，
工具调用较多的任务建议从 `8-12` 起步，没有严格预算时省略该字段。没有实现自动提高上限、自动
重建或自动重放任务。

## 2. 改动文件清单

- `src/acp/error-normalization.ts`：仅从顶层消息、ACP 消息和已知
  `details/subtype/type/errors` 字段识别最大轮数错误；增加稳定 detail code、恢复消息和非重试
  分类。完整显式 `detailCode + retryable` 优先，否则推断分类整组生效。
- `src/mcp/transport/server.ts`：为 `sessionOptions.maxTurns` 增加公开 JSON schema 描述。
- `test/client.test.ts`：覆盖直接错误消息、ACP internal error data、subtype-only、请求文本误命中、
  抛异常 getter、显式语义优先级、超长多行提示和 prompt retry 判定。
- `test/runtime-manager.test.ts`：覆盖 runtime Turn result 的错误码、消息和 retryable 契约。
- `test/mcp-facade.test.ts`：覆盖公开 Turn error、Agent lastError、`turn.failed` 事件和 MCP 工具
  输出，并验证 `details.runtimeCode` 保留原始 runtime code。
- `test/mcp-cli.test.ts`：通过真实 MCP `tools/list` 验证 schema 描述已公开。
- `README.md`：补充语义、建议范围和达到上限后的行为。
- `CHANGELOG.md`：记录未发布的公开错误契约变化。

## 3. 验证结果

- 修复前失败基线：新增三类断言分别因缺少 detail code、错误被判为可重试和 schema 无描述而失败。
- 定向回归：client、runtime manager、Facade 共 134 项组合测试通过；新增测试确认 prompt retry
  尊重归一化后的非 `RUNTIME` code。
- 真实 Claude ACP：本机登录态下以 `maxTurns: 1` 触发实际上限，得到：
  - `code: RUNTIME`
  - `detailCode: MAX_TURNS_EXCEEDED`
  - `retryable: false`
  - 消息保留 `Reached maximum number of turns (1)` 并给出提高或省略配置的建议。
- 完整检查：`pnpm run check` 通过，包含格式、Markdown、类型检查、lint、构建、198 项测试和
  `npm pack --dry-run`。

## 4. Review 修正

- REV-001：删除任意 `Object.values` 递归，只读取上游已知错误字段；请求上下文引用错误文案不再
  误判，无关 enumerable getter 抛错也不会破坏本分类路径。
- REV-002：完整显式语义元数据整体优先；显式语义不完整时，max-turn 的消息、detail code 和
  retryable 整组生效，prompt retry 判定与公开错误保持一致。
- REV-003：增加 Facade + MCP 契约测试，确保 runtime `detailCode` 最终提升为公开
  `MAX_TURNS_EXCEEDED`，原始 `RUNTIME` 保存在 `details.runtimeCode`。
- REV-004：恢复消息只嵌入规范化的 `error_max_turns` 或带有限数字的固定提示，不回显任意长度或
  多行原始错误文本。
- REV-005：`isRetryablePromptError` 改为消费 `normalizeOutputError` 的 code、detailCode 和
  retryable，不再单独执行 max-turn 文案检测；非 `RUNTIME` 与 `AUTH_REQUIRED` 统一不可重试。
- REV-006：subtype-only 错误改用固定的人类可读提示，不把 `error_max_turns` 内部 token 写入
  用户消息。

## 5. 遗留事项

- 当前兼容上游 `@agentclientprotocol/claude-agent-acp@0.37.0` 的结构化 subtype 和固定错误提示。
  如果上游未来提供专用 ACP stop reason 或改变载荷，应优先使用新的结构化信号并保留现有公开
  `MAX_TURNS_EXCEEDED` 契约。
- 本修复未改变已产生事件的持久化行为，也未增加自动恢复；调用者仍需根据任务预算决定提高或
  省略 `maxTurns`。
