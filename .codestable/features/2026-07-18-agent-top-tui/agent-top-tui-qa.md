---
doc_type: feature-qa
feature: 2026-07-18-agent-top-tui
status: passed
tested: 2026-07-18
---

# Agent 实时监控 TUI QA

## 结论

通过。核心自动化、真实 PTY 与安装包验证均完成。

## 证据

- `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run check`：223/223 tests 通过；format、docs、
  typecheck、lint、build、pack dry-run 通过。
- `pnpm run test:tui-e2e`：从 tarball 临时全局安装后，top、ps、键盘、SGR mouse、resize、managed
  Attach、Esc/q 与 terminal restore 全部 `ok`。
- 独立 package smoke：`{"toolCount":13,"lifecycle":"ok","diagnostics":"ok"}`。
- `git diff --check`：通过。

## 场景

- 列表刷新、selection、stale merge、includeAll epoch、filter draft、root 禁用：通过。
- Attach history、live/paused、Home 顶部满页、End 恢复、2,000 上限、q/Esc cleanup：通过。
- 非 TTY 无 ANSI、窄终端、poison 控制序列、初始化失败：通过。
- tarball alternate screen、cursor、1000/1006 mouse 开关与 `stty -g` 前后一致：通过。
