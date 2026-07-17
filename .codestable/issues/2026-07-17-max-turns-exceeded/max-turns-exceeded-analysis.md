---
doc_type: issue-analysis
issue: 2026-07-17-max-turns-exceeded
status: confirmed
root_cause_type: missing-guard
related: [max-turns-exceeded-report.md]
tags: [claude, error-normalization, max-turns]
---

# Claude maxTurns 耗尽错误不可诊断 根因分析

## 1. 问题定位

| 关键位置                             | 说明                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `src/mcp/transport/server.ts:50`     | `sessionOptions.maxTurns` 只有数值约束，没有公开语义和使用建议      |
| `src/acp/agent-command.ts:336`       | `maxTurns` 被原样写入 Claude Code session options，硬上限按配置生效 |
| `src/acp/client.ts:923`              | Claude session 创建时将 options 放进 ACP `_meta`                    |
| `src/acp/error-normalization.ts:177` | 错误映射仅识别权限、超时、会话和用法错误，没有最大轮数耗尽分支      |
| `src/runtime/engine/manager.ts:1301` | 未识别错误以通用运行时失败落到 Facade Turn                          |
| `README.md:186`                      | 只列出 `maxTurns` 字段名，没有解释其计数对象和建议范围              |

另外核验 `@agentclientprotocol/claude-agent-acp@0.37.0` 的发布产物：它在收到 Claude SDK
`error_max_turns` 且 `message.is_error` 为真时调用 `RequestError.internalError(...)`。因此本项目收到
的是 ACP internal error，而不是专用类型或 stop reason。

## 2. 失败路径还原

**正常路径**：`cs_agent_create` 接收 session options → Facade 持久化 Agent → runtime 创建 Claude
session → `buildClaudeCodeOptionsMeta` 原样传入 `maxTurns` → Claude 在限制内完成 → Turn 标记为
`completed` 并保存最终消息。

**失败路径**：相同链路传入 `maxTurns: 2` → Claude 在完成最终答复前返回 `error_max_turns` →
Claude ACP 包装为 internal error → `mapErrorCode` 无匹配并返回通用 `RUNTIME` → Facade Turn 标记为
`failed`，但没有稳定的 `MAX_TURNS_EXCEEDED` 代码或恢复信息。

**分叉点**：`src/acp/error-normalization.ts:177` — 可预期的配置上限耗尽没有被识别，和真正的
未知运行时故障走了同一分支。

## 3. 根因

**根因类型**：缺少防御。

**根因描述**：上游适配器没有保留 `error_max_turns` 的结构化类型，而本项目也没有针对其稳定
错误文本和 ACP error payload 做兼容归类。同时 MCP schema 与 README 没有说明 `maxTurns` 是
Claude 单次任务内部的 agentic turns，调用者容易给复杂任务设置过小的值。

**是否有多个根因**：是。主因是错误归一化缺少最大轮数分支；次因是公开 schema 和文档缺少
语义说明。`maxTurns` 原样生效以及 Turn 保留事件并标记失败均为正确行为。

## 4. 影响面

- **影响范围**：所有通过 Claude ACP 显式设置过低 `maxTurns` 的任务，代码审查和仓库分析尤其
  容易触发。其他 Agent 若返回相同明确错误文本也可受益于统一归类。
- **潜在受害模块**：ACP 错误归一化、Facade Turn 错误契约、MCP schema 消费者和 README 用户。
- **数据完整性风险**：无。已产生事件和失败状态都会持久化。
- **严重程度复核**：维持 P2。核心默认路径不受影响，但当前错误契约阻止自动诊断和合理恢复。

## 5. 修复方案

### 方案 A：只补 schema 和文档

- **做什么**：解释 `maxTurns` 语义并提供复杂任务建议值。
- **优点**：改动最小，不依赖上游错误文本。
- **缺点 / 风险**：已发生的错误仍是通用 `RUNTIME`，调用方无法稳定自动处理。
- **影响面**：`src/mcp/transport/server.ts`、README 和 schema 测试。

### 方案 B：错误归类、提示、schema 和文档一起修

- **做什么**：识别上游最大轮数错误，返回 `MAX_TURNS_EXCEEDED` 与可操作消息；补 schema、README
  和端到端错误契约测试。保持失败状态，不自动提高上限或重试。
- **优点**：直接修复公开错误契约，并降低再次误配概率；不破坏显式资源预算。
- **缺点 / 风险**：上游未暴露专用错误类型，需要对已知 ACP 错误信息做窄兼容识别。
- **影响面**：错误归一化、Facade 测试、MCP schema、README。

### 方案 C：自动提高上限或重建重试

- **做什么**：捕获错误后以更高 `maxTurns` 自动创建新 session 并重放任务。
- **优点**：表面上减少人工恢复。
- **缺点 / 风险**：违反调用者显式成本边界，可能重复副作用和工具调用，也无法可靠恢复原上下文。
- **影响面**：跨 Facade、runtime、持久化和权限系统，风险高。

### 推荐方案

**推荐方案 B**。它在不改变资源限制语义的前提下修复可诊断性和用户指导，改动边界明确，且用户
已确认采用该方案。
