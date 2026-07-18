---
doc_type: feature-implementation-evidence
feature: 2026-07-18-agent-top-tui
status: passed
recorded: 2026-07-18
---

# Agent 实时监控 TUI 实现证据

## 范围

- 新增 `agents top` 主命令和 `agents ps` 别名，支持 `--all`。
- 新增 diagnostics TUI 状态机、renderer、终端净化、terminal-kit adapter 和真实 PTY E2E。
- 不修改 Facade、MCP tools、diagnostics DTO/schema 或 snapshot schema。
- 同步 README、CHANGELOG、MCP 架构、diagnostics requirement 和 VISION。

## 自动门禁

- `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run check`：通过。
- `pnpm run test`：223/223 通过；新增 TUI 测试 9/9 通过。
- format、markdownlint、typecheck、零 warning lint、build、pack dry-run：全部通过。
- `git diff --check`：通过。

## 真实 PTY 与 Tarball

`NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run test:tui-e2e` 从当前源码生成 tarball，临时
全局安装后在 `/usr/bin/expect` 创建的真实 PTY 中完成：

```json
{
  "tarball": "cs-agent-mcp-0.2.1.tgz",
  "top": "ok",
  "ps": "ok",
  "keyboard": "ok",
  "sgrMouse": "ok",
  "resize": "ok",
  "attach": "ok",
  "terminalRestore": "ok"
}
```

验收包含 SGR 滚轮/单击、managed Enter Attach、Esc 返回、终端 resize、q 退出、`stty -g` 前后
一致，以及 alternate screen、cursor、mouse/SGR mouse 开启和关闭字节。该 E2E 曾真实发现
terminal-kit `grabInput(false)` 未关闭 1006 SGR mouse，adapter 已显式调用 `mouseSGR(false)` 修复。

## Package Smoke

独立生成 `cs-agent-mcp-0.2.1.tgz`、临时全局安装，并以 MCP SDK 连接安装后的 binary：

```json
{ "toolCount": 13, "lifecycle": "ok", "diagnostics": "ok" }
```

smoke 同时断言 `agents top --help`、`agents ps --help`、list/status/attach 可达。

## 安全与资源

- 非 TTY 返回 1，stdout 为空且 stderr 无 ANSI。
- 所有 diagnostics DTO 文本在 renderer 边界剥离 CSI、OSC、DCS、C0/C1、bidi 和多行控制符。
- attach timeline 最多 2,000 项，list refresh 串行合并，旧 epoch/generation 结果丢弃。
- q、Ctrl-C、SIGTERM、Attach Esc、初始化失败和正常退出统一等待 pump 并幂等清理终端资源。
