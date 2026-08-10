---
status: observed
scope: GitHub Actions / npm Trusted Publishing / OIDC
date: 2026-08-10
---

规则：使用 npm Trusted Publishing 时保留 `id-token: write` 并直接执行带 verbose 日志的 `npm publish`；不要为 `actions/setup-node` 配置 `registry-url`，也不要注入 `NODE_AUTH_TOKEN`，否则 OIDC exchange 失败后可能回退到占位 token，掩盖原始认证错误。
适用 / 不适用：适用于 GitHub-hosted runner 上的 npm OIDC trusted publishing；使用真实 npm token、私有 registry 或非 GitHub OIDC 发布时不直接套用，应按对应认证模型配置。
证据：`.github/workflows/release.yml`；`AGENTS.md`；`afaef87` 及 `07b965783c1d8198d3f8c818b0aec9616ab63a5e:.codestable/issues/2026-07-17-npm-oidc-placeholder-token/npm-oidc-placeholder-token-fix-note.md`。
候选归宿：checker
