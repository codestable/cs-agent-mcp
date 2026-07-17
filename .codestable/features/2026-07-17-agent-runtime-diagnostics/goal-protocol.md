---
doc_type: feature-goal-protocol
feature: 2026-07-17-agent-runtime-diagnostics
status: active
---

# Agent 运行状态诊断 CLI Goal Protocol

## 1. Recovery First

每次开始或恢复先读取 design、checklist、goal-plan、goal-state，再用仓库产物、checklist、ledger 和
`git log` 校正 state。已在 ledger 标为 done 且 commit 可见的 step 不重复执行；状态变化立即写回。

## 2. Execution Loop

1. `stage=implementation`：从首个 pending step 开始，按 `cs-feat` implementation 协议逐步完成。
2. 行为 step 默认执行 RED -> GREEN -> VERIFY TDD micro-loop；例外写
   `TDD exception: <原因 + 替代证据>`。缺证据时 implementation gate 不通过。
3. 每个 step 验证退出信号、清洁度和范围后，立即把 checklist 标为 done，提交独立 commit，并在
   `goal-state.yaml.ledger` 追加 step id、commit range、status、evidence。
4. S1-S5 完成并通过 implementation gates 后，生成 evidence pack，将 state 写为
   `stage: review` / `status: ready`。
5. 进入独立 `cs-code-review`，结论必须分开覆盖 spec 合规和代码质量。有 blocking/important 时写
   `stage: review` / `status: fixing`，只做 review-fix，修完回 review/ready 并重跑 review。
6. review passed 后写 `stage: qa` / `status: ready`，执行 `cs-feat` QA。QA failed/blocked 时写
   `stage: qa` / `status: fixing`，只做 qa-fix，修完必须回 review/ready，重跑 review 和 QA。
7. QA passed 后写 `stage: acceptance` / `status: ready`，执行 `cs-feat` acceptance，更新 checks、
   requirement、README/CHANGELOG/MCP architecture 和必要长期文档。
8. acceptance passed 且无 handoff 时，先写 `stage: complete` / `status: passed`，再输出
   `CS_FEATURE_GOAL_COMPLETE`。

## 3. Goal Mode Checkpoint Policy

Goal 模式接管 implementation/review/QA/acceptance 的普通人工 checkpoint：各阶段以报告、state 和
证据推进，不逐阶段停等。只有命中 handoff 条件才停止。不得绕过独立 review、QA 或 acceptance。

## 4. Step Discipline

- 严格按 S1 -> S5；一次只做当前 step，不提前合并后续行为。
- 新测试文件必须注册到硬编码 `package.json scripts.test`，以 runner 名称/计数证明执行。
- 公开 CLI、JSON/JSONL、selector、attach exit code、只读边界或 schema 若需改变，属于 design 变更，
  必须 handoff，不能在实现中自行决定。
- 每步检查 debug output、TODO/FIXME、注释旧代码、无用 import 和方案外文件。
- 每步独立 commit；不得 amend/rewrite S0 基线提交，不得 push、tag 或发布 npm。

## 5. Review And QA Minimums

- Review 必须使用可见独立 Task agent，合并 reviewer finding 前由 driver 本地核验。
- QA 必须实际执行 permission child 的 read/watch/kill/write-denied 四证据、lifecycle poison fixture、
  C14/C17 counting-reader 性能断言和临时 tarball 安装 smoke。
- 完整验证至少包括 `pnpm run check`、两个 help 命令和 package smoke；不能只跑定向测试。

## 6. Handoff

命中 design/范围/公开契约变更、独立 reviewer 阻塞、同项三轮失败、核心外部环境缺失或用户暂停时：

1. 写 `stage: handoff`、`status: blocked`、具体 `handoff_reason` 和 `handoff_next`。
2. 保留当前 step 的失败证据，不把它标为 done。
3. 输出：

```text
CS_FEATURE_GOAL_HANDOFF
Reason: <具体阻塞>
Next: <建议动作>
```

## 7. Completion

只有 review passed、QA passed、acceptance passed、checklist/长期文档同步且 state 已为 complete/passed
时，才能输出：

```text
CS_FEATURE_GOAL_COMPLETE
```
