---
doc_type: issue-analysis
issue: 2026-07-19-prompt-timeout-partial-success
status: confirmed
root_cause_type: logic
related:
  - prompt-timeout-partial-success-report.md
tags:
  - acp-runtime
  - timeout
  - result-integrity
---

# Prompt 超时将部分输出标记为成功根因分析

## 1. 问题定位

| 关键位置                                | 说明                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/mcp/transport/server.ts:332`       | `cs_agent_send.timeoutMs` 的公开说明限定为消息接受和启动阶段，不应等待任务完成。                 |
| `src/mcp/facade/facade.ts:524`          | `createQueuedRecords` 把 send 的 `timeoutMs` 写入持久化 Turn。                                   |
| `src/mcp/facade/facade.ts:2218`         | `executeTurn` 又把 Turn 上的 timeout 作为 runtime prompt 输入。                                  |
| `src/mcp/runtime-adapter.ts:177`        | Facade adapter 将该值继续传给 ACP runtime。                                                      |
| `src/runtime/engine/manager.ts:978`     | runtime manager 把 per-Turn timeout 作为 `runPromptTurn` 的整个 prompt deadline。                |
| `src/runtime/engine/prompt-turn.ts:54`  | prompt 超时后取消 active prompt，但只要会话已有任意回复投影就伪造 `end_turn`。                   |
| `src/session/conversation-model.ts:668` | 任意 Agent 文本或 tool result 都被 `hasAgentReplyAfterPrompt` 当成回复，无法证明最终回答已完成。 |
| `test/runtime-manager.test.ts:1203`     | 既有测试把“超时后任意 chunk 视为完成”固化为预期，形成错误行为的回归保护。                        |

## 2. 失败路径还原

**正常路径**：调用方发送异步任务 -> Facade 返回 Turn receipt -> runtime 持续执行 -> ACP `prompt` RPC 返回明确 stop reason -> Facade 将完整输出写成最终 Message，并把 Turn 标为 `completed`。

**失败路径**：调用方发送 `timeoutMs: 120000` -> timeout 被写入 Turn 并传给 ACP prompt -> 120 秒时 prompt 被取消 -> 更新流已经包含过程文字或 tool result -> `hasAgentReplyAfterPrompt` 返回 true -> `runPromptTurn` 伪造 `end_turn` -> runtime 和 Facade 将部分输出标成最终 Message / `completed`。

**分叉点**：`src/runtime/engine/prompt-turn.ts:69` — 代码把“观察到任意会话输出”等同于“收到明确 prompt 完成响应”。

## 3. 根因

**根因类型**：逻辑错误。

**根因描述**：公开 MCP timeout 的作用域在消息提交阶段，实际数据流却把它当成整个 Agent Turn 的执行期限；执行期限到达后，runtime 又使用无法证明完整性的启发式条件恢复成功。两处逻辑叠加，使长任务被主动取消后仍以成功终态暴露给调用方。

**是否有多个根因**：是。主因是超时恢复判据错误，次因是 `cs_agent_send.timeoutMs` 跨越公开语义边界传入 prompt deadline。仅修任一处都不能彻底避免同类问题：只移除 MCP 传递时，runtime 全局 timeout 仍可伪成功；只修终态时，MCP timeout 仍会意外取消长任务。

## 4. 影响面

- **影响范围**：所有显式设置 `cs_agent_send.timeoutMs` 的长任务，以及所有通过 runtime 全局 timeout 命中 prompt deadline 且已产生过程输出的任务。
- **潜在受害模块**：单 Turn wait、wait-many、events、TUI/diagnostics、递归委派和真实 Claude/Codex review；这些消费者都会读取错误的终态。
- **数据完整性风险**：有。部分输出可能被写为最终 Message；只有 tool result 时还可能出现 `completed` 但无 Message。会话记录保留了被取消前的部分内容。
- **严重程度复核**：维持 P1。它不会破坏仓库文件，但会静默破坏核心任务结果完整性和自动编排的正确性。

## 5. 修复方案

### 方案 A：只移除 MCP timeout 到 runtime 的传递

- **做什么**：不再把 `SendInput.timeoutMs` 写入 Turn，也不在 Facade runtime 调用中传递。
- **优点**：直接消除本次真实 E2E 的 120 秒意外取消，改动较小。
- **缺点 / 风险**：runtime 自身通过全局 timeout 或其他调用入口超时时，仍会把部分输出伪装成成功。
- **影响面**：Facade 类型、发送路径和相关 E2E。

### 方案 B：只删除 timeout salvage 启发式

- **做什么**：runtime prompt 超时后一律返回 `TIMEOUT`，部分 chunk 只作为事件和会话诊断信息保留，不产生成功结果。
- **优点**：恢复终态真实性，覆盖所有 runtime 调用入口。
- **缺点 / 风险**：显式 `cs_agent_send.timeoutMs` 仍会意外限制整个任务，长任务仍被取消，只是调用方能够看到失败。
- **影响面**：prompt-turn、conversation helper 和 runtime manager 测试。

### 方案 C：组合修复

- **做什么**：同时停止 MCP send timeout 向 prompt deadline 传播，并删除“任意输出即成功”的 salvage；保留公开字段和 snapshot v1 的读取兼容性，runtime 真超时后保留事件但返回 `failed/TIMEOUT`，不生成最终 Message。
- **优点**：同时修复契约错位与错误终态；不新增公开工具或持久化 schema；真实调用方不再需要用超大 send timeout 猜任务耗时。
- **缺点 / 风险**：既有依赖 `cs_agent_send.timeoutMs` 取消长任务的调用方行为会改变，但该行为本就违背当前公开契约；真正的任务 deadline 需要未来另行设计显式字段。
- **影响面**：Facade send/runtime 边界、prompt timeout 处理、测试和公开说明。

### 推荐方案

**推荐方案 C**，因为它同时关闭两个独立触发条件，并保持 14 tools、Facade snapshot v1 和 wait-many 输出契约不变。用户在收到根因与该组合方案后已明确要求“修复”，视为方案确认。
