---
doc_type: issue-acceptance
issue: 2026-07-19-agent-top-conversation-visibility
status: passed
accepted: 2026-07-19
auditor: cs-agent-mcp-claude-codex
round: 1
---

# agent-top-conversation-visibility 功能验收报告

## 1. 验收检查

- [x] C01：persistent Agent 继续读取固定 session record。
- [x] C02：oneshot Agent 只枚举同 root/agent 前缀记录，按时间稳定合并并显示 task boundary。
- [x] C03：真实历史 `e3cae6f8` 从 conversation missing 变为可读；`aa263d17` 显示已有 user prompt。
- [x] C04：stopped/failed 缺失记录显示 unavailable 与已有错误，不显示无限 waiting。
- [x] C05：读取损坏 record 时正文为 unavailable，状态栏显示解析错误。
- [x] C06：running Agent 在首条记录到达后从 waiting 周期刷新为 ready。
- [x] C07：用户、助手、thinking、工具调用、工具结果和错误使用独立标题与缩进正文。
- [x] C08：长工具名、多行、控制字符、redacted thinking、滚动暂停和 resize 回归通过。
- [x] C09：诊断保持只读，不连接 Broker、不启动 Agent、不复制会话历史。
- [x] C10：Facade snapshot v1、diagnostics JSONL 和 14 MCP tools 契约未改变。

## 2. 功能证据

- TDD：oneshot missing、旧同行布局、无限 waiting 和异常 loading 均先红后绿。
- 定向：diagnostics/TUI 30/30。
- 真实 PTY tarball：`top/ps/keyboard/sgrMouse/resize/attach/terminalRestore` 全部 `ok`。
- 全量与包装：`pnpm run check` 277/277；tarball smoke 14 tools、wait-many、lifecycle、diagnostics 全绿。
- 双独立 review：Round 2 Claude/Codex 均 PASS，无 blocking/important。

## 3. Residual Risk

- 大量 oneshot records 的全量读取成本留作后续分页设计；本次保留完整上下文。
- 已删除的原生历史无法重建；TUI 现在会诚实显示 unavailable。

## 4. Verdict

PASS。已修复历史 oneshot conversation 定位与空状态误导，并显著加强消息类型和正文的视觉区分。
