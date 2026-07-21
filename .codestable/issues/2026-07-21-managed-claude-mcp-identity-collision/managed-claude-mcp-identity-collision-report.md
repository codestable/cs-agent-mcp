---
doc_type: issue-report
issue: 2026-07-21-managed-claude-mcp-identity-collision
status: confirmed
severity: P1
summary: 受管 Claude 同时看到用户级与注入的递归 MCP 入口时可能使用 root 身份创建 sibling Agent
tags:
  - mcp
  - claude
  - identity
---

# 受管 Claude MCP 身份入口冲突 Issue Report

## 1. 问题现象

根调用方通过 `cs-agent-mcp` 创建受管 Claude A 后，A 再创建 Codex B。在本机存在用户级
`cs-agent` MCP 注册时，A 能同时看到用户级工具和会话注入工具。A 使用未限定 namespace 的
递归委派提示后，B 出现在 Workspace root 的直接子级，而不是 A 的子级。

同一环境下，明确要求 A 只使用注入的 `mcp__cs-agent-mcp__*` 工具后，B 才正确成为 A 的
depth-2 子 Agent，权限事件也由 A 身份处理。

## 2. 复现步骤

1. 在 Claude 用户配置中注册 `cs-agent -> cs-agent-mcp`。
2. 通过 Workspace root 创建受管 Claude A。
3. 要求 A 使用 cs-agent MCP 创建 Codex B，但不指定 MCP server namespace。
4. 从 diagnostics snapshot 检查 A、B 的 `parentAgentId` 和 depth。
5. 观察到 B 的 `parentAgentId` 是 Workspace root，而不是 A。

复现频率：本机真实 Claude 2.1.186 稳定复现一次；指定注入 namespace 后稳定恢复正确层级。

## 3. 期望 vs 实际

**期望行为**：受管 Claude A 保留其他用户设置，但递归委派只能使用服务注入、携带 A bearer
identity 的 MCP 入口；A 创建的 B 必须以 A 为 parent，B 的权限由 A 或其祖先按真实身份处理。

**实际行为**：A 同时看到功能相似的用户级 root 入口和注入入口，可能选择用户级入口，以 root
身份创建 B；B 成为 A 的 sibling，递归权限审计身份也随之失真。

## 4. 环境信息

- 涉及模块 / 功能：受管 Claude ACP session、递归 MCP 注入、Facade delegation identity
- 相关文件 / 函数：`src/mcp/transport/workspace-facade.ts`、`src/acp/client.ts`、
  `src/acp/agent-command.ts`、Claude session metadata
- 运行环境：macOS，本机全局 `cs-agent-mcp@0.2.5`，Claude Code 2.1.186
- 其他上下文：Claude 用户级 MCP 同时包含 `codebase-memory-mcp` 与 `cs-agent`；真实 E2E 已证明
  强制使用注入 namespace 后权限和问题回传链路均通过

## 5. 严重程度

**P1** — 核心递归委派仍可通过精确 namespace 绕过，但默认配置会破坏 Agent 树所有权与权限
审计身份，不能依赖提示词作为长期安全边界。

## 备注

产品修复必须只过滤与本控制面冲突的用户级 MCP，不能关闭 Claude 的其他用户设置、skills、hooks
或无关 MCP server。
