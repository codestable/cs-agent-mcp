---
doc_type: issue-report
issue: 2026-07-19-prompt-timeout-partial-success
status: confirmed
severity: P1
summary: 长时间运行的 Agent 在报告完成前返回部分输出并被标记为成功
tags:
  - acp-runtime
  - timeout
  - result-integrity
---

# Prompt 超时将部分输出标记为成功 Issue Report

## 1. 问题现象

通过 `cs-agent-mcp` 驱动 Claude 和 Codex 执行真实项目代码审查时，Agent 尚未完成报告，调用方只收到已经产生的部分过程输出；对应 Turn 却显示为 `completed` / `end_turn`，不会继续补全报告。

## 2. 复现步骤

1. 创建一个 Claude 或 Codex managed Agent。
2. 发送需要读取项目代码、运行工具并输出完整报告的任务，同时传入 `timeoutMs: 120000`。
3. 使用 `cs_agent_wait_many` 或单 Turn wait 等待终态。
4. 观察到：约 120 秒后 Turn 返回 `completed` / `end_turn`，Message 仅包含报告前半段、过程说明，或没有 Message。

最小复现：运行 `node --test /tmp/prompt-partial-output-repro.test.mjs`，仅注入一条过程输出且 prompt 永不完成；当前实现错误地返回成功，而不是抛出 `TimeoutError`。

复现频率：稳定。

## 3. 期望 vs 实际

**期望行为**：`cs_agent_send.timeoutMs` 只约束消息被接受和开始；即便 runtime 另有执行超时，没有收到明确完成响应时也必须返回失败或未完成终态，不能把过程输出作为最终结果。

**实际行为**：`timeoutMs` 限制了整个 ACP prompt；超时取消后，只要会话中已有任意 Agent 文本或 tool result，就把 Turn 标记为 `completed` / `end_turn`。

## 4. 环境信息

- 涉及模块 / 功能：MCP `cs_agent_send`、Facade runtime adapter、ACP prompt 执行和会话更新投影
- 相关文件 / 函数：`src/mcp/transport/server.ts`、`src/mcp/facade/facade.ts`、`src/mcp/runtime-adapter.ts`、`src/runtime/engine/manager.ts`、`src/runtime/engine/prompt-turn.ts`
- 运行环境：macOS，本地全局安装的 `cs-agent-mcp 0.2.4`，真实 Claude / Codex runtime
- 其他上下文：同一真实 E2E 在移除工具工作量、确保 120 秒内完成后能返回完整报告

## 5. 严重程度

**P1** — 核心 Agent 结果完整性受损，并且错误终态会让调用方把不完整结果当作成功，缺少可靠的自动恢复信号。

## 备注

问题发生在 Turn 终态形成之前；`wait_many` 只是读取已经写入的终态，不是输出截断点。
