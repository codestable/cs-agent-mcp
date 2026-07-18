# 更新日志

本文件记录 `cs-agent-mcp` 的用户可见变更。

## 未发布

## 0.2.2 - 2026-07-18

### 实时诊断 TUI

- 新增交互式 `cs-agent-mcp agents top` 和等价别名 `agents ps`，支持实时列表、稳定选择、过滤、
  `--all` 范围切换、键盘和 SGR 鼠标导航，以及在同一终端内进入 managed Agent 的 Attach 视图。
- Attach 子视图支持有界历史、live/paused、未读计数和终态提示；root 身份保持可见但不会启动
  runtime Attach。
- 所有 DTO 文本在终端边界剥离控制序列；q、Ctrl-C、SIGTERM、resize 和异常路径都会恢复 raw、
  mouse、cursor 与 alternate screen。非 TTY 会明确失败并保持 stdout 无 ANSI。

### 诊断 CLI 修复

- 诊断 CLI 文本输出现在明确区分 `root` 调用者身份与 `managed` runtime；attach 到 root 时会
  解释其没有受管 runtime 输出，并避免重复显示 `agent.created agent.created`。

## 0.2.1 - 2026-07-18

### MCP 编排提示

- 增加 MCP server instructions、13 个工具的使用时机与流程描述、完整输入字段说明，以及只读、
  幂等和破坏性 annotations，帮助调用 Agent 主动判断何时采用多 Agent、异构 Agent 或独立审查。

## 0.2.0 - 2026-07-18

### 诊断 CLI

- 新增只读诊断命令 `cs-agent-mcp agents list|status|attach`，可从终端查看本机
  Facade snapshot 中的 Agent 状态并按 cursor 跟随事件。
- 诊断 JSON 使用 `cs-agent-mcp.diagnostics.v1`，只输出 allowlist 字段，避免泄露 thought、
  identity、Permission request 和 raw tool payload。

### 错误处理

- Claude 达到显式 `sessionOptions.maxTurns` 上限时返回可识别的 `MAX_TURNS_EXCEEDED` 错误和
  恢复建议，不再将该配置边界仅报告为通用内部错误。

## 0.1.1 - 2026-07-17

### 修复

- Codex ACP 在未设置 `CODEX_PATH` 时自动复用本机 `codex` 可执行文件，避免回退到适配器内置
  的旧版 Codex；显式路径配置仍保持优先。

## 0.1.0 - 2026-07-16

### 新增

- 发布独立 npm 包和 `cs-agent-mcp` 可执行命令，无需依赖 npm 包 `acpx`。
- 提供 13 个 `cs_agent_*` MCP 工具，覆盖能力探测、Agent 生命周期、消息、Turn、事件、权限、
  取消和销毁。
- 支持 Codex、Claude 等本机 Agent，并复用现有 CLI 登录状态和 Claude 用户设置。
- 支持受管 Agent 通过带身份认证的 loopback MCP 连接递归创建子 Agent。
- 支持每个 Agent 的 FIFO Turn、跨 Agent 并发、幂等发送、结构化事件和有界等待。
- 支持 workspace roots 隔离、权限回传、级联取消和级联销毁。
- 持久化 Message、Turn、Event 和 ACP 会话；服务重启后恢复原会话，无法恢复时明确失败。
