# cs-agent-mcp

`cs-agent-mcp` 是一个本地 stdio MCP 服务。它把 Codex、Claude 等编码 Agent 统一成一组
`cs_agent_*` 工具，让根 Agent 可以创建、调用和管理子 Agent，子 Agent 也可以继续递归委派。

## 快速开始

运行环境：

- Node.js `22.13.0` 或更高版本。
- 已安装并登录准备使用的本机 Agent，例如 `codex` 或 `claude`。

推荐先全局安装并确认版本：

```bash
npm install -g cs-agent-mcp@latest
cs-agent-mcp --version
```

选择正在使用的根 Agent 注册 MCP。Codex 用户执行：

```bash
codex mcp add cs-agent -- cs-agent-mcp
codex mcp list
```

Claude Code 用户执行：

```bash
claude mcp add --scope user cs-agent -- cs-agent-mcp
claude mcp list
```

新开一个 Codex 或 Claude Code 会话后，可以直接发送下面的任务：

```text
请使用 cs-agent MCP 完成以下任务：
1. 先用 cs_agent_capabilities 探测 codex 和 claude。
2. 优先创建 codex 子 Agent；如果不可用，则创建 claude 子 Agent。
   让它审查当前仓库的改动。
3. 等待并读取回复，然后销毁子 Agent。
4. 最后向我总结审查结果。
```

根 Agent 会调用 `cs_agent_*` 工具完成创建、等待和销毁。完成 MCP 注册后，不需要手工常驻
`cs-agent-mcp` 进程。

## 其他安装方式

不做全局安装时，可以让 MCP 客户端通过 npm 直接启动当前最新版：

```bash
npx -y cs-agent-mcp@latest --version
codex mcp add cs-agent -- npx -y cs-agent-mcp@latest
```

Claude Code 对应命令是：

```bash
claude mcp add --scope user cs-agent -- npx -y cs-agent-mcp@latest
```

需要可重复的固定环境时，可以把 `@latest` 换成明确版本号。

无需安装 Claude 桌面应用，也无需为 MCP 再登录一次。Codex 和 Claude 子 Agent 会优先使用
本机 `codex`、`claude` 可执行文件，并沿用当前用户已有的登录状态；Claude 还会复用现有用户
设置。已显式设置的 `CODEX_PATH` 或 `CLAUDE_CODE_EXECUTABLE` 不会被覆盖。首次调用某个 Agent
时，如果对应 ACP 适配器尚未缓存，npm 可能下载适配器及其 SDK。这只是本地协议桥，不是重新
安装 Claude/Codex，也不需要手工配置适配器路径、端口或令牌。

## 支持的 Agent

| 支持级别     | Agent                                                                                                                                                                 | 说明                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 重点实机支持 | `codex`、`claude`                                                                                                                                                     | 内置 ACP 适配器，并在发布验证中使用本机登录状态执行真实任务                                |
| ACP 兼容支持 | `pi`、`openclaw`、`gemini`、`cursor`、`copilot`、`droid`、`fast-agent`、`grok-build`、`iflow`、`kilocode`、`kimi`、`kiro`、`mux`、`opencode`、`qoder`、`qwen`、`trae` | 使用与 acpx 0.12.0 一致的内置命令映射和同等级通用 ACP client/runtime；可用性取决于本机环境 |

“ACP 兼容支持”不是仅供展示的候选映射。这些 Agent 与 Codex、Claude 共用 Agent 创建和销毁、
持久或 oneshot 会话、消息与 Turn、权限回传、取消、事件、批量等待和 Workspace 共享控制面。
例如 `pi` 通过 `pi-acp` 启动，`openclaw` 使用原生 `openclaw acp`，`gemini` 使用原生 ACP 模式。
不同支持级别的区别是发布门禁的实机覆盖范围，不是 MCP 编排能力不同。

建议先调用 `cs_agent_capabilities` 并通过 `probeAgents` 探测准备使用的 Agent。探测会真实启动对应
ACP server 并完成 initialize 握手，而不只是检查命令名称。也可以在 `agents` 配置中新增或覆盖
任何提供 ACP stdio 接口的 Agent。

## 何时使用多 Agent

MCP 初始化信息和工具描述会主动提示调用 Agent 在以下场景考虑委派：

- 任务可以拆成相互独立、可并行验证的子任务。
- 需要不同 Agent runtime 承担互补角色，例如实现与独立审查。
- 子任务需要独立上下文、专门约束或较长时间运行，主 Agent 只负责协调结果。
- 当前结果需要第二个 Agent 给出独立证据，而不是在同一上下文中自我复核。

不要为很小、强顺序依赖、上下文无法独立描述，或当前 Agent 能直接快速完成的工作创建子 Agent。
委派本身有启动、传递上下文和汇总结果的成本。

异构协作时先用 `cs_agent_capabilities` 探测准备使用的多个 Agent，再根据当前任务给它们分配互补
角色。服务只报告配置名称、可用性和执行限制，不把容易过期的“某个品牌永远更擅长某类任务”
写成运行时事实。每个 `cs_agent_send` 都应给出自包含的目标、范围、约束、交付物和验证要求。

推荐工作流：

```text
cs_agent_capabilities
  -> cs_agent_create（按独立角色创建一个或多个 Agent）
  -> cs_agent_send（先给每个 Agent 发送自包含任务）
  -> cs_agent_wait_many（多个 Turn 使用 any/all 汇总；单 Turn 使用 wait_message）
  -> cs_agent_respond_permission / cs_agent_cancel（按需）
  -> cs_agent_destroy（不再需要时释放 Agent）
```

## 配置

### 配置服务

Codex 和 Claude 已经可以在本机正常工作时，不需要创建服务配置文件。需要修改默认权限、
超时或 Agent 命令时，可以使用以下两个 JSON 文件：

1. 用户级配置：`~/.cs-agent-mcp/config.json`
2. 项目级配置：`<cwd>/.cs-agent-mcprc.json`

项目级值覆盖用户级值。`<cwd>` 是启动命令的工作目录，或通过 `--cwd` 显式指定的目录。

```json
{
  "defaultAgent": "codex",
  "defaultPermissions": "approve-reads",
  "nonInteractivePermissions": "deny",
  "timeout": 1800,
  "agents": {
    "reviewer": {
      "command": "/absolute/path/to/acp-agent",
      "args": ["--stdio"]
    }
  },
  "mcpServers": [
    {
      "type": "stdio",
      "name": "project-tools",
      "command": "/absolute/path/to/project-tools-mcp",
      "args": []
    }
  ]
}
```

常用字段：

| 字段                        | 默认值          | 作用                                         |
| --------------------------- | --------------- | -------------------------------------------- |
| `defaultAgent`              | `codex`         | 根执行身份使用的默认 Agent 名称              |
| `defaultPermissions`        | `approve-reads` | `approve-all`、`approve-reads` 或 `deny-all` |
| `nonInteractivePermissions` | `deny`          | 无交互权限请求时选择 `deny` 或 `fail`        |
| `timeout`                   | 无限制          | 单次 Agent 调用的默认超时秒数                |
| `agents`                    | 内置注册表      | 新增或覆盖 ACP stdio Agent 命令              |
| `mcpServers`                | `[]`            | 注入每个受管 Agent 的其他 MCP 服务           |
| `auth`                      | `{}`            | ACP `authenticate` 方法与凭据的映射          |
| `authPolicy`                | `skip`          | 缺少匹配 ACP 凭据时选择 `skip` 或 `fail`     |

`agents` 中的命令必须提供 ACP stdio 接口，不能直接填一个只支持交互终端的普通 CLI。内置
`codex` 和 `claude` 已经配置了相应适配器，通常不应覆盖。

工作目录由 MCP roots 决定：客户端提供一个 workspace root 时，子 Agent 默认在该目录工作；
提供多个 roots 时，`cs_agent_create` 必须显式传入 `cwd`；客户端不支持 roots 时，服务使用
启动目录或 `--cwd` 的值；客户端声明支持 roots 但返回空集合时，服务拒绝启动工作区。
所有 `cwd` 都必须是位于客户端声明的 workspace roots 内的现有真实目录。

规范化后的 roots 集合也是共享边界。同一组 roots 即使顺序不同，也会连接到同一个本机控制面和
同一棵 Agent 树；Codex、Claude 等多个根控制台可以交叉查看、等待、取消和销毁其中的任务。不同
roots 集合仍使用完全隔离的状态、身份和进程锁。

## 启动

完成 MCP 注册后，无需手工常驻进程。Codex 或 Claude 会在需要时自动启动 stdio 服务：

```bash
cs-agent-mcp
```

不做全局安装时对应命令是：

```bash
npx -y cs-agent-mcp
```

需要指定没有 roots 能力时的后备工作目录：

```bash
cs-agent-mcp --cwd /absolute/path/to/workspace
```

该命令作为轻量前端通过 stdin/stdout 传输 MCP 协议，正常启动后不会打印交互式提示，也不会监听
公网端口。前端会按需发现或启动一个仅绑定本机回环地址的 Broker；同一 workspace 的多个前端共享
Broker 内唯一的 Facade/runtime owner。最后一个前端离开后，Broker 会经过短暂 grace 再收束 runtime
并释放 workspace lock；grace 内重连不会更换 lock generation。运行状态、Agent 会话和事件历史
保存在 `~/.cs-agent-mcp/`，无需手工管理后台服务。

## MCP 能力

典型流程是：先检查能力，再按独立角色创建子 Agent，发送带幂等键且可独立执行的任务，循环等待
结果，最后按需取消 Turn 或销毁 Agent。MCP server instructions、工具 description 和输入 schema
字段说明都携带这套决策与编排提示，即使宿主只展示 `tools/list` 也能看到关键使用条件。

| 工具                          | 主要参数                                                             | 能力                                                              |
| ----------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `cs_agent_capabilities`       | `probeAgents?`                                                       | 列出工具、限制、内置 Agent，并可真实探测指定 Agent                |
| `cs_agent_create`             | `agent`、`name?`、`cwd?`、`mode?`、`sessionOptions?`                 | 创建使用持久或一次性 ACP 会话模式的受管 Agent                     |
| `cs_agent_list`               | `parentAgentId?`、`agent?`、`state?`、`cursor?`、`limit?`            | 分页列出当前调用者可见的委派子树                                  |
| `cs_agent_status`             | `agentId`                                                            | 查询生命周期、队列、权限和底层运行时状态                          |
| `cs_agent_events`             | `afterCursor?`、`agentId?`、`turnId?`、`limit?`、`waitMs?`           | 增量读取结构化事件，支持最长 30 秒等待                            |
| `cs_agent_send`               | `agentId`、`content`、`idempotencyKey`、`attachments?`、`timeoutMs?` | 向子 Agent 的 FIFO 队列发送幂等任务，返回 `messageId` 和 `turnId` |
| `cs_agent_get_message`        | `messageId`                                                          | 读取一条不可变输入或回复消息                                      |
| `cs_agent_wait_message`       | `turnId` 或 `messageId`、`waitMs?`                                   | 等待回复、权限请求或无回复的终态                                  |
| `cs_agent_wait_many`          | `turnIds`、`mode?`、`waitMs?`                                        | 等待任意或全部 Turn，返回 ready 与 pending 集合                   |
| `cs_agent_get_turn`           | `turnId`                                                             | 读取 Turn 状态、修订号、错误和关联消息                            |
| `cs_agent_wait_turn`          | `turnId`、`afterRevision?`、`waitMs?`                                | 等待 Turn 状态变化或权限请求                                      |
| `cs_agent_respond_permission` | `permissionId`、`outcome`                                            | 允许、拒绝或取消待处理权限请求                                    |
| `cs_agent_cancel`             | `turnId`、`reason?`                                                  | 取消排队中或运行中的 Turn，并取消其未完成后代 Turn                |
| `cs_agent_destroy`            | `agentId`、`cascade?`、`discardSession?`                             | 销毁 Agent，可递归销毁后代并丢弃底层会话                          |

默认 `defaultPermissions` 是 `approve-reads`：读取类权限可以自动批准，写入等其他操作不会被静默
批准。权限请求会通过等待工具返回给祖先调用者，由它调用 `cs_agent_respond_permission` 处理；没有
可交互调用者时，默认 `nonInteractivePermissions: "deny"` 会拒绝该请求。

`sessionOptions` 支持 `model`、`systemPrompt`、`allowedTools` 和 `maxTurns`。附件使用
`{ "mediaType": "...", "data": "<base64>" }`。`cs_agent_send` 的
`idempotencyKey` 在同一调用者范围内全局去重；重试同一任务时应复用原键，向不同 Agent
发送任务时也必须使用不同的键。兼容字段 `timeoutMs` 不限制 Agent 任务执行时间；调用方应通过
等待、取消和 `maxTurns` 管理任务，而不是按预估耗时设置 Turn deadline。

`maxTurns` 限制的是一个任务在 Agent 内部可使用的 agentic turns，不是 Facade Turn 数量。代码
审查等工具调用较多的任务通常需要 `8-12`；没有严格预算时建议省略并使用适配器默认值。达到
上限时 Turn 会保持 `failed`，返回 `MAX_TURNS_EXCEEDED`，且不会自动提高限制或重试任务。

`persistent` 模式要求服务重启后恢复原 ACP 会话，无法恢复时明确失败；`oneshot` 模式允许
底层运行时在原会话不可用时建立新会话，因此不承诺跨重连保留上下文。两种模式下的 Facade
Agent 都可以接收多个串行 Turn，直到祖先调用 `cs_agent_destroy`。受管 Agent 不能销毁自己。
`discardSession` 依赖目标 ACP 适配器支持 `session/close`；不支持时会返回明确错误并保留可恢复
状态，普通销毁不受影响。

多个独立任务应先完成全部 `cs_agent_send`，再调用 `cs_agent_wait_many`。`mode: "any"` 在至少一个
Turn ready 时返回该轮全部 ready 项；`mode: "all"` 通常等待全部终态，但权限请求会提前返回，避免
调用方与子 Agent 死锁。权限或 timeout 中断 all 时，按 `turnId` 累计每轮 `ready`，后续 message 或
terminal 覆盖较早的 action_required，并继续等待返回的 `pendingTurnIds`。timeout 不取消 Turn。

等待工具单次最多等待 30 秒。单 Turn 可继续使用 `cs_agent_wait_message` 或 Turn revision；事件流使用
Event cursor。不要通过无限长的单次 MCP 调用阻塞宿主。

受管 Agent 会自动获得一个经过身份认证、仅回环访问的同一 Facade MCP 连接，因此 Claude 可以
再创建 Codex 子 Agent，Codex 也可以继续委派，无需为每一层配置 MCP。调用者只能查看和操作
自己的委派子树；同一 Agent 的 Turn 严格串行，不同 Agent 可以并行执行。默认限制为递归深度
4、受管 Agent 16 个、每个 Agent 排队 32 个 Turn、全局并发 Turn 8 个。

完整状态会持久化。服务重启后，历史 Message、Turn 和 Event 仍可查询；持久 Agent 会尝试加载
原 ACP 会话，无法恢复时会明确失败，不会静默创建一个丢失上下文的新会话。

## 诊断 CLI

`cs-agent-mcp agents` 提供只读本地排障入口，不启动 MCP stdio 服务，不连接 Broker，也不持有
Broker credential 或 loopback token。它只读取 `~/.cs-agent-mcp/mcp/facades/` 中的 snapshot/lock
以及 `~/.cs-agent-mcp/sessions/` 中已有的 runtime session record，并可同时展示多个 workspace：

```bash
cs-agent-mcp agents list
cs-agent-mcp agents list --all --json
cs-agent-mcp agents status <agent-id-or-prefix>
cs-agent-mcp agents attach <agent-id-or-prefix> --history 20
cs-agent-mcp agents top
cs-agent-mcp agents ps --all
```

`list` 默认只显示 running 实例里的非 destroyed Agent；`--all` 会包含 stopped/unknown 实例和
destroyed Agent。`status` 和 `attach` 的 selector 在全集解析：完整 Agent ID 可在其他 snapshot
损坏时继续匹配；前缀遇到损坏 snapshot 会 fail closed，要求使用完整 ID。

文本输出会分别标记 Agent 的 `KIND` 和 `RUNTIME`。`root` 是当前 MCP 客户端在 Facade 中的
调用者身份，不承载受管 runtime，也不会产生可跟随的任务输出；通过 `cs_agent_create` 创建的
`managed` Agent 才会记录 Turn、工具活动和输出事件。

`top`（别名 `ps`）在交互式终端中打开实时全屏视图，每秒刷新 Agent 状态。方向键、`j/k`、
PageUp/PageDown、Home/End、鼠标单击和滚轮用于选择；Enter 对选中的 managed Agent 进入同屏
Attach，Esc 返回列表，`/` 过滤，`a` 切换是否包含全部状态，`r` 刷新，`q` 或 `Ctrl-C` 退出。
`--all` 只决定初始显示范围。root 行可查看但不可 Attach；终端小于 72x12 时会显示尺寸提示。

`top|ps` 的 Attach 子视图按原会话顺序显示用户消息、Agent 文本、thinking、tool call 输入和 tool
result 输出；每项使用 `[USER]`、`[ASSISTANT]`、`[THINKING]`、`[TOOL CALL]`、
`[TOOL RESULT]` 或 `[TOOL ERROR]` 标题区分类型，正文另起一行。mention 与媒体显示只读摘要，
不输出媒体二进制。长内容按终端宽度换行，向上滚动会暂停自动跟随并按新增消息数累计未读数，
End 恢复实时跟随。persistent Agent 读取固定 session record；oneshot Agent 按时间合并同一 Agent
已有的原生 task session records。历史 session 不存在时显示 conversation unavailable 和已有错误，
不会无限显示 loading。会话内容不为 TUI 新建历史副本，也不启动 Agent。`top|ps` 要求
stdin/stdout 都是 TTY；重定向或脚本场景应使用 `list --json` 或 `attach --json`，不会输出 ANSI
控制序列。

独立的 `agents attach` 命令保持事件流接口：先输出目标 Agent 的当前 snapshot 和有限历史，再按
cursor 只读跟随新事件。它不会发送
消息、响应权限、取消 Turn 或修改任何状态；Agent destroyed 时返回 0，实例 stopped/unknown 或
generation 更替时在最终 drain 后返回非零，`Ctrl-C` 返回 0。

JSON 输出使用 `cs-agent-mcp.diagnostics.v1`。`attach --json` 是 JSONL，每行只会是
`snapshot`、`event` 或 `terminal`。事件投影只暴露 allowlist 字段：output stream 的文本、
有界工具摘要、状态和终态错误摘要。thought 文本、identity、完整 Message、Permission request、
raw tool payload、`rawInput`、`rawOutput` 和其他未知字段不会输出。

## 故障排查

| 现象                           | 检查方式                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 安装到的版本不符合预期         | 运行 `npm view cs-agent-mcp version` 和 `cs-agent-mcp --version`，然后重新安装 `cs-agent-mcp@latest`           |
| 根 Agent 看不到 MCP            | 运行 `codex mcp list` 或 `claude mcp list`，确认存在 `cs-agent`，然后新开客户端会话                            |
| Codex 或 Claude 探测失败       | 先运行 `codex --version` 或 `claude --version`，确认对应 CLI 已安装并登录，再调用 `cs_agent_capabilities` 探测 |
| 第一次调用较慢                 | 等待 npm 下载对应 ACP 适配器及 SDK；网络失败后可以重试，不需要单独安装适配器                                   |
| 手工启动后没有终端提示         | 这是正常行为；`cs-agent-mcp` 使用 stdin/stdout 传输 MCP 协议，不提供交互式界面                                 |
| 不知道哪个 Agent 卡住          | 在终端运行 `cs-agent-mcp agents top` 实时浏览，或用 `agents list --all` 后接 `agents status <agent-id>`        |
| 想阅读某个 Agent 的完整会话    | 运行 `cs-agent-mcp agents top` 后选择 managed Agent 并按 Enter；消息、thinking 和工具调用均只读显示            |
| 想跟随某个 Agent 的原始事件    | 运行 `cs-agent-mcp agents attach <agent-id>`；这是只读事件流，不会响应权限或取消任务                           |
| Broker 版本不兼容              | 关闭使用旧 Broker 的全部 MCP 根客户端后重试；活跃旧 Broker 不会被新前端强制终止                                |
| `cwd` 或 workspace root 被拒绝 | 确认目录真实存在，并且位于 MCP 客户端声明的 workspace roots 内                                                 |

## 稳定性与反馈

项目当前处于 `0.x` 阶段。工具名、输入字段、结构化输出和持久化 schema 属于公开契约；升级前
请查看[更新日志](CHANGELOG.md)。发现安装、兼容性或运行问题时，请通过
[GitHub Issues](https://github.com/codestable/cs-agent-mcp/issues) 反馈。

架构与安全边界见 [MCP 架构设计](docs/MCP_ARCHITECTURE.md)。
