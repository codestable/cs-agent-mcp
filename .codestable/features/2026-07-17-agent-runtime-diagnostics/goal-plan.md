---
doc_type: feature-goal-plan
feature: 2026-07-17-agent-runtime-diagnostics
status: ready-to-dispatch
created: 2026-07-17
---

# Agent 运行状态诊断 CLI Goal Plan

## 1. Inputs

- Feature: `2026-07-17-agent-runtime-diagnostics`
- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Design review: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design-review.md`
- Requirement: `.codestable/requirements/agent-runtime-diagnostics.md`
- Baseline ref: `23bd73868624ea843807a602ba550e1c803aa63d`

用户于 2026-07-17 明确回复“设计确认”。design 已为 `approved`，独立 design review round 3 为
`passed`，允许进入 Goal 模式。

## 2. Baseline And Scope

- S0 已完成：`max-turns-exceeded` 修复独立提交为 `0f2ee7a`，已批准设计独立提交为 `23bd738`。
- S0 完整基线：`pnpm run check` 通过，198/198 tests passed，pack dry-run 通过。
- 实现从 S1 开始，feature diff 不得重新混入 `max-turns-exceeded` issue。
- 不改变 13 个 MCP 工具、`cs-agent-mcp.facade.v1`、无参数 stdio 行为或 HTTP actor 边界。
- attach 只读，不发送消息、不响应权限、不取消 Turn，不透传 thought/raw tool payload。

## 3. Execution And TDD

严格按 checklist 的 S1 -> S5 顺序执行，每个 step 完成后立即更新 checklist 和
`goal-state.yaml.ledger`，记录 commit 范围与证据；每个 step 独立提交，不把后续 step 混入。

Implementation TDD policy：

- S1-S5 中所有可自动观察的行为默认 RED -> GREEN -> VERIFY；先证明测试在缺实现时失败，再写最小
  实现，再跑定向和相关回归。
- 纯文档、纯命令注册元数据或只能由类型系统观察的动作可写
  `TDD exception: <原因 + 替代证据>`，不能无记录跳过。
- 新建 `*.test.ts` 时必须同步注册到 `package.json scripts.test`，runner 输出按测试名/计数证明执行。
- 事件投影必须以不可信 snapshot 为输入：只有 `stream === "output"` 输出正文，其他 stream
  fail-closed；至少一个 lifecycle poison fixture 证明未知字段和 request 原文不会输出。

## 4. Core Acceptance Paths

1. 无参数 `cs-agent-mcp` 仍直接提供 stdio MCP，13 个工具与 stderr/stdout 行为不变。
2. `agents list` 精确发现多 workspace snapshot，默认过滤 stopped/unknown/destroyed，`--all` 展开。
3. `agents status` 在全集解析完整 UUID/前缀；歧义、损坏 snapshot 和隐藏候选遵守 fail-closed 契约。
4. `agents attach` 输出 snapshot + 有界历史 + cursor 增量；idle 不退出，destroyed/stop/restart/Ctrl-C
   有稳定 terminal 和退出码，stop 前最终 drain 不丢事件。
5. JSON/JSONL 只输出稳定 DTO allowlist；thought、identity、Message、Permission request、raw tool
   payload 和 poison fields 不出现。
6. live attach 在 `node --permission --allow-fs-read=*` 且无 fs-write 权限下仍可 read/watch/kill/follow，
   任意写入得到 `ERR_ACCESS_DENIED`。
7. counting reader + fake clock 的 10,000-event fixture 确定性证明 debounce parse 上界与 cursor 顺序。
8. npm tarball 临时安装 smoke 实际运行 `agents --help/list/status/attach`，并保留 MCP 13 工具生命周期。

## 5. Validation Commands

- Core: `pnpm run check`
- Supporting: `node dist/mcp-cli.js --help`
- Core: `node dist/mcp-cli.js agents --help`
- Step 内定向测试：使用 `node --test` 指向本 step 相关的 `dist-test/test/*.test.js`，并保存测试名称、
  数量和 RED/GREEN/VERIFY 输出。
- Package smoke：`npm pack` 产物临时全局安装后运行扩展后的 `scripts/package-smoke.mjs`。

## 6. Gates And Required Artifacts

- Implementation gate：S1-S5 全 done；TDD 证据齐全；实现 evidence pack、命令输出、清洁度结果齐全。
- Review gate：独立 `cs-code-review` 同时通过 spec 合规与代码质量两维，无 unresolved
  blocking/important。
- QA gate：所有 core 场景、permission 四证据、C14/C17 性能断言和 package smoke 有实际结果。
- Acceptance gate：C01-C18 更新、README/CHANGELOG/MCP architecture/requirement 同步，最终 diff 与
  交付物可归因。
- Required artifacts：`agent-runtime-diagnostics-review.md`、`agent-runtime-diagnostics-qa.md`、
  `agent-runtime-diagnostics-acceptance.md`、完整命令输出、package smoke、diff summary。

## 7. Handoff Conditions

出现以下任一情况，先写 `goal-state.yaml` 为 `handoff/blocked`，再输出 handoff 标记：

- 需要改变 approved design、公开 CLI/JSON 契约、feature 范围或持久化 schema。
- 独立 reviewer 无法完成且用户未授权降级。
- 同一失败项三轮窄修复仍不通过。
- 缺少外部凭证/环境，导致真实 package/Agent 核心行为无法判断。
- 用户要求暂停、改方向或终止。

## 8. Literal Goal Command

```text
/goal "执行 CodeStable feature 目录 .codestable/features/2026-07-17-agent-runtime-diagnostics 下的 goal 执行包。先读取 goal-protocol.md、goal-state.yaml、goal-plan.md、agent-runtime-diagnostics-design.md、agent-runtime-diagnostics-checklist.yaml；这是已由用户确认 design 后的 goal 模式。按 goal-protocol.md 连续执行 cs-feat implementation、cs-code-review、cs-feat QA、cs-feat acceptance；implementation 的代码行为 step 默认用 TDD micro-loop，必须留下 RED/GREEN/VERIFY evidence，不能 TDD 时写 TDD exception 和替代证据；review blocking 时做 review-fix 并重跑 review；QA failed / blocked 时做 qa-fix 并重跑 review 和 QA。只有当 CS_FEATURE_GOAL_COMPLETE 出现在 transcript 中，且 review passed、QA passed、acceptance passed、没有 CS_FEATURE_GOAL_HANDOFF，本 goal 才算完成。"
```
