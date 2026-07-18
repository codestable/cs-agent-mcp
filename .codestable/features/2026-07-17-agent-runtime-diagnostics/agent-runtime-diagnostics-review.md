---
doc_type: feature-review
feature: 2026-07-17-agent-runtime-diagnostics
status: changes-requested
reviewer: subagent+ocr
reviewed: 2026-07-18
round: 4
---

# Agent 运行状态诊断 CLI 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Evidence pack: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- Gate results: none（implementation evidence 与 checklist DoD 命令作为输入）
- DoD results: none（结果记录在 evidence pack 与 ledger）
- Implementation evidence: baseline `23bd738` 至 HEAD `585a37e`；重点 diff `20a2f8d..585a37e`
- Diff basis: 完整 feature diff + round 3 review-fix
- Baseline dirty files: none

### Independent Review

- Detection: Paseo `claude/opus` plan mode 与 OCR CLI 均完成
- 环节 A 独立隔离 Task agent: paseo + completed（agent `9b857bd2-2de5-4eec-940a-8669465e8fcb`）
- 环节 B OCR CLI: completed，`20a2f8d..HEAD` 0 comments
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: finding 已与 `FacadeErrorShape` 和 Facade 写入 `details.runtimeCode` 的源码交叉核验
- Gate effect: runtimeCode 读取深度与真实 schema 不一致，阻止进入 QA

## 2. Diff Summary

- 新增：diagnostics 模块、测试、goal 执行包与 evidence pack
- 修改：CLI、lock probe、package smoke、测试和文档
- 删除：none
- 未跟踪 / staged：none
- 风险热点：开放 error details 袋的单字段脱敏、writer/reader fixture 一致性

## 3. Adversarial Pass

- 假设的生产 bug：terminal event 的一级 error shape 修正后，error 内部仍有更深的实际字段层级。
- 主动攻击过的反例：真实 `FacadeErrorShape.details.runtimeCode`，以及 details 中混入 cwd/agentId/cause。
- 结果：发现一项 important；code/message/retryable、reason/stopReason、截断与 poison 丢弃均确认成立。

## 4. Findings

### blocking

- none

### important

- [ ] REV-022 `src/mcp/diagnostics/index.ts:773` runtimeCode 从错误层级读取，真实 status/attach 恒缺失。（Paseo）
  - Evidence: `FacadeErrorShape` 只有 `details?: Record<string,unknown>`；Facade 唯一写入路径是 `error.details.runtimeCode`。projector、`sanitizeError`、`parseError` 均按顶层 `error.runtimeCode` 处理，测试也构造了生产不会生成的顶层 fixture。
  - Impact: 设计白名单承诺的 runtimeCode 在生产不可达，round 3 测试为假阳性。
  - Expected fix scope: 只从 `error.details.runtimeCode` 读取一个字符串字段；不透传/展开 details；fixture 改为真实 shape 并加入 details poison 负向断言。

### nit

- none

### suggestion

- [ ] REV-023 `projectTerminalTurn` 可用一行注释说明 error message 优先于 stopReason 作为 summary。

### learning

- writer shape 的真实性需要递归到开放 details 袋；只校验一级对象仍可能保留不可达的假 fixture。

### praise

- round 3 已正确修复 code/message/retryable、cancel reason 与文本截断，stack/cause 仍 fail-closed。
- generation replacement、stopped drain、nested fail-closed、package smoke 与只读边界未被触碰。

## 5. Test And QA Focus

- QA 必须重点复核：真实 `details.runtimeCode` 在 status/attach 可见，但 details、cwd、agentId 等其他字段完全不可见。
- Evidence pack residual risks / gate warnings：开放 details 袋未来新增字段时必须继续默认丢弃；独立 npm cache 规避本机 npm cache EPERM。
- 建议新增或加强的测试：真实 error details fixture与 poison fields；尽可能用 Facade 真 snapshot 端到端验证。
- 不能靠 review 完全确认的点：Node permission child、真实 tarball 临时安装、跨平台 watcher。

## 6. Residual Risk

- `error.details` 是开放字段袋；安全依赖 diagnostics 永远只按单字段 allowlist 提取 runtimeCode。
- replacement 尾事件、stale PID、watcher 差异和单次 O(file size) 解析维持既有 residual risk。

## 7. Verdict

- Status: changes-requested
- Next: 来源实现技能 review-fix；修复 REV-022 后重跑独立 review。
