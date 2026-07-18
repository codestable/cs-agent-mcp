---
doc_type: feature-review
feature: 2026-07-17-agent-runtime-diagnostics
status: changes-requested
reviewer: subagent+ocr
reviewed: 2026-07-18
round: 1
---

# Agent 运行状态诊断 CLI 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Evidence pack: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- Gate results: none（goal 包未生成独立 gate-results 文件，implementation evidence 与 checklist DoD 命令作为本轮输入）
- DoD results: none（DoD 命令及结果记录在 evidence pack 与 goal-state ledger）
- Implementation evidence: S0-S5 ledger、evidence pack、`23bd73868624ea843807a602ba550e1c803aa63d..HEAD`
- Diff basis: 17 个文件，约 2595 行新增、30 行删除；核心新增为 diagnostics read model、CLI、测试与 package smoke
- Baseline dirty files: none

### Independent Review

- Detection: Paseo subagent 可用；audit provider 为 `claude/opus`；OCR CLI 可用
- 环节 A 独立隔离 Task agent: paseo + completed（agent `9cbf5fa3-4d1a-40e6-8981-7669da788d61`）
- 环节 B OCR CLI: completed
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: Paseo、OCR 与本地主动对抗式审查的发现均已逐条结合源码和 design 契约核验后合并
- Gate effect: 存在 design 契约偏离与测试假阳性，阻止进入 QA

## 2. Diff Summary

- 新增：diagnostics 模块、agent diagnostics 测试、goal 执行包与 evidence pack
- 修改：CLI、process lock probe、package smoke、MCP CLI 测试、README、CHANGELOG、架构与 requirement 文档
- 删除：none
- 未跟踪 / staged：none
- 风险热点：持久化 snapshot 的不可信输入校验、watch/atomic rename 时序、最终 drain、全局目录 watcher 性能、公开 JSONL DTO

## 3. Adversarial Pass

- 假设的生产 bug：损坏 snapshot 或 shutdown/watch 竞态会让 attach 输出不合法 DTO、丢失末尾事件，或在持续通知下频繁全量解析全部实例。
- 主动攻击过的反例：Event required field 缺失/类型错误、其他 workspace 高频写入、同 generation 停止、watcher 连续 error、超长 output delta、replacement 与 unreadable snapshot。
- 结果：nested Event 校验缺口升级为 blocking；250ms/stat gate、普通 stop 最终 drain、watch error 节流与截断信号升级为 important；PID 复用和跨平台 watcher 行为保留为 residual risk。

## 4. Findings

### blocking

- [ ] REV-001 `src/mcp/diagnostics/index.ts:853` Event nested schema 没有逐项校验。
  - Evidence: `parseDiagnosticSnapshot` 只对 `snapshot.events` 调用 `requireArray` 后直接强制转换；design 2.1 明确要求对 CLI 消费的 Event required fields/type 做 L3 校验，C01 已声明 nested schema 校验完成。缺失或类型错误的 `cursor/type/timestamp/agentId` 会进入排序、筛选和 `DiagnosticEvent`，产生无效 JSON DTO 或错误终止判断。
  - Impact: 损坏持久化输入没有 fail-closed，公开诊断 DTO 与验收场景 2 的证据不可信，不能进入 QA。
  - Expected fix scope: 对每个 Event 的 required fields、已知 event type 与可选字符串字段做校验；未知兼容字段可保留在内部但不得透传；新增损坏 Event fixture。

### important

- [ ] REV-002 `src/mcp/diagnostics/index.ts:379` 未实现 design 承诺的最小 250ms 重读间隔与目标 stat-signature gate。
  - Evidence: follow 每次 wake 都执行 `readTarget`，后者枚举并解析全部 snapshot；唯一 debounce 默认 25ms。design 2.2 明确要求重读间隔不得低于 250ms，且只有 stat signature 或 lock 状态变化才完整重读。现有 counting-reader 测试只覆盖一个 25ms debounce 窗口内的 burst，无法证明 C14/C17。
  - Impact: 全局 facade 目录中任意 workspace 的持续写入可导致每约 25ms 全量解析全部实例，性能契约与测试证据失真。
- [ ] REV-003 `src/mcp/diagnostics/index.ts:416` 同 generation 的停止路径没有最终二次 drain。
  - Evidence: `finalDrainIfReplacing` 只在 generation replacement 时 sleep+重读；`readFacadeEntry` 先读 snapshot 后 probe lock，可能读到旧 snapshot 后观察到 lock 已 stopped，并立即输出 `instance_stopped`。design 场景 8 要求 shutdown 与 replacement 都先 drain release 前末尾事件。
  - Impact: 正常关停竞态下可能丢失最后的错误或终态事件。
- [ ] REV-004 `src/mcp/diagnostics/index.ts:820` watcher error 绕过去抖并可能形成紧循环。
  - Evidence: `onChange` 走 `scheduleDone`，`onError` 直接调用 `done`；重新挂载后若平台持续报告 watch error，会立即 wake、全量重读、重挂 watcher。
  - Impact: 与 REV-002 叠加时可形成无最小退避的高频全量解析。
- [ ] REV-005 `src/mcp/diagnostics/index.ts:630` 顶层 `DiagnosticEvent.truncated` 可能与实际正文截断相反。
  - Evidence: text delta detail 先截断 summary 并记录 `detail.truncated=true`，`projectEvent` 再对已截断 summary 调用 `truncateText`，导致顶层 `truncated=false`。design 2.2 要求超过 2,000 Unicode code points 时 `truncated=true`。
  - Impact: JSONL 消费方无法依赖稳定顶层字段判断摘要是否被截断。

### nit

- [ ] REV-006 `src/mcp-cli.ts:120` terminal item 的临时 `exitCode` 赋值最终总会被 generator return value 覆盖，属于死赋值。（OCR）
- [ ] REV-007 `src/mcp/diagnostics/index.ts:264` `rootCwd(snapshot)` 被重复计算。（OCR）

### suggestion

- none

### learning

- 本机 `~/.npm` cache 含 root-owned 文件时，`npm pack --dry-run` 会报 EPERM；使用独立 `NPM_CONFIG_CACHE=/tmp/...` 可稳定复现完整检查。

### praise

- 诊断路径保持只读，不调用 mutation/runtime/identity/lock acquire-remove；13 个 MCP 工具和 Facade schema 未变。
- 事件 detail 使用字段级 allowlist，poison fixture 已证明 thought、raw tool payload 与 locations 未知字段不会泄漏。
- selector 在 unreadable snapshot 下对前缀 fail-closed，完整 UUID 仍可精确匹配并附带 warning。

## 5. Test And QA Focus

- QA 必须重点复核：Event nested 损坏 fail-closed；多个独立通知下 250ms 重读下限；非目标 workspace 更新不触发目标 snapshot parse；同实例正常 stop 的末尾事件先于 terminal；watch error 有退避。
- Evidence pack residual risks / gate warnings：普通 npm cache EPERM 已归因为环境问题；完整 check 必须继续使用独立临时 cache 复跑。
- 建议新增或加强的测试：损坏 Event required fields/type、fake scheduler 跨多个 debounce 窗口的重读间隔、双实例 stat gate、同 generation stop drain、重复 watcher error、超过 2,000 code points 的顶层截断标志。
- 不能靠 review 完全确认的点：真实 `fs.watch` 跨平台合并/丢事件行为、stale lock 的 PID 复用、超大 snapshot 单次 O(file size) 解析成本。

## 6. Residual Risk

- `process.kill(pid, 0)` 不能排除 PID 复用；design 已接受。
- `fs.watch` 在不同平台可能合并或丢通知；1s fallback 只保证最终可见，不保证亚秒延迟。
- v1 snapshot 仍需整体 JSON 解析；完成频率与 stat gate 后，单次 O(file size) 成本仍存在。

## 7. Verdict

- Status: changes-requested
- Next: 来源实现技能 review-fix；修复 REV-001 至 REV-005 并补真实回归测试，随后重跑独立 code review，不能直接进入 QA。
