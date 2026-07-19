---
doc_type: issue-report
issue: 2026-07-19-agent-top-conversation-visibility
status: confirmed
severity: P1
summary: Agent Top 无法读取 oneshot 历史会话且 Attach 消息类型难以辨认
tags:
  - diagnostics
  - tui
  - conversation
---

# Agent Top 会话可见性 Issue Report

## 1. 问题现象

`agents top --all` 可看到 stopped snapshot 中的 dormant Agent，但 Attach 到 oneshot Agent 后永久显示
`Waiting for conversation...`。已有会话中不同消息类型使用同行短前缀，用户消息、Agent 回复、thinking
与工具输入输出难以快速区分。

## 2. 复现步骤

1. 创建并执行一个 oneshot Claude Agent，关闭其 Facade 后保留 snapshot 与 runtime session record。
2. 运行 `cs-agent-mcp agents top --all`，选择该 dormant Agent 并进入 Attach。
3. 观察到会话区域一直显示 waiting；直接检查 `~/.cs-agent-mcp/sessions/` 可看到带
   `:oneshot:<uuid>` 后缀的原生记录。
4. Attach 一个包含 user、assistant、thinking、tool call/result 的 Agent，观察同行标签和正文边界不清。

## 3. 期望行为

- persistent 与 oneshot Agent 都能从已有原生 session record 读取完整可用上下文，不复制历史。
- stopped/failed Agent 缺少 session 时显示明确不可用状态和已有错误，而不是无限 waiting。
- 消息类型、工具名称与正文有稳定且可扫描的视觉层次；长内容、暂停滚动和小终端行为不回归。

## 4. 环境与严重度

- 环境：macOS，`cs-agent-mcp 0.2.4`，真实历史 Agent `aa263d17`、`e3cae6f8`。
- 严重度：P1。不会修改任务数据，但使核心诊断入口无法阅读已有 review 上下文并误导用户认为会话仍在加载。
