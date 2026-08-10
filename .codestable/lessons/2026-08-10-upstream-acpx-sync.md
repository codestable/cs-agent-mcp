---
status: observed
scope: acpx 上游同步 / ACP runtime / MCP 公开契约
date: 2026-08-10
---

规则：同步 `acpx` 时固定 release、commit SHA 与 tarball integrity，先把上游差异逐项标为直接接受、语义适配、范围外拒绝或本地已覆盖，再先移植回归测试、后移植实现；不得整目录覆盖 `src/acp/`、`src/runtime/`，也不得借同步静默改变 14 个 MCP tools、Facade snapshot、权限模型或 Workspace owner 等本地公开契约。
适用 / 不适用：适用于吸收 `acpx` registry、ACP client、session、runtime、spawn/auth/permission 修复；若变更要求引入 `acpx` CLI 产品面、修改持久化 schema 或无法保留本地安全不变量，应停止普通同步并转 feature 或 ADR。纯本仓库功能开发不套用此流程。
证据：`AGENTS.md`；`CHANGELOG.md` 的 `0.3.0`；`4bf34eb` 及 `07b965783c1d8198d3f8c818b0aec9616ab63a5e:.codestable/compound/2026-07-20-acpx-upstream-sync.md`。
候选归宿：project-doc
