---
doc_type: approval-report
unit: 2026-07-19-shared-workspace-control-plane
status: superseded
reason: blocker
created_at: 2026-07-19
---

# Approval Report

## Decision History

- 2026-07-19：上一轮在同一 blocker 连续三次后进入 handoff。owner 随后恢复 Goal；这会重新开始
  blocked audit，但不授权修改 credential、终止旧 Host 或豁免 C16。
- 2026-07-19：恢复后的第二轮复核确认旧 Workspace owner 已退出；真实 Claude Host 可连接新版 MCP
  并枚举 13 tools，但 Codex provider 返回 401、Claude provider 返回 503，仍无法执行双 Host 调用。
- 2026-07-19：确认验收 shell 注入的 API 环境变量遮蔽用户本机 Codex auth；隔离这些覆盖后 Codex
  与 Claude 均可用。C16 真实并行与跨 Host lifecycle 通过，独立验收 verdict 为 `pass`，本审批失效。

## Decision Needed

无需 owner 决策。原 blocker 已通过环境隔离和真实验收闭合。

## Why Now

原报告用于记录 RepeatedBlocker strict owner-stop。新增证据证明失败来自验收 shell 的环境覆盖与重复
MCP 配置，并非用户本机 provider 或产品实现；因此该 checkpoint 已被最终通过结果 supersede。

## Context

- 隔离 Agent shell 注入的 API 环境变量后，Codex provider fresh 返回 `OK`；Claude Opus 4.8 也正常。
- Codex 与 Claude 根并行连接当前构建，共享 Broker pid 27871 与不变 lock token。
- Claude 跨根管理 Codex 创建的 Agent，完成 list/status/send/cancel/wait/destroy。
- 最后租约离开后 Broker、descriptor 与 Workspace lock 均清理。
- 独立验收对场景 1-17 与 C01-C18 全部判定 `pass`。

## Options

无待选项；历史选项均被真实 C16 passing evidence 取代。

## Recommendation

关闭本 checkpoint，按原验收契约完成 Goal，不豁免任何场景。

## Risks And Tradeoffs

- 保留历史失败记录，避免后续把 Agent shell 环境覆盖误诊为用户 credential 失效。
- 共享 actor 不持久化 client identity，这是批准的同权协作语义；Host 来源由 transcript 与时间线证明。

## Non-Automatic Actions

不会修改 credential 或 provider 账户，不会 commit、push、打 tag、发布 npm 或升级版本，也不会把
C16 的 MCP 握手部分成功静默等同于完整通过。

## After You Answer

无需后续回答。发布与版本动作仍需 owner 单独明确授权。
