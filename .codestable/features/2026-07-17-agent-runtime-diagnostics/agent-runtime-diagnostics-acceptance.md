---
doc_type: feature-acceptance
feature: 2026-07-17-agent-runtime-diagnostics
status: passed
accepted: 2026-07-18
round: 1
---

# Agent 运行状态诊断 CLI 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-18
> 关联方案 doc：`.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`

## 1. 接口契约核对

对照方案第 2.1 节逐项核查：

- [x] `ObservedFacadeInstance`、`AgentDiagnosticSummary`、`AgentDiagnosticDetail` 与
      `DiagnosticTimelineItem` 均由 `src/mcp/diagnostics/index.ts` 的稳定 DTO 表达；JSON schema 为
      `cs-agent-mcp.diagnostics.v1`，原始 snapshot、identity 和 event data 不进入 renderer。
- [x] `DiagnosticTurn` 只保留 allowlist 字段；terminal event 按真实 Facade shape 读取
      `{stopReason,error}` / `{reason}`，`runtimeCode` 仅从 `error.details.runtimeCode` 单字段提取。
- [x] 公开命令示例均可达：`agents list [--all] [--json]`、
      `agents status <agent-selector> [--json]`、
      `agents attach <agent-selector> [--history <count>] [--json]`。
- [x] list/status 输出单个 JSON 文档，attach 输出 snapshot/event/terminal JSONL；完整 ID、cursor、
      warning 与非零错误语义和方案一致。
- [x] selector 在全部可读实例上解析；完整 UUID 精确匹配、隐藏候选歧义、损坏 snapshot 下前缀
      fail-closed 均有集成测试。
- [x] 流程图节点有实际落点：Commander `createAgentsCommand` → `createAgentDiagnostics` →
      `readInstances` / `resolveAgent` / `attachAgent` → watcher/stat/lock probe → terminal。

接口实现没有未处理偏差。验收期间校正了 design 的内部 seam 描述：L3 snapshot parser 最终由
AgentDiagnostics 自己持有，writable facade store 保持不变；这是实现边界澄清，不改变公开契约。

## 2. 行为与决策核对

### 需求与明确不做

- [x] 本机操作者可跨 workspace 列出 Agent、查看 Turn/权限/错误，并只读跟随事件。
- [x] 诊断数据来自持久化 snapshot 与 lock probe，不连接 loopback HTTP，也不持有 actor token。
- [x] 默认 list 过滤与 selector 全集解析解耦；`--all`、空结果、损坏实例 warning 行为符合方案。
- [x] 诊断路径没有 Facade mutation、runtime create/start、identity 签发、lock acquire/remove 调用。
- [x] 没有新增配置 key、MCP 工具、网络 endpoint、后台任务或 `cs-agent-mcp.facade.v1` 字段。
- [x] 无参数入口仍直接启动 stdio MCP；13 工具、`--cwd`、`--version`、`--help` 语义未变。
- [x] 不承诺内存 runtime 使用量、底层 Agent PID、远程、多用户或跨主机诊断。

### 关键决策与编排

- [x] snapshot 原子整体读取，nested consumed fields 做 L3 fail-closed 校验，未知字段兼容但不透传。
- [x] attach 先输出 snapshot 与有限历史，以初始最大 cursor 建 baseline；按 cursor 去重排序，idle 不退出。
- [x] watcher 监听目录并有 1s fallback；目标 snapshot stat signature 与 lock state gate 吸收无关唤醒，
      最小重读间隔为 250ms。
- [x] stopped/unknown 做最终 drain；generation token 变化直接输出 `instance_replaced`，不读取或输出
      可能属于新代的事件。design 第 1/2/3 节已同步消除原先“更替也 drain”的歧义。
- [x] allowlist mapper 不 spread 原始对象；thought/rawInput/rawOutput/content/stack/cause/details 等 poison
      默认丢弃，允许文本最多 2,000 Unicode code points 并传播 `truncated=true`。
- [x] `Ctrl-C`、destroyed、stopped、unknown、replaced 的 terminal 与退出码均符合最终契约。

### 挂载点反向核对

- [x] 公开挂载：`src/mcp-cli.ts` 的 Commander 命令树只新增 `agents list|status|attach`。
- [x] 内部挂载：`src/mcp/diagnostics/index.ts` 是唯一诊断深模块；
      `src/mcp/transport/process-lock.ts` 只新增无清理副作用的只读 probe。
- [x] 验证挂载：`package.json` 和 `tsconfig.test.json` 注册 `agent-diagnostics.test.ts`；
      `scripts/package-smoke.mjs` 覆盖安装产物。
- [x] 文档挂载：README、CHANGELOG、`docs/MCP_ARCHITECTURE.md` 已同步命令、输出披露与只读边界。
- [x] 反向 grep 与 `23bd738..HEAD` 文件清单没有发现清单外的代码、配置、schema、路由或后台挂载。
- [x] 拔除沙盘：移除 Commander 子命令、diagnostics 模块、lock probe、测试/pack 注册和三份文档段落后，
      默认 stdio MCP 与 facade schema 不留功能依赖；无迁移或持久化残留。

## 3. 验收场景核对

| 场景                                             | 可观察证据                                  | 结果 |
| ------------------------------------------------ | ------------------------------------------- | ---- |
| 1. 无参数 stdio 与 13 工具                       | 本轮 `pnpm run check` 的 MCP E2E            | 通过 |
| 2. 精确 snapshot 发现与 nested 校验              | diagnostics 定向测试                        | 通过 |
| 3. 多实例 list、过滤、排序与 `--all`             | diagnostics + CLI 集成测试                  | 通过 |
| 4. status selector 全集与 fail-closed            | CLI 集成测试                                | 通过 |
| 5. 损坏 snapshot warning / 全损坏失败            | diagnostics + CLI 集成测试                  | 通过 |
| 6. attach 历史、cursor、watcher 与去重           | diagnostics + CLI 集成测试                  | 通过 |
| 7. destroyed/stopped/unknown/idle 终态           | diagnostics + CLI 集成测试                  | 通过 |
| 8. stopped final drain、replacement 隔离、Ctrl-C | generation/drain/Ctrl-C 测试                | 通过 |
| 9. JSON/JSONL allowlist 与文本截断               | poison/runtimeCode/truncation 测试          | 通过 |
| 10. 零写入与 Node permission live attach         | 本轮 permission 子进程测试；QA 四能力 probe | 通过 |
| 11. 10,000 事件、250ms 与 stat gate              | fake scheduler/counting reader 测试         | 通过 |
| 12. tarball 隔离安装与 package smoke             | QA 临时 prefix 安装，输出 `toolCount:13`    | 通过 |

- [x] Review 第 5 节重点已覆盖：真实 permission child、tarball、runtimeCode/details poison、generation
      replacement 与 stopped drain 均有运行证据。
- [x] QA 报告 `status=passed`，QA-001 至 QA-011 全部 pass，failed/blocked 为 none。
- [x] Evidence pack、scope gate 与 DoD results 均为 passed；本轮再次运行聚合命令。
- [x] QA residual risk 均为非核心已知限制，没有把未验证的核心路径降级成 residual risk。

## 4. 术语一致性

- `Facade 实例`：代码使用 instance/state/generation，未与底层 ACP Agent 进程混用。
- `Agent 诊断视图`：集中为 diagnostics DTO，不复用 `cs_agent_status` runtime 结果。
- `活跃 Agent`：默认过滤实现为 running instance 且 agent state 非 destroyed。
- `attach`：CLI、README、测试均表示只读跟随，不含控制语义。
- `Agent selector`：完整 UUID 或安全唯一前缀；损坏 snapshot 下前缀 fail-closed。
- 防冲突：没有把 diagnostics DTO 写成 Facade schema 字段，也没有把 lock token 暴露为输出。

## 5. 领域影响盘点

- [x] 新名词候选：无。`AgentDiagnostic*` 是本地投影视图，design 明确不进入长期领域术语表；仓库当前
      无 `.codestable/requirements/CONTEXT.md`，不需要为该投影新建领域实体。
- [x] 结构性选择候选：snapshot observation 而非发布 live HTTP diagnostics endpoint，跨 CLI、
      persistence 与 process-lock，具有真实安全权衡。建议后续用 `cs-domain` 记录 ADR。
- [x] 流程级约束候选：诊断保持只读、generation 隔离优先于 replacement 尾事件恢复，可与上述 ADR
      一并记录；本次 acceptance 不代写 CONTEXT/ADR。

## 6. Requirement Delta / Clarification 回写

- Requirement：`.codestable/requirements/agent-runtime-diagnostics.md`。
- 状态已是 `current`，`implemented_by: [agent-runtime-diagnostics]` 已落盘。
- 本 feature 实现 approved requirement 的既定用户能力，没有改变 pitch、用户故事或能力边界；无新的
  owner-approved req delta 需要机械应用，因此 requirement 正文不再改写。

## 7. Roadmap 回写

Design frontmatter 没有 `roadmap` / `roadmap_item` 字段，本 feature 非 roadmap 起头；按协议跳过
items.yaml 与 roadmap 主文档回写。

## 8. Attention.md 候选盘点

- 候选：本机 root-owned `~/.npm` cache 会让 `npm pack` 报 EPERM；使用
  `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache` 可稳定运行完整 gate。
- 本节仅登记，不擅自改 `.codestable/attention.md`。该问题跨 feature 可复现，退出后应由用户决定是否
  通过 `cs-note` 固化。
- 用户指南、公开命令和架构边界已在 README、CHANGELOG、MCP 架构文档落盘，不需要额外 docs 修复。

## 9. 遗留

后续优化点（均非验收阻断）：

- REV-024：为 active turn error 的 `details.runtimeCode` 增加单独端到端断言。
- REV-025：改善 list/status 文本列对齐及 permission/lastError 信息密度。
- REV-026：实例数量很大时可评估并发读取，当前 list/status 为串行 I/O。
- REV-027：可注释 terminal summary 中 error message 优先于 stopReason 的规则。

已知限制：

- `error.details` 是开放字段袋；未来新增可见字段必须继续单字段 allowlist 并补 poison 断言。
- replacement 优先保证 generation 隔离，无法恢复 token 变化前尚未观察到的旧代尾事件。
- `kill(pid, 0)` 无法排除 PID 复用；`fs.watch` 存在跨平台通知差异；单次 snapshot 解析仍为
  O(file size)。这些均为 design 已接受风险。
- QA 环境为 macOS / Node 22.22.2；其他平台依赖 1s fallback，未逐平台实测。

## 10. 最终审计

- 验证证据来源：`agent-runtime-diagnostics-qa.md`（passed）。
- Evidence sources：evidence pack、gate results、DoD results，均 passed。
- 聚合命令：`NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run check`，exit 0；format、docs、
  typecheck、lint、build、212/212 tests、pack dry-run 全通过。
- 公开入口：`node dist/mcp-cli.js --help` 与 `node dist/mcp-cli.js agents --help` 均 exit 0。
- 场景复核：`re-verified 11` / `trust-prior-verify 1`。仅 tarball 临时全局安装复用 QA 证据；本轮已重新
  pack dry-run，QA 的隔离 prefix 安装和 smoke 输出为
  `{"toolCount":13,"lifecycle":"ok","diagnostics":"ok"}`。
- 交付物复核：代码入口、只读模块、lock probe、测试注册、package smoke、README、CHANGELOG、
  architecture、requirement 均存在；schema/13 工具未变；roadmap 不适用。
- 完整工作区复核：验收前基线干净；最终未跟踪/暂存/未暂存文件均纳入本报告与提交范围。
- diff 清洁度：`git diff --check` 通过；新增代码范围 grep 无 console.log/error、TODO、FIXME、XXX；
  feature diff 没有越界文件。
- Checklist：S0-S5 全 `done`，C01-C18 全 `passed`。
- 知识沉淀出口：ADR 候选交 `cs-domain`；npm cache 候选交 `cs-note`；公开指南与架构文档已同步。
- 终审结论：原始契约、运行证据、交付物与状态回写均闭合，无 unresolved blocking/important、failed、
  blocked 或 handoff；验收通过。
