# AGENTS.md

本仓库发布 npm 包 `cs-agent-mcp`，提供本地多 Agent stdio MCP 服务。

## 范围

- 面向用户的唯一命令是 `cs-agent-mcp`。
- 无参数时必须直接启动 stdio MCP，不增加交互式输出。
- Codex、Claude 等受管 Agent 通过 ACP adapter 启动。
- 不依赖 npm 包 `acpx`；当前仓库自带所需 ACP runtime 和 MCP Facade 实现。
- 用户文档统一使用中文，只描述安装、配置、启动和 MCP 能力。

## 环境

- Node.js `>=22.13.0`
- pnpm `10.33.2`

```bash
pnpm install
```

## 开发

从源码启动：

```bash
pnpm run dev -- --cwd /absolute/path/to/workspace
```

构建并检查命令：

```bash
pnpm run build
node dist/mcp-cli.js --help
```

关键实现：

- `src/mcp-cli.ts`：npm binary 与 stdio MCP 入口。
- `src/mcp/transport/`：stdio/loopback HTTP transport、workspace roots 和进程锁。
- `src/mcp/facade/`：Agent、Turn、Message、Permission、Event 和递归委派状态机。
- `src/mcp/runtime-adapter.ts`：Facade 到 ACP runtime 的适配。
- `src/runtime/`、`src/acp/`：ACP 会话、Agent 进程、恢复和权限处理。
- `test/mcp-cli.test.ts`、`test/mcp-e2e.test.ts`：公开入口和 13 个工具的 E2E。

## 验证

修改代码、配置、CLI、状态格式或文档后运行：

```bash
pnpm run check
```

发布前还要用 `npm pack` 生成的 tarball 做临时全局安装，并通过 MCP SDK 验证 13 个工具。
涉及 Codex/Claude 启动时，应在本机登录状态下各跑一次真实调用；涉及递归委派时，至少验证
Claude 创建 Codex 子 Agent 或反向等价链路。

## 持久化与兼容性

- 用户配置：`~/.cs-agent-mcp/config.json`
- 项目配置：`<cwd>/.cs-agent-mcprc.json`
- MCP 与会话状态：`~/.cs-agent-mcp/`
- Facade snapshot schema：`cs-agent-mcp.facade.v1`

工具名、输入字段、结构化输出、错误码、状态枚举和持久化 schema 都属于公开契约。修改时必须
同步 README、回归测试和 CHANGELOG，不能静默替换无法恢复的持久会话。

## 发布

版本来自 `package.json`。tag 必须为完全匹配的 `vX.Y.Z`，且 tagged commit 已位于 `main`。
GitHub Actions 使用 npm trusted publishing 发布 `cs-agent-mcp`；不得把 npm token 写入仓库。
