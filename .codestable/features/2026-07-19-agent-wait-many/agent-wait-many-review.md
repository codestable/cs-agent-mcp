---
doc_type: feature-review
feature: 2026-07-19-agent-wait-many
status: passed
reviewer: subagent+ocr
reviewed: 2026-07-19
round: 2
---

# Agent Wait Many 代码审查报告

## 1. Scope And Inputs

- Design：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md`
- Checklist：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-checklist.yaml`
- Evidence pack：`.codestable/features/2026-07-19-agent-wait-many/implementation-evidence-pack.md`
- Gate results：`implementation-scope-gate.json`、`implementation-dod-gate.json`
- DoD results：`implementation-dod-results.json`，fresh 3/3 core commands passed
- Implementation evidence：`agent-wait-many-implementation-evidence.md`
- Diff basis：当前 unstaged/untracked feature diff；无 staged diff
- Baseline dirty files：none，全部非忽略改动均可归因本 feature

### Independent Review

- Detection：Paseo subagent、OCR CLI 均可用；codebase-memory MCP 返回 `Transport closed`，按仓库约定
  降级源码 diff 与相邻调用点核验。
- 环节 A：Paseo Agent `4a85b956-415e-4352-a60f-d1f58eda0234`，Claude Opus，`plan` 只读
  mode，completed；spec 合规 PASS、代码质量 PASS。
- 环节 B：OCR completed，18 files、1 Low maintainability comment；按协议 Low discarded。
- OCR severity mapping：High→blocking/important，Medium→nit/suggestion，Low→discarded。
- Merge policy：Task agent 与 OCR 结果均已逐条用仓库事实和 fresh 命令核验。
- Gate effect：none；所有 started lanes completed。
- Agent close：archived successfully after result consumption。

## 2. Diff Summary

- 新增：Wait Many 投影模块、tarball smoke wrapper、跨平台 package command helper 与对应测试。
- 修改：Facade/types/MCP server、contract/Facade/多进程 E2E、CI/release、README/架构/CHANGELOG。
- 删除：none。
- 未跟踪 / staged：新增文件未跟踪；无 staged diff。
- 风险热点：公开 MCP schema、权限/终态投影、revision long-poll、跨平台 tarball smoke。

## 3. Adversarial Pass

- 假设的生产 bug：权限取消与终态交界出现陈旧 action_required、lost wakeup、批量越权泄漏，或
  package smoke 只在 POSIX 可执行。
- 主动攻击过的反例：cancelled/expired/resolved Permission、message/terminal/permission 优先级、
  raw 边界和去重、sibling/unknown 原子失败、全局 revision 并发唤醒、Windows `.cmd`、tarball 清理。
- 结果：Round 1 的 REV-001/REV-002 已修复并有回归；Round 2 未发现新的产品代码 blocking 或
  important。

## 4. Findings

### blocking

none。

### important

none。

Round 2 曾发现生成证据仍内嵌修复前 `265/265`；已按 reviewer 的窄修复边界重跑 DoD runner 并
重新生成 evidence pack。fresh 结果为 `pnpm run check` 267/267、CMD-003 52/52、tarball smoke
`toolCount:14` 且 `waitMany/lifecycle/diagnostics:ok`，该证据完整性 finding 已关闭。

### nit

- `waitMs: 0` 返回 `retryAfterMs: 0`，与既有单 Turn wait 公式一致且已有回归，接受。
- package spawn 的纯 `.mjs` 单测直接从源码运行，与其余编译后测试路径风格不同，但执行契约明确。

### suggestion

- Facade 的默认 `mode=any` 与 MCP schema default 重复，是面向直连调用者的有意防御，保留。

### learning

- 单 snapshot 克隆与全局 revision 单 waiter 能保持结果引用稳定，并避免 per-Turn listener/timer。

### praise

- 权限终态投影修复、单 waiter 插桩和文件 barrier 并发断言均直接证明设计关键风险，不依赖 mock
  时间阈值或间接推断。

## 5. Test And QA Focus

- QA 必须复核 fresh `pnpm run check`、CMD-003、真实 tarball 临时安装和 14 tools wait-many smoke。
- 重点复核 all 的权限/timeout 两轮累计、cancelled permission 终态、unknown/sibling 原子失败、
  barrier 释放前多个 Turn 同时 running。
- Evidence pack residual risks / gate warnings：none。
- review 无法确认：真实 Windows runner；高频无关 mutation 下的性能放大，不影响本次正确性。

## 6. Residual Risk

- Windows `.cmd` 分支已有纯函数回归，但本机不是 Windows，留给后续 Windows CI/owner 环境验证。
- 全局 revision 在大 Workspace 高频 mutation 下会造成额外 snapshot 重读；这是批准设计明确接受的
  有界权衡。

## 7. Verdict

- Status：passed。
- Spec compliance：passed。
- Code quality：passed。
- Next：进入 feature QA。

## 8. Round 1 Disposition

- REV-001 blocking：已关闭。仅 pending Permission 投影 action_required，terminal 优先。
- REV-002 important：已关闭。Windows `.cmd/.bat` 使用 shell，tarball MCP smoke 通过 Node entrypoint。
