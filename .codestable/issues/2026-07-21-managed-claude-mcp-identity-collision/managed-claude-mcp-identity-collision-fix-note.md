---
doc_type: issue-fix
issue: 2026-07-21-managed-claude-mcp-identity-collision
path: standard
fix_date: 2026-07-21
related:
  - managed-claude-mcp-identity-collision-analysis.md
tags:
  - mcp
  - claude
  - identity
---

# 受管 Claude MCP 身份入口冲突修复记录

## 1. 实际采用方案

采用 analysis 中已确认的方案 C：Workspace Facade 启动时防御性读取 Claude 用户配置顶层
`mcpServers`，只提取直接或通过 `npx`、`npm exec`、`pnpm dlx` 启动 `cs-agent-mcp` 的 server
名称。直接路径识别覆盖 Windows `.cmd/.bat/.exe/.ps1` shim；package-exec 识别覆盖 positional
package、`--package/-p/--package=`、subcommand 前全局 option、`--flag=value` 和常见带独立值
option。确认 `npm exec` / `pnpm dlx` 子命令后，只判断精确 `cs-agent-mcp[@version]` launch target。
npm、npx 与 pnpm 分别使用 subcommand 前/后的 option policy，区分带值和无值 option；`--key=value`
作为自包含 option 跳过，未知独立 option 则 fail-open，不猜测 arity。子命令之后只取第一个 target，
或取 `--` 后的首个 command。因此 pnpm `-w`、`-C/--dir/--store-dir`、`dlx -c` 以及 npm
`--loglevel` 等形式不会漏判，`npm run exec`、`pnpm run dlx`、未知 option value 和 `other-mcp`
后续参数也不会误覆盖无关 MCP。创建或恢复受管 Claude 时，为固定 `cs-agent-mcp` 和这些冲突名称
最后注入相同 loopback URL 与当前 Agent bearer；Claude ACP 按名称归并时由后项安全覆盖用户级 root
入口。

是否为 Claude 不依赖显示名，而是从 Agent registry 解析实际 ACP command 后使用现有
`isClaudeAcpCommand` 判断，因此自定义 Agent 名下的 Claude ACP 也受保护。Codex 和其他 runtime
仍只获得固定的 `cs-agent-mcp` 入口，不扩散 Claude 用户别名。

解析失败、配置缺失、HTTP server、无关 MCP、未知 wrapper 和 malformed entry 均忽略，不阻止 Agent
启动。实现不修改、不复制、不持久化 Claude 用户配置；`isolateClaudeUserSettings` 继续为 false，
所以其他 settings、skills、hooks、plugins 和无关 MCP 保持原行为。

## 2. 改动文件清单

- `src/mcp/transport/claude-user-mcp.ts`：新增冲突别名解析、读取和身份 MCP 列表组装。
- `src/mcp/transport/workspace-facade.ts`：Workspace 启动时读取一次别名，并按实际 ACP command 只为
  Claude 注入安全覆盖项。
- `src/mcp/facade/facade.ts`：内部 `mcpServersForToken` 工厂增加 Agent 名参数，创建、恢复和 discard
  恢复路径保持同一组装语义。
- `test/mcp-broker.test.ts`：覆盖直接/path/Windows `.cmd/.ps1` 命令、三种 package-exec、显式
  package option、subcommand 前 flag、pnpm 工作目录/Workspace root/shell-mode option、未知 option
  fail-open、普通 script/参数 false positive、HTTP/无关/未知 wrapper、missing/malformed 配置、别名
  去重、后项覆盖顺序、其他 MCP 保留和非 Claude 隔离。
- `README.md`：说明受管 Claude 的安全覆盖行为及用户设置保留边界。
- `CHANGELOG.md`：在未发布区记录递归身份修复。
- 本 issue 的 report、analysis 和 fix-note：保存问题、根因、方案与验收证据。

没有修改 14 tools、MCP 输入输出、Facade snapshot v1、diagnostics v1、权限状态机、Workspace owner
模型或版本号。

## 3. 验证结果

### TDD 与静态验证

- RED：新增测试最初因 `claude-user-mcp.ts` 不存在而编译失败。
- GREEN：解析与组装 3/3；Broker + Facade 定向回归 58/58。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run check:docs` 通过。
- 本机实际 Claude ACP `0.37.0` 代码核对：session `mcpServers` 数组按顺序写入 name map，后项覆盖
  前项；session map 再覆盖 user options map，证明最后注入的 bearer alias 是最终入口。

### 完整门禁与安装态 smoke

- `pnpm run check`：280/280 通过，0 skipped；format、docs、typecheck、lint、build、测试和
  `npm pack --dry-run` 全部通过。
- `npm_config_cache=/tmp/cs-agent-mcp-npm-cache pnpm run package:smoke:tarball`：临时安装态
  `toolCount:14`，`waitMany/lifecycle/diagnostics:ok`。
- 当前工作树 `0.2.5` tarball 已覆盖安装到本机全局；安装包 bundle 中确认包含
  `claudeControlPlaneAliases` 和 `includeClaudeAliases`。未发布 npm、未改版本。
- 最终 tarball npm shasum 为 `055926777b666e092814663559e0677c0a1b55c5`，SHA-256 为
  `06919603d4a34f9f3d0e7829bc4e2bd4dcbf455831da49bdad8e4219ce446134`；安装后
  `cs-agent-mcp --version` 返回 `0.2.5`。

### 真实 Claude 递归 E2E

在隔离 HOME 中复用本机 Claude/Codex 登录和真实 Claude 用户设置，使用全局安装 tarball 启动全新
Broker。给真实 Claude A 的提示只写“使用 cs-agent MCP”，未限定 server namespace：

- A：`7fa1d916-0a55-421b-a8c3-10e0bfb22c5d`。
- 真实 Codex B：`4137e0dc-3b48-4192-bae2-528ab6362711`，
  `parentAgentId=A`、`depth=2`，完成并回复 `CHILD_OK`。
- 确定性权限子 Agent：`1dfdaf34-30ea-4e50-840a-060fe2814347`，
  `parentAgentId=A`、`depth=2`。
- permission：`63294db0-c1c4-4e4a-98c6-dc16a2e3c478`，最终
  `permission.resolved.actorAgentId=A`、`outcome=allow_once`，子 Agent 回复
  `permission selected:allow`。
- E2E 最后级联销毁 A 和两个后代、discard session、关闭客户端并删除隔离 HOME；随后
  `cs-agent-mcp agents list --json` 返回空 agents。

复现路径不再产生 root sibling，Agent 树所有权与权限 actor 均符合 report 第 3 节期望。

### 独立 Review Round 1

- 通过当前全局 tarball 的 CS Agent MCP 并行创建 Codex 与 Claude reviewer。第一次宽审查因 stdio
  Workspace 在 5 分钟时关闭而取消，没有把部分输出当结论；Round 2 使用限时窄范围 prompt 得到两份
  完整 `CHANGES_REQUESTED`。
- Codex reviewer 指出 `--package/-p/--package=`、subcommand 前全局 flag 和其他前置 option 会造成
  package-exec false negative。新增 RED 后扩展解析器，定向 3/3 与 lint 转绿。
- Claude reviewer 指出 project/local scope 的冲突 MCP 仍可能重现 sibling。owner 的已确认目标与
  analysis 仅覆盖 user scope，因此未扩大实现；README 和本节遗留事项明确该安全边界。
- Round 3 Claude reviewer 判定 PASS；Codex reviewer 继续指出 pnpm `-C/--dir` 分离值 option 和
  Windows `.ps1` 直接 shim 漏判。两项均先补 RED，再扩充 option 表与 shim 后缀识别，定向测试与 lint
  转绿。
- Round 4 Codex reviewer 证明有限 option 表仍会漏掉 `pnpm --store-dir <path>`、
  `npm --loglevel <level>` 等合法形式。新增 RED 后移除 option arity 白名单，改为子命令定位加精确
  package token 检测；`--store-dir`、`--loglevel`、`-C`、`--dir`、`.ps1` 和既有 happy path 全部转绿。
- Round 5 Codex reviewer 反向证明扫描子命令后所有精确 token 会把 `other-mcp` 的普通参数误判成启动
  目标。新增 npx/npm/pnpm 三个 false-positive RED 后引入 `launchTarget`，只判断第一个 package/binary
  或 `--` 后首个 command；三条无关 MCP 反例与全部阳性路径共同转绿。
- Round 6 Codex reviewer 提出任意 npm config option 以子命令后独立值形式出现仍可能漏判，例如
  `npm exec --https-proxy <url> cs-agent-mcp`。该形态不在 analysis 已批准的 package-exec 支持集合；
  泛化猜测未知 option arity 会重新引入 Round 5 已证明的无关 MCP 误覆盖。处置为 residual：额外全局
  option 使用已识别形式或 `--key=value`；实现保持只覆盖可确定 launch target。
- 最终独立 reviewer 指出 `indexOf("exec"/"dlx")` 会把 `npm run exec -- cs-agent-mcp` 与
  `pnpm run dlx -- cs-agent-mcp` 中的脚本名误认成 package-exec 子命令。新增两个 false-positive RED
  后，子命令解析改为只接受前置 option 之后遇到的第一个 positional token；若先遇到 `run`、
  `config` 等其他子命令则立即 fail-open，不再向后搜索。两个反例与既有 package-exec 阳性路径均转绿。
- review-fix Round 2 发现共用 arity 表把 pnpm 的无值 `-w` 与 `dlx -c` 当成带值 option，并可能把未知
  option 的值误认成 target。新增 `pnpm -w dlx`、`pnpm dlx -c` 阳性 RED，以及 `npm exec --tag
cs-agent-mcp other-mcp` 和未知 option false-positive RED；解析器随后改为 npm/npx/pnpm 与
  subcommand 前后分开的 option policy。所有反例、既有 package-exec 阳性和 lint 已转绿。
- 最终 tarball 覆盖安装后，在隔离 HOME 和全新机器级 Broker 中通过 MCP 同时创建真实 Codex
  `0d1cb2f0-de3c-4e68-9404-c806dc8369df` 与 Claude
  `53f5fc8f-a07f-479f-a09e-abca96bda95b` 做有界审计；两者均判 `SPEC PASS / CODE PASS`，无 blocking
  或实现范围内 important。最终 OCR 行级复扫 0 finding。
- 同一最终安装包的未限定 namespace 递归验收中，真实 Claude A
  `7f97f6c7-576b-435a-8463-2c12fd6b629e` 创建 Codex B
  `9e155d7f-5e44-4a22-b32c-e3df2888b7a0`；B 的 `parentAgentId=A`、`depth=2`，父回复同时包含
  `FINAL_PARENT_OK` 与子结果 `FINAL_CHILD_OK`。验收后已级联销毁测试树并删除隔离 HOME。

## 4. 遗留事项

- 未知 shell/custom wrapper 无法可靠判断是否最终启动 `cs-agent-mcp`，继续 fail-open；用户仍可改用
  直接命令或支持的 package-exec 形式获得覆盖。
- Claude 用户 MCP 配置在 Workspace Facade 生命周期内只读取一次，修改后需让对应 Workspace 控制面
  完整退出并重启。
- 自动覆盖只读取 `~/.claude.json` 顶层 user-scope `mcpServers`。项目 `.mcp.json` 以及 Claude
  local/project scope 的冲突控制面不在本 issue 范围，用户应避免在这些 scope 注册
  `cs-agent-mcp` root 入口。
- 修复只阻止新错误委派，不迁移历史上已经持久化为 sibling 的 Agent。
- Windows 路径和 `.cmd/.bat/.exe/.ps1` 由单元测试覆盖，本轮未在 Windows 实机运行真实 Claude E2E。
- npx/npm/pnpm 的常见 package-exec 形式已覆盖；未知 wrapper，或使用独立值的未识别
  package-manager option 继续 fail-open。使用已识别 option、`--key=value` 或直接命令可被当前解析器
  稳定识别。
