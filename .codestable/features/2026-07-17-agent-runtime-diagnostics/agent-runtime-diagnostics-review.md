---
doc_type: feature-review
feature: 2026-07-17-agent-runtime-diagnostics
status: changes-requested
reviewer: subagent+ocr
reviewed: 2026-07-18
round: 2
---

# Agent 运行状态诊断 CLI 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Evidence pack: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- Gate results: none（implementation evidence 与 checklist DoD 命令作为本轮输入）
- DoD results: none（结果记录在 evidence pack 与 goal-state ledger）
- Implementation evidence: S0-S5 ledger、round 1 review-fix 证据、`23bd73868624ea843807a602ba550e1c803aa63d..6da73c9`
- Diff basis: baseline 至 HEAD 的完整 feature diff；round 1 修复提交为 `6da73c9`
- Baseline dirty files: none

### Independent Review

- Detection: Paseo subagent `claude/opus` plan mode 与 OCR CLI 均可用
- 环节 A 独立隔离 Task agent: paseo + completed（agent `bcea6e1b-cae0-44e3-b9e0-986bda6a49cd`）
- 环节 B OCR CLI: completed
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: Paseo、OCR 与本地 findings 均已结合源码和 design 逐条核验；OCR generator cleanup finding 因正常 SIGINT 路径会完成 generator、yield 时无活跃 watcher，降为 suggestion
- Gate effect: generation 隔离、文本上限、nested DTO 与 package smoke 仍有 important，阻止进入 QA

## 2. Diff Summary

- 新增：diagnostics 模块、agent diagnostics 测试、goal 执行包与 evidence pack
- 修改：CLI、process lock probe、package smoke、MCP CLI 测试、README、CHANGELOG、架构与 requirement 文档
- 删除：none
- 未跟踪 / staged：none
- 风险热点：generation 更替时序、不可信 snapshot nested 字段、稳定 JSONL DTO、全局 watcher 性能、package smoke 可信度

## 3. Adversarial Pass

- 假设的生产 bug：新 Facade generation 的事件被旧 attach 输出；超长 allowlisted 文本或损坏可选 nested 字段突破稳定 DTO；smoke 在 stdio 未 drain 时解析截断 JSON。
- 主动攻击过的反例：token T1→T2 且 cursor 延续、>2,000 code points 的 status/tool/error、非字符串 pendingPermissionId/error、child `exit` 早于 pipe close。
- 结果：四项升级为 important；round 1 的 nested Event、250ms/stat gate、stopped final drain、watch error debounce 与顶层截断信号均已用测试和源码确认修复。

## 4. Findings

### blocking

- none

### important

- [ ] REV-008 `src/mcp/diagnostics/index.ts:425` generation replacement 会先输出新 generation 事件，再输出 `instance_replaced`。
  - Evidence: token 变化后仍调用 `rereadAttachedTarget`、`finalDrainIfInstanceTerminating` 和 `eventsAfter`；新进程从持久 snapshot 继续递增 cursor，无法凭 snapshot 内容区分旧代尾事件与新代事件。现有 replacement 测试把 cursor 2 输出固化为期望。
  - Impact: 违反 design 的“不跨 Facade generation 无缝跟随”，排障时间线混入新实例事件。
  - Expected fix scope: generation 变化时不再 drain snapshot，直接 terminal；reread 后才观察到 token 变化的竞态也必须丢弃本次 events。stopped/unknown 继续最终 drain。
- [ ] REV-009 `src/mcp/diagnostics/index.ts:804` allowlisted `text/message/title` 与 diagnostics error message 可绕过 2,000 code point 上限。
  - Evidence: `pickScalars` 与 `sanitizeError` 原样保留这些字符串，只有顶层 summary 或 text delta 被截断。
  - Impact: 违反 design 的 summary/text 上限，JSON/JSONL 可被超长状态或错误字段放大。
  - Expected fix scope: 对明确的文本字段统一截断并聚合 `truncated` 信号；ID、cursor、code 等字段保持完整。
- [ ] REV-010 `src/mcp/diagnostics/index.ts:985` 已消费的 Agent/Turn 可选 nested 字段缺少类型校验。
  - Evidence: `activeTurnId`、`pendingPermissionId`、`stopReason`、可选时间戳与 error shape 经类型断言进入 DTO；损坏 snapshot 可输出非字符串或缺字段 error。
  - Impact: C01 和 design 2.1 的 consumed nested fail-closed 证据仍不完整。
  - Expected fix scope: 对 CLI 实际消费的可选字段在存在时做 L3 type 校验，未知未消费字段继续兼容。
- [ ] REV-011 `scripts/package-smoke.mjs:73` child `exit` 事件可能早于 stdout/stderr pipe 完全关闭。（OCR）
  - Evidence: `runBinary` 在 `exit` resolve 后立即解析 list/status JSON；Node 的 `close` 才保证 stdio streams 已关闭。
  - Impact: package smoke 可能因截断 JSON 偶发失败，削弱 C18/acceptance 证据可信度。
  - Expected fix scope: 等待 `close` 并在断言失败时携带 stderr；不改变产品代码。

### nit

- [ ] REV-012 `src/mcp-cli.ts:156` 文本 status 未展示 pending permission 与 last error，JSON DTO 完整但终端扫描信息不足。（Paseo）
- [ ] REV-013 `src/mcp-cli.ts:141` list 文本使用固定双空格，变长字段不对齐。（Paseo/OCR）
- [ ] REV-014 `src/mcp/diagnostics/index.ts:251` list/status 对多实例采用串行 I/O，实例很多时启动延迟线性累积。（OCR）

### suggestion

- [ ] REV-015 CLI 在异常退出时可显式 `return()` async generator；当前正常 SIGINT 会完成 generator，yield 期间也没有活跃 watcher，因此不阻塞本轮。（OCR）
- [ ] REV-016 lifecycle 事件可按 design 白名单补投影 `kind`，当前属于信息缺失而非泄漏。（Paseo）

### learning

- generation token 一旦变化，单个持续复用的 snapshot 文件无法再证明其中新增 cursor 属于旧代；安全诊断应优先隔离 generation，而不是猜测最终 drain 归属。

### praise

- round 1 已补齐 Event required-field 校验、250ms 最小间隔、目标 signature gate、stopped final drain、watch error 去抖和截断顶层信号。
- 只读边界、selector fail-closed、字段级 allowlist 与 poison fixture 仍然成立。

## 5. Test And QA Focus

- QA 必须重点复核：replacement 不输出新 generation cursor；stopped 仍 drain 旧代尾事件；所有 allowlisted 文本与 error message 截断；可选 nested 损坏 fail-closed；package smoke 使用完整 stdio 输出。
- Evidence pack residual risks / gate warnings：独立 npm cache 规避本机 root-owned `~/.npm`；replacement 无法证明旧代尾事件归属，修复后作为 residual risk。
- 建议新增或加强的测试：generation 隔离反例、status/tool/error 超长文本、Agent/Turn optional nested 损坏、package smoke `close` 路径。
- 不能靠 review 完全确认的点：真实 Node permission child、真实 tarball 临时安装、跨平台 `fs.watch`。

## 6. Residual Risk

- replacement 发生后无法从复用 snapshot 文件可靠 drain 旧代 release 前尾事件；必须以不混入新代事件为更强不变量。
- v1 snapshot 的单次整体 JSON 解析仍为 O(file size)；目标 signature gate 已限制触发频率和实例范围。
- stale lock PID 复用与跨平台 `fs.watch` 合并/丢通知为 design 已接受风险。

## 7. Verdict

- Status: changes-requested
- Next: 来源实现技能 review-fix；修复 REV-008 至 REV-011，重跑独立 code review，不能直接进入 QA。
