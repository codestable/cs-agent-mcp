---
doc_type: feature-design-review
feature: 2026-07-19-shared-workspace-control-plane
status: passed
reviewed: 2026-07-19
round: 2
reviewer: claude-opus-4-8-high
reviewer_agent_id: 44fe0750-a021-437d-9e0a-27643f285484
---

# Workspace 共享控制面设计审查

## 结论

Round 2 verdict 为 `passed`。机器级按需 Broker、Workspace registry、有状态 transport bridge 和共享
root actor方案可实现；Round 1 的 blocking/important均已闭合。设计可交用户整体确认，确认前保持
`status: draft`，不得进入实现。

## Independent Review

- Provider/model：Claude `claude-opus-4-8`，thinking `high`，mode `plan`。
- Agent：`44fe0750-a021-437d-9e0a-27643f285484`。
- Round 1：`changes-requested`；发现 roots反向 SSE通道未 ready 时 SDK会静默丢弃 `roots/list`。
- Round 2：`passed`；通过 MCP SDK源码核验修订后的 reverse-ready路径正常可达，无死锁。

## Round 1 闭合项

| Finding                    | 结论   | 修订证据                                                                                    |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| B1 roots静默丢弃           | closed | 有状态 bridge、standalone GET SSE、`reverseChannelReady`、initialized+ready顺序、场景16/C04 |
| I1 根/managed HTTP混淆     | closed | 根 session使用 broker credential+SSE+迟绑定 actor；managed保留 Facade bearer                |
| I2 generation命名与grace锁 | closed | `brokerEpoch`；grace不释放/重取 Workspace lock；C10 token恒等                               |
| I3 成功标准覆盖缺口        | closed | 场景1/C06断言无 `FACADE_ALREADY_RUNNING`；C17锁定两个 v1 schema                             |
| I4 managed端点存活         | closed | S4/C09要求 A退出后 B继续 wait/操作长 Turn                                                   |

## Round 2 加固

- `reverseChannelReady` 等待增加有界 timeout；GET 405、SSE断开或通道永不建立时返回独立
  `BROKER_REVERSE_CHANNEL_UNAVAILABLE`，不无限挂起、不误报 roots非法。
- C04覆盖延迟与永不 ready；C18覆盖并发 session id隔离，避免 A/B reverse-ready串号。
- 场景16明确区分前端 GET SSE与 Host roots handler；全文统一“有状态桥接”术语。

## Spec 与 Checklist

- 17个验收场景均映射到 S0-S6和 C01-C18。
- 无 TBD、占位错误处理、“同上”步骤或未解释的 schema变更。
- 共享 Agent树、不同 Workspace隔离、首客户端退出、最后租约、Top跨 Workspace均有独立证据路径。

## Residual Risk

- 共享 root actor无法区分操作来自哪个根客户端；这是用户确认的同权协作语义。
- Broker继承首启动前端的 env/PATH；配置文件保持权威，Codex/Claude实机 QA核验。
- PID复用由 credential+健康握手缓解，不能只依赖 `kill(pid, 0)`。
- 未来若不用 SDK而手写 bridge，必须重新证明 GET SSE触发、405处理和 session id隔离。

## Test And QA Focus

1. 延迟 GET/roots与 GET 405/SSE断开分别验证成功路径和有界失败路径。
2. A/B并发 initialize时 reverse-ready严格按 `mcp-session-id` 隔离。
3. 双客户端测试同时断言单 Broker pid、单 Workspace lock token和共享 Agent ID。
4. A创建长 Turn后退出，B继续 wait；grace重连前后 lock token相等。
5. Broker/frontend SIGKILL、版本冲突、credential脱敏、同 pid多 Workspace Top/attach走真实多进程证据。

## 下一步

提交用户整体确认；用户明确批准后把 design状态改为 `approved`，再生成 goal package并进入实现。
