---
doc_type: feature-implementation-evidence
feature: 2026-07-17-agent-runtime-diagnostics
status: ready-for-review
stage: implementation
---

# Agent 运行状态诊断 CLI Implementation Evidence Pack

## 动了哪些文件

本实现从基线 `23bd73868624ea843807a602ba550e1c803aa63d` 开始，S1-S5 分步提交。S5 提交
`253eb87` 涉及：

- `.codestable/requirements/agent-runtime-diagnostics.md`
- `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- `.codestable/features/2026-07-17-agent-runtime-diagnostics/goal-state.yaml`
- `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- `CHANGELOG.md`
- `README.md`
- `docs/MCP_ARCHITECTURE.md`
- `scripts/package-smoke.mjs`
- `src/mcp/diagnostics/index.ts`
- `test/agent-diagnostics.test.ts`

## 改了哪些函数 / 类型

**S1：CLI 编排骨架**

- `src/mcp-cli.ts`：新增 `agents` 子命令分发，保持无参数 stdio MCP 入口不输出交互文本。

**S2：只读诊断 read model**

- `src/mcp/diagnostics/index.ts`：新增 `createAgentDiagnostics`、snapshot 发现、selector、DTO 投影和只读
  `listAgents` / `resolveAgent` / `attachAgent` 模型。

**S3：agents list/status**

- `src/mcp-cli.ts`：接入 `agents list`、`agents status` 的文本和 JSON 输出。

**S4：agents attach**

- `src/mcp-cli.ts`：接入 `agents attach` JSONL / text timeline、signal 终止和退出码。
- `src/mcp/diagnostics/index.ts`：实现历史 baseline、cursor drain、watch/fallback、replacement terminal。

**S5：Harden 与交付**

- `src/mcp/diagnostics/index.ts`：`projectToolCall` / `sanitizeLocations` 收紧 `turn.tool_call.locations`
  allowlist；`waitForFacadeChange` 增加 debounce 窗口，并通过注入 reader/watcher/scheduler 让 parse 上界可测。
- `test/agent-diagnostics.test.ts`：新增 poison field、10,000 history cap、thought omitted、tool location
  allowlist、fake scheduler debounce parse count 覆盖。
- `scripts/package-smoke.mjs`：在原 13 个 MCP 工具生命周期 smoke 后，实际调用
  `agents --help/list/status/attach`。
- `README.md`、`CHANGELOG.md`、`docs/MCP_ARCHITECTURE.md`、requirement 文档：同步诊断 CLI、JSON schema、
  只读边界和状态。

## 方案外触碰

无。文档改动均为 design 第 3 节和 acceptance gate 要求的 README、CHANGELOG、MCP architecture、
requirement 同步；测试和 package smoke 属于 S5 交付范围。

## 新概念 / 抽象

无方案外概念。新增的 reader/watcher/scheduler 注入只服务于 design 已要求的 C17 counting reader +
fake clock/scheduler 测试，不改变公开 CLI、MCP 工具或持久化 schema。

## 第一性原则 pre-pass 核对

- 外部行为：新增唯一公共入口 `cs-agent-mcp agents list|status|attach`；无参数 `cs-agent-mcp` 继续直接启动
  stdio MCP。
- 不可破约束：不改变 `cs-agent-mcp.facade.v1`、13 个 `cs_agent_*` 工具、loopback actor 边界或 mutation
  行为。
- 最小充分改动：诊断路径只读 snapshot/lock probe，不调用 runtime、identity、permission response、cancel、
  send、destroy 或 lock acquire/remove。
- 必须不写：不暴露 thought/raw tool payload/permission request 原文；不承诺内存 runtime、Agent PID
  归属、远程或多用户诊断。

## 代码质量反射检查

- 诊断 read model 放在 `src/mcp/diagnostics/index.ts`，没有把只读 CLI 逻辑塞进 Facade mutation 层。
- S5 的可测试性注入为私有 options，不成为公开 CLI/API 契约。
- `turn.tool_call.locations` 用字段级 allowlist 处理，不透传整段 runtime payload。

## Step 证据

- S0：`pnpm run check` 通过 198/198；`max-turns-exceeded` issue 和 approved design 已独立提交。
- S1：RED 为新增 CLI help 断言先失败；GREEN 为 `mcp-cli.test` 10/10；VERIFY 为 build 和 help 命令通过。
- S2：RED 为诊断模块不存在；GREEN 为 agent diagnostics 2/2；VERIFY 为 format/lint/test 201/201。
- S3：RED 为 list/status 新断言失败；GREEN 为 `mcp-cli.test` 12/12；VERIFY 为 test 203/203。
- S4：RED 为 attach replacement drain 失败；GREEN 为 diagnostics + CLI 18/18；VERIFY 为 test 207/207。
- S5：RED 为 hardening 测试先覆盖未实现的 tool location allowlist 与 debounce/read count；GREEN 为
  `node --test dist-test/test/agent-diagnostics.test.js` 5/5；VERIFY 为 CLI 15/15、完整 check 和 package smoke。

## TDD 证据

- S1-S5 均按行为测试先行或失败先行推进；S5 的新增 RED/GREEN 核心是：
  - poison fields 与 thought text 不应出现在 `attach --json` 投影。
  - 10,000 事件 fixture 中 `--history` 只输出最后窗口，cursor 顺序稳定。
  - `turn.tool_call.locations` 只保留 `path/line/column/startLine/startColumn/endLine/endColumn`。
  - fake scheduler burst watcher 在一个 debounce 窗口内只触发一次 snapshot read/parse。

## 基线预检与清洁度

- 基线隔离：S0 已记录 `0f2ee7a,23bd738`。
- 清洁度：S1-S5 每步验证均检查无新增调试输出、临时 TODO/FIXME/XXX、注释旧代码或无用 import。
- `pnpm run lint` 当前通过，覆盖无用 import 和复杂度阈值。

## 实际交付物索引

- CLI：`cs-agent-mcp agents list|status|attach`。
- JSON schema：诊断输出使用 `cs-agent-mcp.diagnostics.v1`，不改变 Facade snapshot schema。
- Runtime 安全：只读 snapshot 发现、selector fail-closed、attach cursor drain、debounce watch/fallback。
- 文档：README 使用方式、CHANGELOG 条目、MCP architecture 的 diagnostics/read-only 边界、requirement 状态。
- Smoke：`scripts/package-smoke.mjs` 同时验证 13 MCP 工具生命周期和 agents 子命令。

## 知识回写候选

- 本机 `~/.npm` cache 存在 root-owned 文件时，`npm pack --dry-run` 会在 pack:check 阶段报 EPERM；可用
  `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run check` 保持仓库验证可复现。

## 最后一轮本地审计

- `pnpm run format:check`：通过。
- `pnpm run typecheck`：通过。
- `pnpm run lint`：通过。
- `pnpm run build:test`：通过。
- `node --test dist-test/test/agent-diagnostics.test.js`：5/5 通过。
- `node --test dist-test/test/mcp-cli.test.js`：15/15 通过。
- `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run check`：通过，209/209 tests passed，pack dry-run 输出
  `cs-agent-mcp-0.1.1.tgz`。
- `CS_AGENT_MCP_BIN=/Users/wyattfang/work/cs-agent-mcp/dist/mcp-cli.js CS_AGENT_MCP_MOCK_AGENT=/Users/wyattfang/work/cs-agent-mcp/dist-test/test/mock-agent.js node scripts/package-smoke.mjs`：
  输出 `{"toolCount":13,"lifecycle":"ok","diagnostics":"ok"}`。
- 精确 `pnpm run check` 曾在最后 `npm pack --dry-run` 因本机 root-owned `~/.npm` cache 报 EPERM；前置
  format/docs/typecheck/lint/build/test 已通过，使用 `/tmp` cache 复跑完整链路通过。

## 推进顺序退出信号核对

- S0：done，基线隔离完成。
- S1：done，CLI 骨架与无参数 stdio 回归完成。
- S2：done，只读状态节点与 DTO 完成。
- S3：done，`agents list/status` 完成。
- S4：done，`agents attach` 跟随、terminal 和 permission read-only 测试完成。
- S5：done，hardening、文档、package smoke 和完整检查完成。

## Review-fix Round 1

- Review input：`agent-runtime-diagnostics-review.md` round 1，结论为 `changes-requested`。
- 修复范围：REV-001 至 REV-005；未改变公开 CLI、13 个 MCP 工具、Facade schema 或只读边界。
- RED：新增 nested Event 损坏、同 generation stopped 最终 drain、250ms/stat gate + watcher error、
  顶层截断信号用例后，定向测试 4/8 失败，分别命中四类审查缺口。
- GREEN：Event required fields/type 逐项校验；目标 snapshot signature + lock state gate；最小 250ms
  wake 间隔；stop/replacement 最终二次 drain；watch error 走同一 debounce；顶层截断信号继承正文截断。
- VERIFY：`pnpm run build:test && node --test dist-test/test/agent-diagnostics.test.js` 8/8；
  `pnpm run typecheck`、`pnpm run lint`、CLI integration 通过；`pnpm run test` 退出 0；使用独立 npm cache
  的完整 check 链路通过，`pnpm run pack:check` 退出 0 并生成 dry-run tarball 清单。
- 清洁度：`pnpm run format:check`、`git diff --check` 通过；移除 terminal exit code 死赋值及其孤儿 helper，
  无新增 debug output、TODO/FIXME/XXX、注释旧代码或无用 import。

## Review-fix Round 2

- Review input：`agent-runtime-diagnostics-review.md` round 2，结论为 `changes-requested`。
- 修复范围：REV-008 至 REV-011；未改变公开 CLI、13 个 MCP 工具、Facade schema 或只读边界。
- RED：定向测试 3/8 失败，分别证明 replacement 仍输出新 generation event、损坏 Agent/Turn optional
  nested 字段未 fail-closed、allowlisted error/text/title 保留 2,001 code points。
- GREEN：follow 把 snapshot/liveness/replacement observation 分流；任何阶段观察到新 token 都直接输出
  `instance_replaced` 且不 drain 该 snapshot；stopped/unknown 保留最终 drain。Agent/Turn consumed optional
  字段与 error shape 增加 L3 校验；明确文本字段和 diagnostics error message 统一截断并传播
  `truncated=true`；package smoke 等待 child `close` 并在失败时展示 stderr。
- VERIFY：diagnostics 8/8；type-aware lint、format、docs、typecheck、build、全量 test、独立 npm cache 下
  pack dry-run 均通过；完整 `pnpm run check` 退出 0；package smoke 输出
  `{"toolCount":13,"lifecycle":"ok","diagnostics":"ok"}`。
- TDD exception：package smoke `exit`→`close` 为测试基础设施时序修正，使用 OCR 可复现的 Node child
  stdio 生命周期事实和实际 package smoke 作为替代证据。
- 清洁度：删除 replacement 旧断言留下的未使用 helper；复杂度通过等价小函数提取回到 lint 阈值内；
  无新增 debug output、TODO/FIXME/XXX、注释旧代码或无用 import。

## Review-fix Round 3

- Review input：`agent-runtime-diagnostics-review.md` round 3，结论为 `changes-requested`。
- 修复范围：REV-017 与同一文本边界 REV-018；只改 diagnostics event 投影和测试 fixture。
- RED：把 `turn.failed` fixture 改为 Facade 真实的 `{stopReason,error:{...}}`、cancelled 改为
  `{reason}` 并加入超长 tag 后，定向测试因 2,001 code points 与缺失嵌套 error/reason 失败。
- GREEN：新增 terminal-turn projector，顶层只读取 `stopReason/reason`，嵌套 error 只读取
  `code/message/retryable/runtimeCode`；`stack` 等未知字段不透传；`tag/stopReason/reason` 纳入统一文本
  截断和 summary 聚合。
- VERIFY：diagnostics 8/8；完整 `pnpm run check` 退出 0；package smoke 输出
  `{"toolCount":13,"lifecycle":"ok","diagnostics":"ok"}`。
- 清洁度：format、type-aware lint、typecheck、全量 test 与 pack dry-run 均通过，无方案外文件或临时痕迹。

## 验收场景自检

- 无参数 stdio 和 13 MCP 工具生命周期：`mcp-cli.test`、`mcp-e2e.test`、package smoke 覆盖。
- list/status selector、损坏 snapshot、隐藏候选：`agent-diagnostics.test.ts` 与 `mcp-cli.test.ts` 覆盖。
- attach history/cursor/drain/replacement/Ctrl-C/permission read-only：`agent-diagnostics.test.ts` 与
  `mcp-cli.test.ts` 覆盖。
- poison allowlist、thought omitted、tool raw payload 不泄漏：S5 hardening test 覆盖。
- 10,000 events history cap、cursor order、debounce parse 上界：S5 hardening + fake scheduler test 覆盖。
- README/CHANGELOG/MCP architecture/requirement 同步：文档 lint 与 diff review 覆盖。
