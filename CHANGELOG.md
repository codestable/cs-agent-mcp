# 更新日志

本文件记录 `cs-agent-mcp` 的用户可见变更。

## 未发布

### 受管 Claude 递归身份修复

- 受管 Claude 现在会把用户配置中直接或通过常用 package-exec 命令启动 `cs-agent-mcp` 的 MCP
  别名安全覆盖为当前 Agent 的 bearer loopback 入口，避免子 Agent 被错误创建为 sibling。
- 其他 Claude 用户设置、skills、hooks、plugins 和无关 MCP 继续保留；用户配置不会被修改或复制。

## 0.2.5 - 2026-07-20

### Agent Wait Many

- 新增 `cs_agent_wait_many`，支持先异步 fan-out 多个 Turn，再按 `any` 或 `all` 一次 fan-in；
  `any` 返回当前全部 ready 项，`all` 支持权限/timeout 中断后通过 `pendingTurnIds` 续等并跨轮累计。
- Facade 提供 `waitMany`、`waitAny`、`waitAll`，批量等待使用单 snapshot 原子鉴权和单个 revision
  waiter，不修改 Facade snapshot v1 或既有 13 个工具的行为。
- tarball smoke 现在通过实际临时安装验证 14 tools，并调用 wait-many 完成 Agent 生命周期。

### Prompt 超时完整性修复

- `cs_agent_send.timeoutMs` 不再被错误地用作整个 Agent Turn 的执行期限，长时间代码审查不会因
  提交 timeout 提前取消；同一幂等任务仅 `timeoutMs` 不同时也会复用原 receipt，升级前包含
  timeout 的旧 fingerprint 会在首次成功重试时惰性迁移。
- ACP prompt 真正超时时现在返回 `failed/TIMEOUT`；已到达的过程事件仍可用于诊断，但不会再把
  部分文本或 tool result 伪装成最终 Message 和 `completed/end_turn`。

### Agent Top 会话可读性

- `agents top|ps` 的 Attach 现在可读取并按时间合并 oneshot Agent 的原生 session records；历史
  session 不存在时显示 conversation unavailable 和已有错误，不再无限停在 waiting。
- 用户、助手、thinking、tool call、tool result 和 tool error 使用独立类型标题与缩进正文；滚动
  视口继续按渲染行稳定定位，paused 未读数改为按新增消息计算。

## 0.2.4 - 2026-07-19

### Workspace 共享控制面

- 多个 Codex、Claude 等独立 stdio 根客户端现在通过机器级按需 Broker 共享同一 Workspace 的唯一
  Facade/runtime owner 和 Agent 树；规范 roots 顺序不同仍可交叉管理任务，不同 Workspace 继续隔离。
- stdio 前端使用有状态 Streamable HTTP bridge 和按 session 隔离的 reverse SSE channel；roots 通道
  405、断开或超时会返回 `BROKER_REVERSE_CHANNEL_UNAVAILABLE`，不再被误判为 roots 非法。
- 根连接使用 lease 与 grace 收束。单个前端退出或被 SIGKILL 不影响其他根；grace 内重连保持原 lock
  token，最后连接离开后才关闭 runtime、释放 lock，并让空闲 Broker 自动退出。
- Broker descriptor、认证、版本握手和 stale recovery 均 fail closed；活跃旧协议 Broker 不会被新版
  前端终止，Broker crash 后下一连接恢复 snapshot/session 且不静默创建丢失上下文的新 session。
- 初始化中的 root session 同样参与活跃判断并暂停 grace；关闭按 HTTP listener、session、
  Facade/runtime、Workspace lock 顺序收束，进程锁可识别 PID 复用并串行化 stale recovery。
- `agents list|status|attach|top` 保持只读并跨 Workspace 扫描，不连接 Broker；13 tools、Facade snapshot
  v1、diagnostics v1 和通用 ACP runtime 支持面不变。
- `agents top` 的 Attach 现在直接只读已有 runtime session record，以对话顺序展示用户消息、Agent
  文本、thinking、tool call/result；长内容换行且 paused/live 按实际行计数，不为 TUI 复制历史。

### 产品边界

- 明确保留通用 ACP runtime 与 Pi、OpenClaw、Gemini 等内置 Agent 映射；公开入口聚焦 stdio MCP、
  13 个 `cs_agent_*` 工具和 `agents` 只读诊断命令。
- 运行时错误改为提供可直接通过 MCP 执行的恢复建议，并统一使用 `cs-agent-mcp` 日志前缀。

## 0.2.3 - 2026-07-18

### MCP 生命周期修复

- stdio 客户端关闭 stdin 或异常退出后，MCP 服务现在会关闭 loopback server、Facade 和 runtime，
  并释放 workspace lock，避免孤儿进程阻止后续 Codex/Claude 会话启动子 Agent。

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
