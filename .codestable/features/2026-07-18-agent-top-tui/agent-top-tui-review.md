---
doc_type: feature-code-review
feature: 2026-07-18-agent-top-tui
status: passed
reviewer: subagent+ocr
reviewed: 2026-07-18
round: 2
---

# Agent 实时监控 TUI 代码审查

## 结论

通过。独立 Paseo `claude/opus` plan reviewer 与 OCR 行级扫描均完成；review-fix 后无 unresolved
blocking/important。

## Findings

- Round 1 important：Attach 滚到顶部时 offset 以 `items.length - 1` 为上限，导致最旧页只显示
  1 行。已让 `scrollAttach` 接收 viewport 高度，并在 renderer 二次 clamp；新增 30 条历史/10 行
  viewport 回归测试。
- OCR high：terminal cleanup 任一步抛错会跳过后续恢复。已改为每个独立终端能力 best-effort
  恢复，`grabInput` rejection 不阻止此前 screen/cursor/mouse 恢复。
- OCR medium：SIGTERM 在 `terminal.start()` 期间 abort 会被硬编码为 0。已统一使用
  `signalExitCode()`，保持 143。
- OCR low：paused 裁剪 offset 可能为负。已补下界 0。

## Round 2

独立 reviewer 复核 viewport、SIGTERM、cleanup 与回归测试，verdict 为通过，无 blocking/important。
它提出 list/Attach page 行数不一致，已分别对齐各自 bodyRows。关于 Esc/q 可能 stop 后 draw 的残余
风险经本地核验不成立：controller `render()` 在 `done` 时直接返回。

## Residual Risk

- terminal-kit 在非 xterm TERM 下的键名和控制序列差异未覆盖；键盘主路径与 xterm-256color PTY
  已验证。
- 高频 Attach 每事件重绘，受 2,000 item 上限保护；本版本不做额外节流。
