---
doc_type: feature-acceptance
feature: 2026-07-19-agent-wait-many
status: passed
accepted: 2026-07-19
round: 1
---

# Agent Wait Many 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-19
> 关联方案：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md`

## 1. 接口契约核对

- [x] `WaitManyMode`、`WaitManyReadyItem`、`WaitManyResult` 与 design 2.1 完全一致。
- [x] `waitMany`、`waitAny`、`waitAll` 均存在；两个便捷方法只固定 mode 后委托统一循环。
- [x] 正常示例 A ready/B running 返回 message + pending B；sibling 反例整批 `UNAUTHORIZED`。
- [x] 流程图节点均落到 `readWaitManyProjection`、`projectWaitMany`、`isWaitManyComplete`、deadline
      与 `waitForChange`。

## 2. 行为与决策核对

- [x] 多个 `cs_agent_send` 保持异步，调用方可先 fan-out，再用一个 wait-many fan-in。
- [x] 公开入口只有 `cs_agent_wait_many`；mode any/all，默认 any，raw 1-64 后保序去重。
- [x] 单 snapshot 原子验证所有 Turn；unknown/sibling 不返回部分 ready。
- [x] any 返回当前全部 ready；all 等待全部终态，但权限和 timeout 可中断。
- [x] 权限 Turn 保留在 pending；调用方按 Turn ID 累计并续等 `pendingTurnIds`。
- [x] timeout 不取消 Turn，单次最大 30 秒，retryAfter 与既有单 Turn 公式一致。
- [x] 每轮只有一个 store revision waiter，无 per-Turn timer/listener。
- [x] 明确不做均未出现：无 run/wait_any/wait_all MCP，无 callback/webhook/outbox，无 snapshot v2。
- [x] 挂载点反查完成：Facade/types/投影模块、MCP tools/capabilities/instructions、SDK E2E、package
      smoke/wrapper、CI/release、README/architecture/CHANGELOG 均在 design 2.3 清单范围内。
- [x] 拔除沙盘：移除 server 注册/capability/type/method/纯投影、相关测试与文档，再恢复 package
      smoke 的 13-tool 基线即可卸载；没有额外持久化 schema 或 runtime owner 残留。

## 3. 验收场景核对

- [x] S1/C03：any 一次返回多个 ready，pending 只含运行中 Turn，顺序按输入。
- [x] S2/C04：all 在首个 Turn 完成后仍未 settle，全部终态后返回完整 ready。
- [x] S3/S9/C04：权限立即返回 action_required 且仍 pending，响应后续等可累计完整结果。
- [x] S4/S12/C05：timeout 返回当前 ready/pending，不取消 Turn，续等后累计 A/B。
- [x] S5/C06：重复首次折叠；raw 空/65 项在 Facade 拒绝；MCP 额外校验 UUID/mode/waitMs。
- [x] S6/C07：unknown/sibling 整批失败，无部分泄漏。
- [x] S7/C02：waitAny/waitAll 与 waitMany 对应 mode 等价。
- [x] S8/C09：释放文件前两个不同 Agent Turn 均被观察为 running，再由 wait-many fan-in。
- [x] S10/C12：旧 13 tools、单 Turn wait/events、snapshot v1、Workspace 权限兼容。
- [x] S11/C03：message/terminal/action_required/running 混合投影保持输入顺序。
- [x] Review QA Focus：cancelled Permission 投影为 terminal；Windows batch 分支有回归。
- [x] QA 报告：功能性 feature，核心运行路径全部有 unit/integration/MCP SDK/tarball 证据；无
      failed/blocked。
- [x] Evidence pack / DoD / Gate：scope、contract、3/3 commands 全部 passed，无 warning。

## 4. 术语一致性

- Wait Many / Ready Item / Pending Turn / Any / All 在 types、Facade、工具描述和文档中一致。
- 公开工具使用 snake_case `cs_agent_wait_many`；Facade 编程接口使用 camelCase。
- 禁用公开名 `cs_agent_run`、`cs_agent_wait_any`、`cs_agent_wait_all` 无实现命中。

## 5. 领域影响盘点

- design 第 4 节将本能力定性为现有 Agent 编排接口深化，不新增领域实体或跨模块 ownership。
- 批量 fan-in、权限短路和有序 pending 语义已归并到 `docs/MCP_ARCHITECTURE.md`。
- 不满足新的 ADR 判据：没有新依赖、难回退存储决策或新的 Host delivery；未来主动唤醒另行设计。
- 结论：无需 `cs-domain` 新增 CONTEXT 术语或 ADR。

## 6. Requirement Delta / Clarification 回写

- design frontmatter 无 requirement，且第 4 节经 owner 批准明确“不新增 requirement”，本次是既有
  Agent 编排能力的接口深化。
- `.codestable/requirements/` 现有 current requirement 仅覆盖 diagnostics，本 feature 未改变其
  用户故事或边界。
- 结论：无需 requirement delta 或 current requirement 回写。

## 7. Roadmap 回写

- design frontmatter 无 `roadmap` / `roadmap_item`，本 feature 非 roadmap 起头。
- 结论：跳过 roadmap items 与主文档回写。

## 8. Attention.md 候选盘点

- 本 feature 未暴露每个后续 feature 都会重复踩到的新环境/命令陷阱。
- tarball smoke 的统一入口已写入 `package.json`、CI/release 与 AGENTS，无需另加 attention 短规则。
- 用户指南/API 变化已同步 README、MCP architecture 和 CHANGELOG，无未归并文档候选。

## 9. 遗留

- 后续优化：可在 Windows CI runner 执行完整 tarball E2E；当前 win32 batch 分支已有纯函数回归。
- 已知限制：高频无关 Workspace mutation 会增加 snapshot 重读；为批准设计接受的有界权衡。
- 调用方责任：权限/timeout 中断后按 Turn ID 累计 ready；已在工具 description/instructions/README
  明示，不实现 callback 或 outbox。
- 实现阶段顺手发现：none。

## 10. 最终审计

- 验证证据来源：`agent-wait-many-qa.md` + 独立 Paseo acceptance auditor。
- Auditor：Paseo Agent `c924bf1d-daae-492e-b528-fdff755d22b8`，Claude Opus，plan 只读；
  C01-C12 全 pass，verdict pass，无 blocking/important。
- Evidence sources：`implementation-evidence-pack.md`、`implementation-dod-results.json`、scope/DoD
  gate results。
- 聚合命令：final `pnpm run check` exit 0，267/267 passed；format/docs/typecheck/lint/build/pack
  全部通过；final `pnpm run package:smoke:tarball` exit 0，输出 `toolCount:14`、`waitMany:ok`、
  `lifecycle:ok`、`diagnostics:ok`。
- 场景复核：re-verified 12 / trust-prior-verify 0；全部核心场景由最终全量/定向/E2E/smoke 覆盖。
- 交付物复核：代码、schema、MCP 路由、package/CI、README、architecture、CHANGELOG 均存在；
  requirement/roadmap 按批准设计无需写入。
- 完整工作区复核：tracked/untracked 全部纳入 scope gate；无 staged diff；无 feature 外 dirty 文件。
- diff 清洁度：`git diff --check` 通过，无 debug/TODO/FIXME/XXX、无当前版本 tarball 残留。
- 知识沉淀出口：架构/用户/API 文档已归并，无 attention/compound/ADR 候选。
- Agent close：archived successfully after result consumption。
- 结论：通过。C01-C12、独立功能验收、最终全量检查和真实 tarball smoke 均满足。
