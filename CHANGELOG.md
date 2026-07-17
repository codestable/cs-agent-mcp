# 更新日志

本文件记录 `cs-agent-mcp` 的用户可见变更。

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
