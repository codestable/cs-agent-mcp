---
doc_type: feature-qa
feature: 2026-07-19-shared-workspace-control-plane
status: passed
tested: 2026-07-19
---

# Workspace 共享控制面 QA

## 结论

17 个场景与 C01-C18 全部通过。自动化、真实多进程、tarball、完整会话 TUI、Codex/Claude 双 Host 与
最终清理均有独立证据，当前实现没有功能测试失败。

## 自动化与黑盒证据

- `pnpm run check`：255/255 通过；format、docs、typecheck、lint、build、test、pack dry-run 全绿。
- 独立 Task agent 定向复验 Broker、E2E、lock、Facade、runtime：62/62 通过，53.68 秒。
- TUI PTY：top、ps、keyboard、SGR mouse、resize、完整 conversation attach、terminal restore 全部
  `ok`。
- tarball：`/tmp/cs-agent-mcp-pack.D6Suzs/cs-agent-mcp-0.2.3.tgz`。
- 临时安装 binary：`/tmp/cs-agent-mcp-install.vYnYfR/bin/cs-agent-mcp`。
- MCP SDK smoke：`toolCount=13`、lifecycle `ok`、diagnostics `ok`。
- 独立 SDK 黑盒复验：grace 重连 lock token 稳定、最后 frontend SIGKILL 后完整清理、延迟
  roots 成功、reverse-ready 永不触发时约 5005ms 返回专用错误。
- TUI Attach 直接投影既有 runtime session record 的 user/agent/thinking/tool call/result；redacted
  thinking 不携带原始 payload，Facade event 不进入会话视口，慢读取保持 single-flight。
- 挂起 `readConversation` 时按 `q` 会先恢复终端并完成退出，不等待不可取消的读取；独立定向复验
  diagnostics/TUI 26/26、`agents attach --json` 公开契约 3/3 通过。

## 场景结果

| 场景  | 结果 | 关键证据                                                                                               |
| ----- | ---- | ------------------------------------------------------------------------------------------------------ |
| 1-3   | pass | 双 stdio SDK client 共享 Agent 树并交叉 list/status/wait/cancel/events/create/destroy；A 退出后 B 继续 |
| 4     | pass | 并发启动只有一个 ready Broker 与 Workspace owner                                                       |
| 5-6   | pass | roots 顺序归一化、不同 roots 隔离、无 roots capability 与非法 roots 分支通过                           |
| 7-8   | pass | grace 重连 token 恒等；正常退出与 SIGKILL lease 清理通过                                               |
| 9     | pass | Broker SIGKILL 后 persistent session 恢复；缺失 session 返回 `SESSION_RESUME_REQUIRED`                 |
| 10    | pass | 活跃旧协议 owner 不被关闭；inactive owner 延迟释放真实锁后 replacement 成功                            |
| 11    | pass | descriptor/lock 权限、401、credential 脱敏与 argv/log/snapshot/diagnostics 边界通过                    |
| 12-13 | pass | 同 Broker pid 双 Workspace 的 list/status/attach/top；diagnostics 不启动或连接 Broker                  |
| 14    | pass | tarball 临时安装、13 tools、无参数 stdio、help 与 PTY 通过                                             |
| 15    | pass | 真实 Codex/Claude 根并行连接同一 Broker；Claude 跨根管理 Codex 创建的 Agent，pid/token 稳定            |
| 16    | pass | Host roots 延迟 1500ms，超过 750ms grace 后仍复用 Broker pid 与 lock token                             |
| 17    | pass | GET 405、SSE disconnect、never-ready timeout 均返回 `BROKER_REVERSE_CHANNEL_UNAVAILABLE`               |

## Checklist 结果

- C01-C18：全部 `done`；C13 同时覆盖 Top Attach 完整会话与 diagnostics 只读边界。
- C16 的真实 Host 交叉管理与 Pi/通用 runtime capability 边界均有证据。
- 两个 v1 schema 与 reverse-ready session 隔离均通过。

## 真实 Host 证据

- 当前 Agent shell 的 `CODEX_API_KEY` / `OPENAI_API_KEY` 会遮蔽用户本机 auth；只对验收子进程
  unset 后，Codex 0.144.5、provider `sub2api` fresh 返回 `OK`。
- Codex 禁用既有全局 `cs-agent`，只加载当前 `dist/mcp-cli.js`；Claude 使用 strict MCP config 和
  `claude-opus-4-8`，两者均真实调用当前构建的 13 tools。
- Codex 创建 Agent `b6c45bd8-60c3-4863-a1f3-9be0b94beb21`；Claude 跨根 list/status/send/cancel/
  wait/destroy，Turn `a8f4a7fd-e82b-4b33-8922-2c65c41ab4e6` 最终为 `cancelled`。
- 严格并行复验中，Codex interactive 根保持连接，Claude 跨根 status/destroy Agent
  `7554290b-f2ee-4a0c-b2fc-48c77c6eaa93`。前后 Broker pid 均为 27871，Workspace lock token 均为
  `052072e9-5332-435b-b6b8-a7c2f2f1bb0c`。
- 最后 Codex 根正常退出后，diagnostics 为 `agents=[]`、Broker pid 退出、descriptor 与 Workspace
  lock 均释放。

## 最终验证

- 最终 fresh `pnpm run check`：255/255 通过，pack dry-run 成功。
- tarball 临时安装的 MCP SDK smoke 返回 `toolCount=13`、lifecycle/diagnostics `ok`；PTY 全项 `ok`。
- 独立 Task agent `/root/shared_workspace_acceptance` 判定完整会话 Attach、只读边界、公开契约、场景
  15/C16 及 overall acceptance 为 `pass`。
