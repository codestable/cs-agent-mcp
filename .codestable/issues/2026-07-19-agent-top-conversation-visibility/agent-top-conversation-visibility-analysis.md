---
doc_type: issue-analysis
issue: 2026-07-19-agent-top-conversation-visibility
status: confirmed
root_cause_type: logic
related:
  - agent-top-conversation-visibility-report.md
tags:
  - diagnostics
  - tui
---

# Agent Top 会话可见性根因分析

## 1. 根因

1. `readConversation()` 只构造固定的 `mcp-<rootExecutionId>-<agentId>.json`；oneshot runtime 实际把每次
   任务写入 `mcp-<root>-<agent>:oneshot:<uuid>.json`，因此已有记录也返回 `undefined`。
2. TUI 把 `undefined` 静默忽略，renderer 又把所有空 items 统一显示为 waiting，无法区分首次加载、
   尚无首条消息、空会话和历史记录不可用。
3. renderer 把类型前缀与正文放在同一行，长工具名还会压缩正文宽度；不同内容仅依赖颜色和短前缀。

## 2. 修复方案

- persistent 保持固定 record；oneshot 枚举同 Agent 前缀的原生记录，严格解析后按创建时间合并，并用
  session boundary 区分任务。
- Attach 显式维护 loading/waiting/ready/unavailable，历史不可用时显示 Agent 的持久化错误。
- 每个 conversation item 使用独立标题行和缩进正文，工具名只占标题行；滚动继续按渲染行，未读数按
  新增 item 计算。

## 3. 边界

- 不修改 Facade snapshot v1、diagnostics JSONL 事件或 MCP 14 tools。
- 不创建新的历史副本，不连接 Broker，不启动或恢复 Agent。
- 不把 Facade events 混入 conversation viewport。

用户已明确要求修复并改善 UI，方案视为确认。
