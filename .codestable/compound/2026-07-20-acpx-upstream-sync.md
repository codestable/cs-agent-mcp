# acpx 上游同步规约

## 背景

`cs-agent-mcp` 自带 ACP client/runtime，不把 `acpx` 作为运行时依赖。当前 Agent registry 与
`acpx@0.12.0` 对应实现一致，但 ACP client、session 和 runtime 已叠加本项目需要的 Codex/Claude
本机路径解析、Claude 设置隔离、递归 MCP 注入、持久会话 fail-closed、prompt timeout 完整性和
`cs-agent-mcp` 日志语义。后续吸收 upstream 修复时，目标是复用通用 ACP 兼容改进，而不是重新
引入 acpx CLI 产品面或覆盖本项目的 MCP 控制面。

## 结论

### 原则

1. **固定来源，不追浮动 main**：每次同步必须记录 upstream release、commit SHA、tarball integrity
   和同步日期。默认从稳定 release 开始；安全修复可以指定 commit，但仍需固定 SHA。
2. **按所有权分层，不整目录覆盖**：
   - 近似直接同步层：`src/agent-registry.ts` 中的 Agent 名称、命令、alias 和 adapter version。
   - 人工移植层：`src/acp/`、`src/runtime/`、`src/session/`、`src/spawn-command-options.ts`、
     `src/errors.ts`、`src/permissions.ts`、共享类型。每个 hunk 都要判断，不允许整文件替换。
   - 本项目所有层：`src/mcp/`、`src/mcp-cli.ts`、Broker、Facade、diagnostics/TUI、14 tools 和
     CodeStable 工件。除非另有已批准设计，upstream 同步不得修改这些契约。
3. **本地不变量优先**：必须保留 stdio 无额外输出、Facade snapshot v1、diagnostics v1、Workspace
   单 Broker/单 owner、credential 隔离、reverse channel 隔离、持久恢复 fail-closed、递归 MCP
   identity、非 completed Turn 不生成最终 Message，以及 send timeout 不伪装成任务 deadline。
4. **按语义移植，不按文本追平**：upstream CLI、queue、flow、viewer、输出格式等能力只有在 MCP
   产品需要且经过独立 feature 设计时才引入；不能为了 diff 变小复制无关产品面。
5. **测试决定支持声明**：registry 映射测试、mock ACP integration、真实 initialize probe 和真实任务
   E2E 必须分开记录。README 只能声明本仓库实际达到的保证，不用 upstream 的测试替代本仓库证据。
6. **不自动升级公开契约**：ACP SDK major、持久化 schema、权限模型、错误码、Agent 默认命令或 adapter
   major 变化必须进入 design review；不能夹在普通同步 commit 中静默发布。

### 同步流程

1. **建立基线**
   - 确认工作树干净，记录当前 `HEAD`、包版本、测试数和已发布版本。
   - 记录上次同步的 upstream release/SHA；没有记录时，以当前代码和已知 release 做一次反向对比。
   - 在临时目录获取目标 upstream tag/tarball，不把 upstream checkout 放进仓库。
2. **生成差异清单**
   - 先比较 registry、ACP command compatibility、client、session、runtime、spawn/auth/permission。
   - 每个 upstream hunk 标为 `accept-verbatim`、`adapt`、`reject-out-of-scope` 或
     `already-local/superset`，并写明理由和对应本地测试。
   - 发现 upstream 变更要求修改 `src/mcp/` 或公开契约时，停止普通同步，转 feature/design review。
3. **先移植测试，再移植实现**
   - 将相关 upstream regression test 改写到本仓库测试结构，先证明旧代码失败。
   - 测试不得依赖 upstream 包在运行时存在；需要 adapter 时固定版本，关键场景优先使用 tarball 或
     本机真实 CLI，mock 只用于协议边界和错误时序。
4. **按低层到高层实现**
   - 顺序为 registry/types -> spawn/auth/terminal -> ACP client -> session/persistence -> runtime。
   - 每层完成后跑定向测试。只有底层契约无法承载新行为时才修改 MCP adapter/Facade，并另行说明
     public contract 是否变化。
   - 对人工移植文件保留本地增强；特别核对 `agent-command.ts`、`client.ts`、runtime manager 和
     prompt-turn timeout 路径，避免把已修复问题重新带回。
5. **验证矩阵**
   - 运行移植的 upstream regression tests 和本仓库相关定向测试。
   - 运行 `pnpm run check`。
   - 运行 `npm_config_cache=/tmp/cs-agent-mcp-npm-cache pnpm run package:smoke:tarball`，验证临时安装、
     14 tools、wait-many、生命周期和 diagnostics。
   - Codex、Claude 各执行一次真实创建、发送、等待和销毁。
   - registry 或某个通用 Agent 发生变化时，对受影响 Agent 至少执行真实 initialize probe；具备本机
     CLI 和登录状态时再执行一次 oneshot prompt。缺少实机条件必须记录为 residual risk，不能写成已验证。
   - 会话、取消、权限或进程生命周期变化时，补真实多进程/SIGKILL/恢复测试，不用纯 mock 代替。
6. **独立审查与验收**
   - 独立 reviewer 检查 upstream hunk 决策、本地不变量和遗漏的兼容修复。
   - 独立 functional acceptance 按受影响 Agent 和 MCP workflow 验收，修复 blocking/important 后重跑。
   - 审查不能只看“与 upstream 一致”，必须证明“在本仓库控制面中仍正确”。
7. **记录与发布**
   - 保存 upstream release/SHA、tarball integrity、hunk 决策、改动文件、测试证据、实机覆盖和遗留风险。
   - Agent 名称、命令、adapter version 或用户可见行为变化时同步 README 和 CHANGELOG。
   - 公开契约不变的兼容修复通常发 patch；新增 Agent/能力或契约变化按 semver 评估 minor/major。
   - commit、push、tag、npm publish 仍须 owner 明确授权。

### 严格停止条件

出现以下任一情况，不继续做“机械同步”：upstream 要求依赖 `acpx` 包或其 CLI；需要替换 Facade
snapshot/diagnostics schema；改变 14 tools、错误码、权限默认值或 Workspace owner 模型；无法同时
保留本地安全不变量和 upstream 行为；真实 adapter 行为与 upstream 文档冲突。此时先形成 feature 或
ADR，明确迁移和兼容策略后再实现。

## 证据

- 仓库约束：`AGENTS.md` 明确不依赖 npm 包 `acpx`，公开工具、状态和持久化 schema 需保持兼容。
- Agent 映射：`src/agent-registry.ts`。
- 通用 ACP 启动和兼容分支：`src/acp/client.ts`、`src/acp/agent-command.ts`。
- 会话与 runtime：`src/session/`、`src/runtime/`。
- 本项目控制面：`src/mcp/`。
- 常用取证与验证命令：

```bash
npm view acpx version repository.url dist.tarball --json
npm pack acpx@<version> --pack-destination /tmp/acpx-sync
git diff --no-index <upstream-file> <local-file>
pnpm run check
npm_config_cache=/tmp/cs-agent-mcp-npm-cache pnpm run package:smoke:tarball
cs-agent-mcp agents list --json
```
