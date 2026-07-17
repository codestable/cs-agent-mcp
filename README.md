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

| 支持级别     | Agent                                                                                                                                                                 | 说明                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 重点支持     | `codex`、`claude`                                                                                                                                                     | 内置 ACP 适配器，并在发布验证中执行真实调用                                          |
| 内置命令映射 | `pi`、`openclaw`、`gemini`、`cursor`、`copilot`、`droid`、`fast-agent`、`grok-build`、`iflow`、`kilocode`、`kimi`、`kiro`、`mux`、`opencode`、`qoder`、`qwen`、`trae` | 可用性取决于对应本机 CLI、登录状态和 ACP 支持，不承诺与 Codex、Claude 相同的实机覆盖 |

建议先调用 `cs_agent_capabilities` 并通过 `probeAgents` 探测准备使用的 Agent。也可以在
`agents` 配置中新增或覆盖任何提供 ACP stdio 接口的 Agent。

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

该命令通过 stdin/stdout 传输 MCP 协议，正常启动后不会打印交互式提示，也不会监听公网端口。
运行状态、Agent 会话和事件历史保存在 `~/.cs-agent-mcp/`；同一 workspace 同时只能由一个
`cs-agent-mcp` 进程持有。

## MCP 能力

典型流程是：先检查能力，再创建子 Agent，发送带幂等键的任务，循环等待结果，最后按需取消
Turn 或销毁 Agent。

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
发送任务时也必须使用不同的键。

`maxTurns` 限制的是一个任务在 Agent 内部可使用的 agentic turns，不是 Facade Turn 数量。代码
审查等工具调用较多的任务通常需要 `8-12`；没有严格预算时建议省略并使用适配器默认值。达到
上限时 Turn 会保持 `failed`，返回 `MAX_TURNS_EXCEEDED`，且不会自动提高限制或重试任务。

`persistent` 模式要求服务重启后恢复原 ACP 会话，无法恢复时明确失败；`oneshot` 模式允许
底层运行时在原会话不可用时建立新会话，因此不承诺跨重连保留上下文。两种模式下的 Facade
Agent 都可以接收多个串行 Turn，直到祖先调用 `cs_agent_destroy`。受管 Agent 不能销毁自己。
`discardSession` 依赖目标 ACP 适配器支持 `session/close`；不支持时会返回明确错误并保留可恢复
状态，普通销毁不受影响。

等待工具单次最多等待 30 秒。未完成时应使用返回的 Turn 修订号或 Event cursor 继续等待，
不要通过无限长的单次 MCP 调用阻塞宿主。

受管 Agent 会自动获得一个经过身份认证、仅回环访问的同一 Facade MCP 连接，因此 Claude 可以
再创建 Codex 子 Agent，Codex 也可以继续委派，无需为每一层配置 MCP。调用者只能查看和操作
自己的委派子树；同一 Agent 的 Turn 严格串行，不同 Agent 可以并行执行。默认限制为递归深度
4、受管 Agent 16 个、每个 Agent 排队 32 个 Turn、全局并发 Turn 8 个。

完整状态会持久化。服务重启后，历史 Message、Turn 和 Event 仍可查询；持久 Agent 会尝试加载
原 ACP 会话，无法恢复时会明确失败，不会静默创建一个丢失上下文的新会话。

## 故障排查

| 现象                           | 检查方式                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 安装到的版本不符合预期         | 运行 `npm view cs-agent-mcp version` 和 `cs-agent-mcp --version`，然后重新安装 `cs-agent-mcp@latest`           |
| 根 Agent 看不到 MCP            | 运行 `codex mcp list` 或 `claude mcp list`，确认存在 `cs-agent`，然后新开客户端会话                            |
| Codex 或 Claude 探测失败       | 先运行 `codex --version` 或 `claude --version`，确认对应 CLI 已安装并登录，再调用 `cs_agent_capabilities` 探测 |
| 第一次调用较慢                 | 等待 npm 下载对应 ACP 适配器及 SDK；网络失败后可以重试，不需要单独安装适配器                                   |
| 手工启动后没有终端提示         | 这是正常行为；`cs-agent-mcp` 使用 stdin/stdout 传输 MCP 协议，不提供交互式界面                                 |
| workspace 被占用               | 关闭同一 workspace 的重复 MCP 客户端或遗留进程；同一时间只能有一个服务进程持有该 workspace                     |
| `cwd` 或 workspace root 被拒绝 | 确认目录真实存在，并且位于 MCP 客户端声明的 workspace roots 内                                                 |

## 稳定性与反馈

项目当前处于 `0.x` 阶段。工具名、输入字段、结构化输出和持久化 schema 属于公开契约；升级前
请查看[更新日志](CHANGELOG.md)。发现安装、兼容性或运行问题时，请通过
[GitHub Issues](https://github.com/codestable/cs-agent-mcp/issues) 反馈。

架构与安全边界见 [MCP 架构设计](docs/MCP_ARCHITECTURE.md)。
