---
doc_type: feature-review
feature: 2026-07-17-agent-runtime-diagnostics
status: changes-requested
reviewer: subagent+ocr
reviewed: 2026-07-18
round: 3
---

# Agent 运行状态诊断 CLI 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Evidence pack: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- Gate results: none（implementation evidence 与 checklist DoD 命令作为本轮输入）
- DoD results: none（结果记录在 evidence pack 与 goal-state ledger）
- Implementation evidence: baseline `23bd738` 至 HEAD `20a2f8d`；重点 review-fix 为 `6da73c9..20a2f8d`
- Diff basis: 完整 feature diff + round 2 review-fix diff
- Baseline dirty files: none

### Independent Review

- Detection: Paseo `claude/opus` plan mode 与 OCR CLI 均完成
- 环节 A 独立隔离 Task agent: paseo + completed（agent `b323f160-224e-463d-8127-cee8f1ebd50e`）
- 环节 B OCR CLI: completed，`6da73c9..HEAD` 0 comments
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: 独立 reviewer finding 已用 Facade 真实 appendEvent data 形状本地核验
- Gate effect: terminal event 投影 fixture 与真实 shape 不一致，阻止进入 QA

## 2. Diff Summary

- 新增：diagnostics 模块、agent diagnostics 测试、goal 执行包与 evidence pack
- 修改：CLI、process lock probe、package smoke、测试与用户/架构/requirement 文档
- 删除：none
- 未跟踪 / staged：none
- 风险热点：Facade event data 与 diagnostics allowlist 的跨模块契约、generation 时序、不可信 snapshot

## 3. Adversarial Pass

- 假设的生产 bug：测试 fixture 与 Facade 实际 event data 层级不同，导致绿灯无法证明真实投影。
- 主动攻击过的反例：`turn.failed` 的 `data.error`、`turn.completed` 的 `stopReason+error`、`turn.cancelled` 的 `reason`。
- 结果：发现一项 important 假阳性；round 2 generation、nested、截断与 package smoke 修复均确认成立。

## 4. Findings

### blocking

- none

### important

- [ ] REV-017 `src/mcp/diagnostics/index.ts:754` terminal turn event 的投影层级与 Facade 真实 data shape 不一致。（Paseo）
  - Evidence: projector 从顶层读取 `code/message/retryable/runtimeCode`，但 Facade 的 failed/completed 写入 `data.error.*`；cancelled 写入 `data.reason`。现有超长 failed fixture 使用错误的扁平 `{message}`，形成测试假阳性。
  - Impact: attach 时间线丢失失败 code/message 和取消原因，违反事件 allowlist 与“最近发生了什么错误”的成功标准；真实 failed error 截断路径也未执行。
  - Expected fix scope: 只在 diagnostics 投影层读取 `data.error` 并归一 `reason/stopReason`，不透传 error 对象；测试改用真实 Facade data shape。

### nit

- [ ] REV-018 `src/mcp/diagnostics/index.ts:882` `stopReason/reason/tag` 尚未纳入明确文本字段截断集合。（Paseo）
- [ ] REV-019 status/list 文本信息密度与列对齐仍可改善；JSON DTO 完整，不阻塞本轮。
- [ ] REV-020 多实例 list/status 串行 I/O，实例很多时启动延迟线性累积。（OCR round 2）

### suggestion

- [ ] REV-021 在 Facade entrypoint 的“先 acquire lock 后首次 snapshot write”处增加 generation 隔离不变量注释。

### learning

- allowlist 测试必须来自 writer 的真实持久化 shape；手工构造更方便的扁平 fixture 会把不可达代码误当成已覆盖。

### praise

- generation replacement 在首次 probe、reread 和 final drain 后均有 token 双检，新 generation events 不会进入旧 attach。
- Agent/Turn/Event consumed nested fail-closed、文本截断、package smoke `close` 与只读边界均已核验成立。

## 5. Test And QA Focus

- QA 必须重点复核：真实 `{stopReason,error:{...}}` 和 `{reason}` terminal events；超长 error/stopReason/tag；replacement reread race；stopped/unknown final drain。
- Evidence pack residual risks / gate warnings：replacement 依赖“先 acquire lock 后写 snapshot”启动顺序；独立 npm cache 规避本机 npm cache EPERM。
- 建议新增或加强的测试：使用 Facade writer shape 的 failed/completed/cancelled 投影 fixture。
- 不能靠 review 完全确认的点：Node permission child、真实 tarball 临时安装、跨平台 `fs.watch`。

## 6. Residual Risk

- replacement 无法从复用 snapshot 文件可靠恢复未观察到的旧代尾事件，generation 隔离优先。
- stale PID 复用、跨平台 watcher 通知差异和单次 O(file size) 解析为 design 已接受风险。

## 7. Verdict

- Status: changes-requested
- Next: 来源实现技能 review-fix；修复 REV-017，并将 REV-018 纳入同一文本边界后重跑独立 review。
