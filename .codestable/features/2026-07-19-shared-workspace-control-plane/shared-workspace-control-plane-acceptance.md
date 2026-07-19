---
doc_type: feature-functional-acceptance
feature: 2026-07-19-shared-workspace-control-plane
status: passed
accepted: 2026-07-19
reviewer: native-task-agent
reviewer_agent_id: /root/shared_workspace_acceptance
---

# Workspace 共享控制面功能验收

## Verdict

独立功能验收 verdict 为 `pass`：17 个场景与 C01-C18 全部通过，当前代码无功能 fail 或未闭合的
blocking/important gap。Shared Workspace Control Plane Goal 可以标记 complete。

## Reviewer 与范围

- Reviewer：用户可见原生 Task agent `/root/shared_workspace_acceptance`。
- Role：只读 functional acceptance auditor。
- Scope：批准设计的 17 个场景、C01-C18、最终 diff、自动化、多进程、SDK 黑盒、tarball、TUI
  与真实 Host 条件。

## 功能证据

- 同 Workspace 多根 stdio 客户端共享唯一 Facade/runtime owner 和 Agent 树，可跨客户端管理任务；
  不同 Workspace 保持隔离。
- 根连接退出、SIGKILL、grace 重连、Broker SIGKILL 与旧协议 replacement 均按设计恢复或 fail closed。
- reverse-ready 按 session 隔离；延迟成功，405、断开与超时返回独立错误，未误报 roots 非法。
- 慢 roots 初始化跨越 grace 后 Broker pid 和 Workspace lock token 保持不变。
- stale lock 跨时区与双 contender 真实子进程测试严格只有一个 owner。
- diagnostics/TUI 跨 Workspace 只读；tarball 的公开命令、13 tools、两个 v1 schema 和 runtime
  capability 边界未改变。

## Fresh Evidence

- 独立定向测试 62/62 通过，耗时 53.68 秒。
- 独立 SDK 黑盒再次验证 grace、frontend SIGKILL、延迟 roots 和约 5005ms reverse-ready timeout。
- Iteration 007 的主流程 `pnpm run check` 246/246、TUI PTY、tarball 临时安装与 13-tools SDK smoke
  均通过。
- 最终 fresh `pnpm run check` 255/255 通过，pack dry-run 成功。

## TUI 完整会话验收

- Top Attach 直接读取 runtime 恢复已使用的 session record，按原顺序展示 user/agent 文本、thinking、
  tool call input 和同 ID tool result；mention 与媒体只显示只读摘要，没有新增历史副本。
- redacted thinking DTO 不携带原始 payload，Facade event 不进入 conversation viewport；长工具名、多行
  与长文本不会遮挡正文，paused/live 按实际渲染行保持视口。
- session refresh 为 single-flight；挂起 `readConversation` 时按 `q` 会先解除 terminal handler、退出
  raw/alternate screen 并返回，不等待不可取消的只读读取。
- 独立最终验收：diagnostics/TUI 26/26、`agents attach --json` 契约 3/3 通过，无 blocking 或
  important finding。
- 最终 tarball 临时安装的 MCP SDK smoke 返回 `toolCount=13`、lifecycle/diagnostics `ok`；PTY 的
  top/ps、键鼠、resize、完整 conversation attach 与 terminal restore 全部 `ok`。

## C16 真实 Host 验收

- Codex 0.144.5 与 Claude 2.1.186/Opus 4.8 均以真实 provider 成功运行，只加载当前
  `dist/mcp-cli.js`。
- Claude 对 Codex 创建的 Agent `b6c45bd8-60c3-4863-a1f3-9be0b94beb21` 完成 list/status/send/
  cancel/wait/destroy；共享 Turn `a8f4a7fd-e82b-4b33-8922-2c65c41ab4e6` 达到 `cancelled` 终态。
- 严格并行时 Codex interactive 根持续连接，Claude 根跨连接销毁 Codex 创建的 Agent
  `7554290b-f2ee-4a0c-b2fc-48c77c6eaa93`；Broker pid 27871 与 lock token
  `052072e9-5332-435b-b6b8-a7c2f2f1bb0c` 全程不变。
- 最后根退出后 diagnostics 为空、Broker 与 Workspace lock 均清理。
- Pi、OpenClaw、Gemini 与通用 ACP runtime capability 由既有 13-tools E2E/capabilities 断言覆盖，
  支持矩阵未缩减。

## Owner-facing tarball 复验

- 未发布版本；直接对 `npm pack` 的 `cs-agent-mcp-0.2.3.tgz` 做隔离临时安装，因此验证的是与待发布
  包一致的文件集合，同时不影响 owner 当前全局安装。
- Codex/Claude 通过该临时 binary 共享 Agent `c66bdebe-2b64-4fd3-b6b0-5cb36fbcb2eb`；Claude
  可见相同 Agent/Turn ID 并跨 Host 销毁。Claude 退出后 Codex 仍完成第二个 Agent 的完整生命周期。
- 独立长 Turn `3eaf8065-c5a6-4e5b-a2a4-570a080f1044` 由 Claude cancel，双方 wait 均观察到
  `cancelled` 与 `stopReason=cancelled`，再由 Claude destroy。
- `agents top` 的真实 PTY 首页、attach 实时事件和退出恢复通过，自动 PTY suite 也全部 `ok`。
- 最终 diagnostics 为 `agents=[]`、`warnings=[]`，临时安装对应 Broker 与当前 Workspace lock 均不存在。

## 残余风险

- 验收 shell 若注入 `CODEX_API_KEY` / `OPENAI_API_KEY`，会遮蔽用户本机 Codex auth；实机复验应
  清除这些仅限验收子进程的覆盖。
- Codex 同时加载全局 `cs-agent` 与临时 `c16` 会产生重复 MCP server；复验应只启用一个当前构建。
- POSIX 秒级 process generation 与 registry 级 initialization hold 的保守回收行为属于已记录的
  optional residual，不构成当前代码 blocking finding。

## Follow-up

无 required follow-up。后续发布、commit、push、tag 与 npm publish 仍等待 owner 明确指令。

## Task Agent 生命周期

验收结果已消费并落盘。当前宿主未暴露 `close_agent` 等价动作，无法显式关闭已完成的
`/root/shared_workspace_acceptance`；该 warning 不改变 verdict。

本报告由最终 Iteration 008 引用。
