---
doc_type: feature-code-review
feature: 2026-07-19-shared-workspace-control-plane
status: passed
reviewed: 2026-07-19
reviewer: native-task-agent
reviewer_agent_id: /root/shared_workspace_review
---

# Workspace 共享控制面代码审查

## 结论

独立代码审查最终 verdict 为 `passed`。批准设计的约束与实现逐项一致，未留下 blocking 或
important finding；代码质量 gate 可以放行。

## 审查范围

- Broker discovery、credential、协议握手、replacement、stale recovery 与 idle lifecycle。
- stdio/HTTP 有状态 bridge、standalone GET SSE、reverse-ready 与 roots 隔离。
- Workspace registry、唯一 Facade/runtime owner、lease、grace 与 shutdown 顺序。
- Facade/runtime closed gate、process lock generation 与并发 mutation guard。
- diagnostics/TUI 只读边界、13 tools、Facade snapshot v1、diagnostics v1 和 runtime 支持面。
- README、架构文档、CHANGELOG 及真实多进程测试是否与实现一致。

## Spec 合规

- 同 canonical Workspace 共享单一 Broker 内的 root actor、Facade/runtime owner 与 Agent 树；不同
  Workspace 隔离。
- stdio 前端只桥接有状态 MCP transport，没有复制 13 tools。
- 根 session 使用 Broker credential 和 standalone GET SSE；managed loopback 继续使用 Facade
  bearer identity。
- `roots/list` 等待 initialized 与按 `mcp-session-id` 隔离的 reverse-ready；405、断开和 5 秒超时
  返回 `BROKER_REVERSE_CHANNEL_UNAVAILABLE`。
- grace 与未完成 roots 初始化期间保持 Workspace lock，不释放或重取 generation。
- diagnostics/TUI 不连接 Broker、不取得 credential，仍以 snapshot/lock 跨 Workspace 只读扫描。
- 公开工具、schema、状态与 Codex/Claude/Pi/通用 ACP runtime 边界未改变。

## 代码质量

- Workspace 关闭按 HTTP stop accepting、HTTP session close、Facade/runtime shutdown、lock release
  排序；shutdown 失败传播错误且关闭公开操作入口。
- `processIdentity` 固定 `LC_ALL=C` 与 `TZ=UTC`；process lock 的 acquire、release、stale recovery
  通过 sidecar mutation guard 串行化。
- Broker replacement 等待旧 owner 释放真实 `broker.lock`，不会删除新的 owner；zero-lease active
  session 也参与升级保护。
- unresolved root session 使用幂等 initialization hold 暂停 grace，在成功、失败和 session close
  路径均释放。

## 已闭合审查项

审查过程中发现并验证闭合了旧协议 replacement、pending initialization 活跃判断、Workspace 关闭
顺序与错误传播、跨时区 process generation、stale compare/delete 竞态，以及慢 roots 跨越 grace
的证据缺口。最终复验未发现新的 blocking 或 important。

后续 TUI Attach 完整会话复核又闭合了 redacted thinking payload、Facade event 混入会话视口、慢读取
并发堆积、超长工具名遮挡正文，以及挂起 session read 阻塞终端恢复五项。最终实现用 conversation
专用 DTO、single-flight refresh、generation guard 与先恢复终端的退出顺序消除这些风险。

## 验证证据

- 主流程最终 `pnpm run check`：255/255 通过，包含 format、docs、typecheck、lint、build、test 与 pack
  dry-run。
- 独立验收定向复验：Broker、E2E、lock、Facade、runtime 共 62/62 通过。
- 独立最终 TUI review：26/26 通过，无 blocking/important finding。
- TUI PTY 的完整 conversation Attach、tarball 临时安装与 MCP SDK 13-tools smoke 均通过。

## 残余风险

- POSIX process generation 依赖秒级 `ps lstart`；同 PID 在同一秒复用是极低概率风险。Windows
  保持 PID-only fail-closed。
- initialization hold 是 registry 级保守暂停；长期未完成但持续 heartbeat 的根 session 可能延后
  其他空闲 Workspace 回收，但不会提前释放 lock 或破坏单写者。

## Task Agent 生命周期

审查由用户可见原生 Task agent `/root/shared_workspace_review` 完成，结果已消费并写入本报告。
当前宿主没有暴露 `close_agent` 等价动作，无法显式关闭已完成 agent；这不改变已核验 verdict，需将
该 agent 视为完成态保留记录。本报告由最终 Iteration 008 引用。
