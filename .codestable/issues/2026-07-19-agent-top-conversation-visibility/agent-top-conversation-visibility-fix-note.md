---
doc_type: issue-fix
issue: 2026-07-19-agent-top-conversation-visibility
path: standard
fix_date: 2026-07-19
related:
  - agent-top-conversation-visibility-analysis.md
tags:
  - diagnostics
  - tui
---

# Agent Top 会话可见性修复记录

## 1. 改动

- diagnostics 按 Agent mode 定位原生 session records；oneshot 记录按创建时间合并，并插入 next-task
  session boundary。
- Attach 增加 loading、waiting、ready、unavailable 状态；历史记录缺失时显示已有 runtime 错误。
- conversation item 使用独立的 `[USER]`、`[ASSISTANT]`、`[THINKING]`、`[TOOL CALL]`、
  `[TOOL RESULT]`、`[TOOL ERROR]` 标题和缩进正文。
- paused 视口仍按渲染行保持位置，未读数按新增消息项计算。

## 2. TDD 与验收

- RED：oneshot conversation 为 `undefined`；新类型标题断言失败；历史空记录测试超时停在 waiting。
- GREEN：核心修复后完整 diagnostics/TUI 30/30，覆盖 stopped unavailable、读取异常 unavailable 与
  running `waiting -> ready` 周期刷新。
- 真实历史：`aa263d17` 读到 1 条 user；`e3cae6f8` 从 `found:false` 变为 `found:true` 并读到原生 user。
- tarball PTY E2E：`top/ps/keyboard/sgrMouse/resize/attach/terminalRestore` 全部 `ok`。
- 全量门禁：`pnpm run check` 277/277；diagnostics/TUI 定向 30/30。
- tarball smoke：临时安装后 `toolCount:14`、`waitMany/lifecycle/diagnostics:ok`。
- 当前全局安装与工作区 `dist/mcp-cli.js` SHA-256 均为
  `1af40bdc9dc0ade35423394fc4336b1c4d392c9c0156d37cfb0d942a0299c8f2`。

## 3. Review Fix

- Round 1 Claude 指出 waiting 负断言未匹配真实文案，且损坏 record 时正文仍显示 loading。
- 修复测试正则并新增 `readConversation` 抛错红测；controller catch 受 generation 保护后将正文切换为
  unavailable，同时保留错误状态栏。
- Round 2 Claude/Codex 均 `VERDICT: PASS`：Claude Agent
  `87057add-b717-49d0-aa87-cdca3d971fea` / Turn `14f2a1be-f1e5-4b1b-8e15-a5775e30e3a3`；Codex Agent
  `1438b5e1-3ce3-4428-8b54-0e64e5478aa3` / Turn `817a4616-2a00-4477-b0fc-c39c5d2dbcee`。

## 4. 遗留风险

- oneshot Agent 有大量历史任务时，Attach 会读取并合并其全部原生 records；这是完整上下文优先的有意取舍。
- 原生 session 已被删除时无法重建内容，只能明确显示 unavailable 与 Facade 已持久化错误。
