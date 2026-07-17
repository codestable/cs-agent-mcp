---
doc_type: issue-fix
issue: 2026-07-17-auto-codex-path
path: fast-track
fix_date: 2026-07-17
tags: [npm, codex, acp]
---

# Codex ACP 自动复用本机 Codex 修复记录

## 1. 问题描述

已发布的 `cs-agent-mcp@0.1.0` 在未设置 `CODEX_PATH` 时，会让
`@agentclientprotocol/codex-acp@0.0.44` 使用适配器内置 Codex。该旧版本在当前 provider
环境中停在 `app-server initialize`，必须手工指定本机新版 Codex 才能完成真实 Turn。

## 2. 根因

`AcpClient` 的启动计划已有 Claude ACP 识别和 `CLAUDE_CODE_EXECUTABLE` 自动注入，但没有接入
已有的 `isCodexAcpCommand()`，也没有为 Codex 解析本机 CLI 并注入 `CODEX_PATH`。因此问题发生
在通用 ACP 启动层，而不是 MCP CLI 或 Facade 层。

## 3. 修复方案

- 在 `src/acp/agent-command.ts` 新增 `resolveCodexExecutable()`：POSIX 优先
  `$HOME/.local/bin/codex` 后查 `PATH`；Windows 使用可接受 `.cmd`、`.exe` 的命令解析。
- 显式 `CODEX_PATH` 始终优先，Windows 环境变量名按大小写不敏感判断。
- 在 `AcpClient` 启动计划中识别 Codex ACP，并在启动 adapter 前把解析结果写入子进程环境。
- 更新安装说明和未发布更新日志；CodeStable 受管运行资产加入 formatter 忽略范围，避免项目
  检查改写 package-owned 文件。

## 4. 改动文件清单

- `src/acp/agent-command.ts`
- `src/acp/client.ts`
- `test/spawn-options.test.ts`
- `README.md`
- `CHANGELOG.md`
- `package.json`
- `.oxfmtrc.jsonc`
- `.codestable/issues/2026-07-17-auto-codex-path/auto-codex-path-report.md`
- `.codestable/issues/2026-07-17-auto-codex-path/auto-codex-path-fix-note.md`

## 5. 验证结果

- 失败基线：新增测试最初因缺少 `resolveCodexExecutable` 无法编译，确认覆盖实际缺口。
- 定向回归：`spawn-options` 42 项通过；5 项 resolver 测试覆盖 POSIX、用户目录优先级、
  Windows `.cmd/.exe`、显式路径和 Windows 大小写语义，2 项 client 级测试覆盖内置 Codex
  ACP 识别、自动环境注入和显式路径保留。
- Round 1 review-fix：独立 reviewer 指出的 wiring 测试假阳性已修复；删除识别或注入链路会使
  client 级断言失败。
- 完整检查：`pnpm run check` 通过，共 190 项测试通过；构建、lint、类型、文档、格式和
  `npm pack --dry-run` 均通过。
- 隔离安装：从最终 `0.1.1` 源码生成 `cs-agent-mcp-0.1.1.tgz`，使用空 npm cache、匿名 public
  registry 和独立 global prefix 安装成功；安装后二进制版本为 `0.1.1`，MCP SDK 确认 13 个
  工具及基础生命周期正常。tarball SHA-1 为
  `919aa5baf6d936f9f256725ea2ebdc0e1e8b2018`。
- 真实 Codex：子进程明确删除 `CODEX_PATH`，`@agentclientprotocol/codex-acp@0.0.44` 经自动
  解析的包装路径调用本机 `codex-cli 0.144.4 app-server`，返回 `CODEX_AUTO_PATH_OK`。
- 真实 Claude：同一隔离安装通过本机已登录的
  `@zed-industries/claude-agent-acp@0.20.2` 和 Claude Code `2.1.142` 返回
  `CLAUDE_REAL_INSTALL_OK`。

## 6. 遗留事项

- 发布必须由 `v0.1.1` tag 触发 GitHub Actions trusted publishing；本机不直接使用 npm token。
- Windows 行为已由文件系统回归测试覆盖，但本轮没有 Windows 实机验证。
- 全新 cache 首次下载 Claude ACP 的 Darwin 平台 SDK 在当前网络下超过 180 秒；该下载耗时与
  本次 Codex 路径修复无关，真实 Claude 调用已使用本机现有 ACP adapter 单独验证。
