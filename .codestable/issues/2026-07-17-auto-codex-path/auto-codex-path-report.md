---
doc_type: issue-report
issue: 2026-07-17-auto-codex-path
status: confirmed
reported_at: 2026-07-17
severity: important
tags: [npm, codex, acp]
---

# Codex ACP 未自动复用本机 Codex

## 1. 问题摘要

从 npm 安装 `cs-agent-mcp@0.1.0` 后，在未手工设置 `CODEX_PATH` 的环境中启动 Codex
子 Agent，`codex-acp@0.0.44` 会使用其内置的旧版 Codex，而不是本机已登录、已验证的新版
`codex` 可执行文件。

## 2. 复现步骤

1. 从公开 npm registry 在隔离目录安装 `cs-agent-mcp@0.1.0`。
2. 保持本机 Codex 登录状态，但不设置 `CODEX_PATH`。
3. 通过 MCP 创建 Codex Agent 并发送真实 Turn。
4. 观察 Codex ACP 在 `app-server initialize` 阶段停滞；显式把 `CODEX_PATH` 指向本机
   Codex 后，同一调用成功。

## 3. 期望行为

当 `CODEX_PATH` 未显式配置时，Codex ACP 自动复用当前用户可执行路径中的本机 Codex；当用户
已经设置 `CODEX_PATH` 时必须保留该值。Windows 环境变量名按大小写不敏感处理，并允许解析
常见的 `.cmd` 包装器。

## 4. 根因与快速通道

`src/acp/client.ts` 的 ACP 启动计划只为 Claude 自动注入本机 CLI 路径，已有
`isCodexAcpCommand()` 尚未接入该流程，因此 `codex-acp` 收不到 `CODEX_PATH`。根因明确，修复
范围限定为可执行文件解析、启动环境注入、回归测试和用户文档；用户已于 2026-07-17 确认按
快速通道修复。
