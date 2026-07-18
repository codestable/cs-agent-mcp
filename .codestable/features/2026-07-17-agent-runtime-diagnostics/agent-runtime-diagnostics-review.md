---
doc_type: feature-review
feature: 2026-07-17-agent-runtime-diagnostics
status: passed
reviewer: subagent+ocr
reviewed: 2026-07-18
round: 5
---

# Agent 运行状态诊断 CLI 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Evidence pack: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- Gate results: none（implementation evidence 与 checklist DoD 命令作为输入）
- DoD results: none（结果记录在 evidence pack 与 ledger）
- Implementation evidence: baseline `23bd738` 至 HEAD `99e822d`；重点 diff `585a37e..99e822d`
- Diff basis: 完整 feature diff + round 4 review-fix
- Baseline dirty files: none

### Independent Review

- Detection: Paseo `claude/opus` plan mode 与 OCR CLI 均完成
- 环节 A 独立隔离 Task agent: paseo + completed（agent `69054ba2-ceea-4525-8b91-fbcc14bfa892`）
- 环节 B OCR CLI: completed，`585a37e..HEAD` 0 comments
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: 独立 reviewer 对 Facade writer、FacadeErrorShape、三条 diagnostics 路径和 poison fixture 完成交叉核验
- Gate effect: none；blocking/important 已清零

## 2. Diff Summary

- 新增：diagnostics 模块、agent diagnostics 测试、goal 执行包与 evidence pack
- 修改：CLI、process lock probe、package smoke、测试、README、CHANGELOG、架构与 requirement 文档
- 删除：none
- 未跟踪 / staged：none
- 风险热点：generation/lock/snapshot 时序、不可信 nested 数据、error details 脱敏、全局 watcher 性能

## 3. Adversarial Pass

- 假设的生产 bug：开放 `error.details` 袋可能通过 runtimeCode 投影泄漏 cwd/agentId，或 status/attach/active-turn 三条路径行为不一致。
- 主动攻击过的反例：真实 `details.runtimeCode`、`details.cwd/resolvedCwd/agentId`、stack/cause、malformed runtimeCode、replacement token races、超长文本。
- 结果：runtimeCode 三路径统一读取单字段；details 和 poison 默认丢弃；generation、drain、nested、截断和只读边界无回归。

## 4. Findings

### blocking

- none

### important

- none

### nit

- [ ] REV-024 active turn error 的 `details.runtimeCode` 目前通过共用 `sanitizeError` 结构性证明，缺少单独端到端断言。（Paseo）
- [ ] REV-025 list/status 文本列对齐与 permission/lastError 信息密度可改善，JSON DTO 完整。
- [ ] REV-026 多实例 list/status 采用串行 I/O，实例很多时启动延迟线性累积。

### suggestion

- [ ] REV-027 `projectTerminalTurn` 可注释 error message 优先于 stopReason 的 summary 规则。

### learning

- writer shape 的真实性必须递归到开放 details 袋；单字段 allowlist 正在保护真实持久化的 cwd/agentId 路径，而非纯假设风险。

### praise

- runtimeCode 在 terminal event、status lastError 和 active turn error 三条路径统一走 `runtimeCodeFromError`，不展开 details。
- generation replacement、stopped final drain、250ms/stat gate、nested fail-closed、poison allowlist、只读边界与 13 工具兼容均成立。

## 5. Test And QA Focus

- QA 必须重点复核：真实 permission child 的 read/watch/kill/write-denied；真实 tarball 安装；status/attach 的 runtimeCode 与 details poison；generation replacement 与 stopped drain。
- Evidence pack residual risks / gate warnings：本机 root-owned npm cache 需独立 `NPM_CONFIG_CACHE`；开放 details 袋新增可见字段必须显式扩 allowlist。
- 建议新增或加强的测试：active-turn runtimeCode 直接断言；真实 Facade 失败产物而非手写 fixture。
- 不能靠 review 完全确认的点：跨平台 `fs.watch`、PID 复用、单次 O(file size) 解析。

## 6. Residual Risk

- `error.details` 是开放字段袋；长期安全依赖 diagnostics 只提取显式单字段。
- replacement 无法恢复未观察到的旧代尾事件，generation 隔离优先。
- stale PID、watcher 差异和单次整体 JSON 解析为 design 已接受风险。

## 7. Verdict

- Status: passed
- Next: `cs-feat` QA 阶段。
