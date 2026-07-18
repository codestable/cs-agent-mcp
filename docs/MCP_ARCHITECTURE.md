# MCP 架构设计

本文档描述 `cs-agent-mcp` 已落地的本地多 Agent MCP 架构、公开能力和安全边界。

## 目标

根 Agent 只需注册一次 `cs-agent-mcp`，之后可以通过结构化 MCP 工具创建和管理本机编码
Agent。受管 Agent 自动连接同一个 Facade，因此可以继续创建自己的子 Agent。

典型链路：

```text
Codex（根 Agent）
  -> cs-agent-mcp
  -> Claude（代码审查）
  -> cs-agent-mcp loopback
  -> Codex（Claude 派发的子任务）
```

整个链路不解析 PTY 文本。MCP 负责控制面，ACP 负责与每个编码 Agent 的会话通信。

## 组件

```text
MCP 宿主
  | stdio MCP
  v
Transport
  | roots / schema / structured result
  v
MultiAgentFacade ---- FileFacadeStore
  |                       |
  |                       +-- Agent / Turn / Message / Permission / Event
  |
  +-- RuntimeAdapter ---- ACP Runtime ---- ACP Adapter ---- Codex / Claude
  |
  +-- Loopback HTTP MCP + scoped bearer token
          ^
          |
      受管子 Agent
```

### Transport

根 MCP 客户端通过 stdio 连接。初始化后，服务读取客户端的 workspace roots，并启动只绑定
loopback 的 HTTP MCP transport。HTTP transport 只供受管 Agent 递归委派，不对外网开放。

### MultiAgentFacade

Facade 是 Agent 控制面的唯一状态所有者，负责：

- 委派树和可见范围。
- 每个 Agent 的 FIFO Turn 队列。
- 跨 Agent 的有界并发。
- 幂等消息接收。
- Permission 的挂起、回传和恢复。
- Event cursor 与 Turn revision。
- 取消、销毁和服务重启恢复。

### ACP Runtime

Runtime 负责解析内置 Agent 名称、启动 ACP adapter、创建或加载 ACP 会话、标准化事件并处理
进程生命周期。Facade 不直接理解 Codex/Claude 私有协议。

## 领域对象

- `Agent`：稳定的受管 Agent 身份，包含父子关系、状态和底层 ACP handle。
- `Message`：不可变输入或终态回复，使用 `messageId` 标识。
- `Turn`：处理一条输入 Message 的排队执行，使用 `turnId` 标识并带单调递增 revision。
- `Permission`：一次待决 ACP 权限请求，只能成功决策一次。
- `Event`：结构化状态变化或 ACP 输出，使用不透明 cursor 增量读取。

流式文本、工具调用和状态变化属于 Event；最终可关联的输入与回复属于 Message。

## 工具分组

- 能力与发现：`cs_agent_capabilities`
- Agent 生命周期：`cs_agent_create`、`cs_agent_list`、`cs_agent_status`、
  `cs_agent_destroy`
- 消息与 Turn：`cs_agent_send`、`cs_agent_get_message`、`cs_agent_wait_message`、
  `cs_agent_get_turn`、`cs_agent_wait_turn`
- 事件：`cs_agent_events`
- 控制：`cs_agent_respond_permission`、`cs_agent_cancel`

公开 schema 和参数说明以 [README](../README.md#mcp-能力) 为准。

MCP initialize instructions 负责告诉调用 Agent 何时应采用并行、异构或独立审查式委派，以及何时
不应为简单或强耦合任务增加子 Agent。每个工具 description 进一步说明它在标准
`capabilities → create → send → wait → destroy` 流程中的位置，输入 schema 对每个顶层参数提供说明；
annotations 标注只读、幂等和破坏性操作。这些元数据属于 Agent 的运行时决策入口，不能只写在用户
文档中。

Agent runtime 的品牌能力会随版本和本地配置变化。Facade 因此只报告配置名称、实时可用性和执行
限制，不硬编码“某个 Agent 永远适合某类任务”；调用者根据当前任务把不同 Agent 分配给互补角色。

## 执行语义

### 创建

`cs_agent_create` 只接受已注册的 Agent 名称，不接受任意 shell command。`persistent` Agent
要求后续 Turn 和服务重启恢复原 ACP 会话；`oneshot` 允许底层运行时在重连失败时建立新会话，
因此不承诺跨重连保留上下文。两种模式的 Facade Agent 都保留到祖先显式销毁。

### 发送与等待

`cs_agent_send` 先持久化输入 Message 和 Turn，再返回 receipt。相同调用者使用同一个
`idempotencyKey` 重试相同任务时返回原 receipt；相同键用于不同内容或不同目标 Agent 时会失败。

等待操作单次最长 30 秒。超时只是“目前没有变化”，不会取消底层 Turn。调用者使用 revision
或 cursor 继续等待，避免一个无限长 MCP 请求占住宿主。

### 权限

ACP adapter 产生权限请求时，Turn 进入 `waiting_permission`。Facade 持久化 Permission，并把
`permissionId` 返回有权处理的祖先。处理结果映射回原 ACP 请求，之后 Turn 继续执行。

### 取消与销毁

取消会覆盖排队或运行中的 Turn，并向底层 ACP 会话发送取消信号；由该 Turn 创建且尚未完成的
后代 Turn 同时取消。销毁默认保留底层会话，可通过 `discardSession` 明确丢弃；存在后代时需要
`cascade`。受管 Agent 不能销毁自己，必须由有权访问它的祖先执行销毁。

## 递归委派

创建受管 Agent 时，Facade 为其签发限定身份的 bearer token，并将 loopback MCP 定义注入
ACP session。子 Agent 调用工具时，服务从 token 恢复 actor，而不是相信调用参数中的身份。

每个 actor 只能读取和操作自己的委派子树。兄弟 Agent 互相不可见，子 Agent 也不能访问祖先
或其他根执行的状态。Agent 被销毁后，其 token 会撤销。

## Workspace 隔离

- 一个 root：作为默认 `cwd` 和允许边界。
- 多个 roots：创建 Agent 时必须明确传 `cwd`。
- 没有 roots 能力：使用进程 cwd 或 `--cwd`。
- 声明 roots 能力但返回空集合：拒绝建立工作区。
- 所有显式 `cwd` 都必须是现有目录，并在创建和恢复时经过真实路径边界校验。

每组 roots 使用独立持久化文件和进程锁，避免两个 MCP 进程同时修改同一控制面。

## 持久化与恢复

Facade snapshot、ACP session 和锁文件位于 `~/.cs-agent-mcp/`。写入使用临时文件加原子 rename，
敏感文件权限限制为当前用户。

服务重启时：

1. 恢复 Agent、Message、Turn、Permission 和 Event。
2. 将此前运行中的 Agent 标记为可恢复的 dormant 状态。
3. 下一次发送时加载同一个 ACP session。
4. 原 session 无法加载时返回明确错误，不静默创建新 session。

## 本地只读诊断路径

`cs-agent-mcp agents list|status|attach|top` 是独立于 MCP stdio 服务的本地诊断入口；`ps` 是
`top` 的等价别名。它不启动
Facade、不加载 ACP runtime、不签发 HTTP 身份 token，也不调用任何 mutation 工具；唯一观察源是
`~/.cs-agent-mcp/mcp/facades/` 下的 Facade snapshot 和同路径 lock 文件。

诊断路径把 snapshot 投影成 `cs-agent-mcp.diagnostics.v1` DTO。`list` 和 `status` 输出稳定 JSON
文档或终端文本；`attach --json` 输出 JSONL，记录类型只允许 `snapshot`、`event` 和 `terminal`。
事件投影按字段 allowlist 输出：output 文本、有界工具摘要、状态和终态错误摘要。thought 文本、
identity、完整 Message、Permission request、raw tool payload 和未知字段都不会透传。

lock 只用于 best-effort 判断实例 running/stopped/unknown 和 generation 更替。`attach` 在
generation 更替、实例停止或 Agent destroyed 前会按 cursor 做最终 drain，但不会跨新 generation
继续跟随。诊断 CLI 的权限边界是当前 OS 用户对本地状态目录的读取权限；HTTP actor token 仍是
受管 Agent 控制面的唯一授权机制。

实时 TUI 位于 diagnostics 的独立 `tui/` 子模块。controller 只依赖 `AgentDiagnostics` 的
`listAgents()` 和 `attachAgent()` 读接口；renderer、状态机与 terminal adapter 分离，Facade 和 MCP
transport 不反向依赖终端库。`terminal-kit` 只在 `top|ps` action 中动态加载，因此无参数 stdio、
`list/status/attach` 和 13 个 MCP tools 不加载 TUI CJS 依赖。

列表读取以 epoch 串行合并，Attach generator 由 generation、AbortController 和唯一 pump 管理；
模式切换或退出会等待旧 pump 收束。renderer 在测量和绘制前再次净化 diagnostics DTO，剥离终端
控制序列并按显示宽度裁剪。adapter 统一持有 alternate screen、cursor、SGR mouse、raw mode 和
listener 生命周期，所有退出路径执行幂等恢复。非 TTY 不进入 adapter，也不输出 ANSI。

## 默认限制

| 限制                     |  默认值 |
| ------------------------ | ------: |
| 最大递归深度             |       4 |
| 最大受管 Agent 数        |      16 |
| 每个 Agent 最大排队 Turn |      32 |
| 最大并发 Turn            |       8 |
| 单次等待时长             |   30 秒 |
| 权限等待时长             |   30 秒 |
| 子 Agent 身份有效期      | 24 小时 |

## 非目标

- 不提供跨机器调度或公网 MCP 服务。
- 不自动选择 Agent、投票、仲裁或合并结果。
- 不创建 Git worktree，也不负责代码合并。
- 不绕过 Codex、Claude 或其他 Agent 自身的登录和授权边界。
- 不保证未经安装或未经认证的目标 Agent 可以工作。
