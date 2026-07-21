---
doc_type: issue-analysis
issue: 2026-07-21-managed-claude-mcp-identity-collision
status: confirmed
root_cause_type: config
related:
  - managed-claude-mcp-identity-collision-report.md
tags:
  - mcp
  - claude
  - identity
---

# 受管 Claude MCP 身份入口冲突根因分析

## 1. 问题定位

| 关键位置                                                       | 说明                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/mcp/transport/workspace-facade.ts:91`                     | Workspace runtime 设置 `isolateClaudeUserSettings: false`，受管 Claude 保留 user/project/local 设置 |
| `src/mcp/transport/workspace-facade.ts:120`                    | 每个 managed identity 只注入固定名称 `cs-agent-mcp` 的 bearer loopback MCP                          |
| `src/acp/client.ts:934`                                        | ACP `session/new` 同时传入注入 MCP servers 和 Claude metadata                                       |
| `src/acp/agent-command.ts:303`                                 | 未隔离用户设置时不限制 `settingSources`，由 Claude adapter 使用默认 user/project/local              |
| `@agentclientprotocol/claude-agent-acp@0.37.0` session options | adapter 将用户设置中的 MCP 与 ACP `mcpServers` 合并，ACP session 项仅按同名 key 覆盖                |

## 2. 失败路径还原

**正常路径**：Facade 为 A 签发 bearer token → session 注入名为 `cs-agent-mcp` 的 loopback MCP →
A 调用该入口 → HTTP 层把 token 还原为 A actor → A 创建的 B 记录 `parentAgentId=A` → B 权限由 A
或其祖先处理。

**失败路径**：Claude 用户设置已有名为 `cs-agent`、命令为 `cs-agent-mcp` 的 stdio MCP → 受管 A
继续加载 user settings → 注入入口名为 `cs-agent-mcp`，与用户入口不同名，二者都保留 → A 在相同
工具描述中选择 `mcp__cs-agent__*` → 该 stdio 入口以 Workspace root 初始化 → B 记录
`parentAgentId=root`，成为 A 的 sibling。

**分叉点**：`src/mcp/transport/workspace-facade.ts:120` — 注入逻辑只提供一个固定安全名称，没有用
同一 bearer loopback 覆盖用户设置中指向本产品的其他 MCP 名称。

## 3. 根因

**根因类型**：配置边界缺少防御。

**根因描述**：产品同时承诺“保留 Claude 用户设置”和“managed Agent 只能通过身份受限 loopback
递归委派”，但 session 组装只保证固定名称 `cs-agent-mcp` 安全。Claude 的 MCP merge 以名称为
key；用户按 README 将同一命令注册为 `cs-agent` 时不会发生覆盖。两个入口提供相似工具，模型选择
成为身份安全边界，导致 root/managed actor 混淆。

**是否有多个根因**：有。主因是未对用户级控制面别名做同名安全覆盖；次因是 server instructions
和工具描述无法向模型可靠区分两个功能相同但身份不同的入口。次因可以改善可用性，但不能替代
结构性覆盖。

## 4. 影响面

- **影响范围**：所有保留用户设置、且用户级 Claude MCP 已注册 `cs-agent-mcp` 的受管 Claude；自定义
  注册名称同样可能触发。
- **潜在受害模块**：Agent 树所有权、子树可见性、权限处理 actor、级联取消/销毁、审计事件、深度和
  Agent 数量限制。
- **数据完整性风险**：已有错误调用会持久化为合法但层级错误的 sibling，不能事后自动重挂 parent；
  修复只阻止新错误委派，不迁移历史记录。
- **严重程度复核**：维持 P1。鉴权本身 fail-closed，但错误入口拥有 root 身份，破坏核心隔离语义。

## 5. 修复方案

### 方案 A：隔离全部 Claude 用户设置

- **做什么**：将 Workspace runtime 改回 `isolateClaudeUserSettings: true`，只加载 project/local。
- **优点**：实现简单，用户级 root MCP 不会出现。
- **缺点 / 风险**：同时丢失用户 skills、hooks、plugins、无关 MCP 和其他偏好，违反已确认产品边界。
- **影响面**：所有受管 Claude 行为，回归风险高。

### 方案 B：只用 instructions 强制 namespace

- **做什么**：在 system prompt/server instructions 中要求 managed Claude 只用
  `mcp__cs-agent-mcp__*`。
- **优点**：改动小，不碰配置。
- **缺点 / 风险**：模型仍可选错，提示词不能作为身份安全边界；第一次真实 E2E 已证明会失败。
- **影响面**：仅提示文本，但不能完成安全修复。

### 方案 C：同名覆盖冲突控制面入口

- **做什么**：只读取 Claude 用户级 MCP 名称和 stdio launch spec；识别直接或 package-exec 启动
  `cs-agent-mcp` 的条目。为每个冲突名称生成与固定 `cs-agent-mcp` 相同 URL 和 bearer header 的
  session MCP，并在传给 adapter 的列表中最后注入，利用 adapter 的同名 merge 规则覆盖用户入口。
- **优点**：保留所有其他用户设置；自定义注册名也安全；模型选择任一控制面名称都使用 A identity。
- **缺点 / 风险**：需要防御性解析 Claude 用户配置；配置在 Broker 生命周期内变化需重启后生效；
  未知 wrapper 命令无法可靠识别，需记录为 residual risk。
- **影响面**：Workspace session MCP 组装、新解析 helper、单元/E2E 测试和 README/CHANGELOG。

### 推荐方案

**推荐方案 C**。它直接消除身份分叉点，同时满足 owner 明确要求的“过滤冲突控制面 MCP、保留其他
Claude 用户设置”。实现必须只提取冲突名称，不复制或持久化用户配置内容；解析失败时不得阻止
Agent 启动。用户已明确确认该产品修复方向，可以进入 fix 阶段。
