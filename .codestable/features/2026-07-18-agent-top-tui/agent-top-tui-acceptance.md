---
doc_type: feature-acceptance
feature: 2026-07-18-agent-top-tui
status: passed
accepted: 2026-07-18
---

# Agent 实时监控 TUI 验收

## 结论

设计、实现、review、QA 与文档契约全部通过。

## 契约核对

- `agents top` 为主命令，`agents ps` 为别名；`--all` 只决定初始范围，运行时可用 `a` 切换。
- 键盘、鼠标、过滤、实时刷新、稳定选择、managed Attach、root 说明、live/paused 和终态 banner
  均已交付。
- 非 TTY 明确失败；所有退出路径恢复 raw、mouse、cursor 和 alternate screen。
- TUI 只调用 `AgentDiagnostics` 读接口；没有 mutation、远程服务或新 snapshot schema。
- 无参数 stdio MCP 行为、13 tools、diagnostics DTO/JSONL 与 Facade v1 schema 不变。
- README、CHANGELOG、MCP architecture、agent-runtime-diagnostics requirement 与 VISION 已同步；
  requirement 保持 `current` 并增加 `agent-top-tui` implemented_by。

## DoD

- DOD-DESIGN-001：passed。
- DOD-IMPL-001：passed。
- DOD-REVIEW-001：passed（subagent+ocr）。
- DOD-QA-001：passed。
- DOD-ACCEPT-001：passed。
