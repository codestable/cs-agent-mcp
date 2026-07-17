---
doc_type: issue-report
issue: 2026-07-17-max-turns-exceeded
status: confirmed
severity: P2
summary: Claude 达到 maxTurns 后以通用 Internal error 失败，调用方无法稳定识别和恢复
tags: [claude, error-handling, mcp]
---

# Claude maxTurns 耗尽错误不可诊断 Issue Report

## 1. 问题现象

Claude 子 Agent 使用 `maxTurns: 2` 执行代码审查时，完成仓库状态和差异检查后，在输出最终
审查结论前失败。Turn 返回 `Internal error: Reached maximum number of turns (2)`，调用方只能
读取事件和解析错误文本判断原因。

## 2. 复现步骤

1. 通过 `cs_agent_create` 创建 Claude 子 Agent，并设置 `sessionOptions.maxTurns` 为 `2`。
2. 通过 `cs_agent_send` 要求它执行包含多个工具调用的代码审查。
3. 等待 Turn 完成。
4. 观察到：Claude 已产生检查事件，但 Turn 以通用 `Internal error` 失败，没有稳定错误码和恢复建议。

复现频率：任务实际需要超过两个 Claude agentic turns 时稳定复现。

## 3. 期望 vs 实际

**期望行为**：显式配置的 `maxTurns` 仍作为硬上限生效；达到上限时，Turn 明确失败并返回稳定、
可识别的错误码、配置值和提高或省略限制的恢复建议。文档和 MCP schema 应说明其语义。

**实际行为**：Turn 以通用 `Internal error` / `RUNTIME` 失败，公开文档只列出字段名，调用方无法
可靠地区分配置上限耗尽和真正的内部故障。

## 4. 环境信息

- 涉及模块 / 功能：Claude ACP session options、运行时错误归类、MCP Agent 创建接口
- 相关文件 / 函数：`src/acp/agent-command.ts`、`src/acp/error-normalization.ts`、
  `src/mcp/transport/server.ts`、`src/runtime/engine/manager.ts`
- 运行环境：`cs-agent-mcp@0.1.1`，`@agentclientprotocol/claude-agent-acp@0.37.0`
- 其他上下文：已有事件和失败 Turn 状态能够保留；提高到 `maxTurns: 8` 后相同任务成功

## 5. 严重程度

**P2** — 仅在显式限制不足时触发且存在绕过方法，但错误被误报为内部故障，会浪费一次任务并
阻止调用方按公开契约自动恢复。

## 备注

不得通过自动提高上限、自动重试或把失败标记为成功来规避问题；这些做法会破坏用户显式设置的
成本边界。
