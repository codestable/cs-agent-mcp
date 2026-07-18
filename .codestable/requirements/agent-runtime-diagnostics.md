---
doc_type: requirement
slug: agent-runtime-diagnostics
pitch: 在终端一眼看清正在运行的 Agent，并快速定位卡住或失败的原因。
status: current
last_reviewed: 2026-07-18
implemented_by: [agent-runtime-diagnostics, agent-top-tui]
tags: [cli, diagnostics, agents]
---

# Agent 运行状态透视与排障

## 用户故事

- 作为本地操作者，我希望列出当前活跃的 Agent、状态和工作目录，而不是只能从 MCP 调用方推测
  运行情况。
- 当任务卡住或失败时，我希望查看 Agent 当前 Turn、最近错误和活动事件。
- 排查长任务时，我希望只读跟随 Agent 的状态变化，并能随时退出观察。
- 同时运行多个 Agent 时，我希望在一个实时界面中用键盘或鼠标浏览、筛选并选择目标，然后进入
  同屏 Attach，而不需要反复复制 Agent ID。

## 为什么需要

MCP 服务在后台管理多个 Agent 和 Turn，但目前缺少面向终端的诊断入口。发生卡住、权限等待、
会话恢复失败或运行时错误时，用户难以快速判断问题位于哪个 Agent、哪个 Turn。

## 怎么解决

提供统一的诊断入口，让用户列出运行中的 Agent、查看单个 Agent 的详细状态，并以只读方式持续
跟随其活动和终态。交互式 `agents top|ps` 提供实时总览、稳定选择、过滤、键鼠导航和同屏 Attach；
脚本与重定向场景继续使用结构化 `list/status/attach` 输出。

## 边界

- 只观察本机当前用户可见的 cs-agent-mcp 状态，不提供远程管理。
- 不通过诊断入口创建、销毁、取消 Agent 或响应权限。
- `attach` 是只读跟随，不接管 Agent 会话，也不向 Agent 发送消息。
- `top|ps` 仅面向交互式 TTY；不在 TUI 中提供任何 mutation、Permission 响应或远程监控能力。
- 不替代结构化 MCP 工具和持久化状态，只提供便于人工排查的终端视图。
