---
doc_type: issue-review
issue: 2026-07-19-agent-top-conversation-visibility
status: passed
reviewer: subagent
reviewed: 2026-07-19
round: 2
---

# agent-top-conversation-visibility 代码审查报告

## 1. Scope And Inputs

- Report、analysis、fix-note：本 issue 目录对应工件
- Diff：diagnostics conversation lookup/projection、TUI controller/renderer/types、测试、PTY E2E 与用户文档
- Baseline：wait-many、prompt-timeout 和 shared Workspace 既有 dirty 改动不归本 issue
- Evidence：TDD、真实历史读取、真实 tarball PTY、`pnpm run check`、tarball smoke

### Independent Review

- 环节 A：当前全局安装的 CS Agent MCP 创建 Claude 与 Codex oneshot reviewer，Round 2 均 completed
- Claude：Agent `87057add-b717-49d0-aa87-cdca3d971fea`，Turn
  `14f2a1be-f1e5-4b1b-8e15-a5775e30e3a3`，`VERDICT: PASS`
- Codex：Agent `1438b5e1-3ce3-4428-8b54-0e64e5478aa3`，Turn
  `817a4616-2a00-4477-b0fc-c39c5d2dbcee`，`VERDICT: PASS`
- OCR：`skipped-scope-ambiguous`，工作树包含其他既有未提交 scope
- Merge：所有 finding 已按源码与测试本地核验；Round 1 测试假阳性已修，Round 2 无 blocking/important

## 2. Diff Summary

- oneshot session records 使用编码后的完整 root+agent+`:oneshot:` 前缀枚举，内容再次校验 record id
- 多个 oneshot record 按 `createdAt`、`acpxRecordId` 稳定合并；persistent 固定 record 不变
- Attach 明确 loading/waiting/ready/unavailable，读取异常和 stopped 缺失记录不再无限 loading
- 各 conversation item 使用独立标题与正文；未读按 item、视口按渲染行计算

## 3. Adversarial Pass

- 攻击过跨 Agent 前缀碰撞、冒名/损坏 record、ENOENT 竞态、旧 refresh 覆盖新 attach、长工具名、
  控制字符、redacted thinking、暂停滚动与 resize。
- 完整 record id 前缀与二次内容校验阻止串读；损坏记录整体 fail closed。
- controller 的 generation guard、唯一 refresh pump 和 attach 模式周期刷新阻止陈旧覆盖，并允许
  running `waiting -> ready`。

## 4. Findings

### blocking

none

### important

none

### nit

none

### suggestion

- 大量 oneshot 历史未来可设计分页或上限；本次按用户要求优先展示完整原生上下文。

### learning

- oneshot Agent 的会话身份是一个稳定 Agent 前缀下的多 record 集合，diagnostics 不能套用 persistent
  的单 record 假设。

### praise

- 会话只读投影继续复用 runtime 原生记录，没有建立第二份历史。
- 标题与正文分行后，长工具名不再挤占 payload 空间，状态与内容边界更明确。

## 5. Test And QA Focus

- diagnostics/TUI：30/30
- 全量：`pnpm run check` 277/277；diagnostics/TUI 定向 30/30
- PTY tarball：top、ps、键盘、鼠标、resize、attach、terminal restore 全 ok
- 真实历史：`aa263d17` 与 `e3cae6f8` 均 `found:true`
- 全局安装 hash：`1af40bdc9dc0ade35423394fc4336b1c4d392c9c0156d37cfb0d942a0299c8f2`

## 6. Residual Risk

- oneshot 历史数量很大时首次 Attach 会读取全部 records，可能增加延迟和内存；当前是完整上下文优先。
- 单个损坏 record 会让整段合并失败并显示 unavailable；这是防止混合可信/不可信历史的 fail-closed 选择。
- 原生记录已被删除时只能显示不可用状态，无法恢复不存在的内容。

## 7. Verdict

- Status: passed
- Next: issue 验收与收尾；不自动 commit、push、tag 或发布
