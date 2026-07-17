---
doc_type: issue-fix
issue: 2026-07-17-npm-oidc-placeholder-token
path: fast-track
fix_date: 2026-07-17
tags: [npm, oidc, github-actions]
---

# npm OIDC fallback 掩盖发布失败修复记录

## 1. 问题描述

`v0.1.1` 触发的 GitHub Actions 已通过发布元数据、完整检查、tarball 隔离安装和版本占用检查，
但两次都在 `npm publish` 阶段返回权限型 `E404`。第二次运行前已在 npm 包设置中建立与
`codestable/cs-agent-mcp`、`release.yml` 匹配的 Trusted Publisher，错误仍未变化。

## 2. 根因

npm CLI `11.16.0` 会先尝试 OIDC token exchange，再回退到已有 registry credentials。当前能够
确认的是 OIDC exchange 没有产生可用的短期 token；具体被拒原因仍需 verbose runner 日志验证。

`.github/workflows/release.yml` 给 `actions/setup-node@v6` 传入 `registry-url`，使该 action 生成
临时 npm 配置并注入占位 `NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX`。OIDC exchange 失败后，
npm CLI 回退到这个无效 token 继续发布，最终只显示权限型 `E404`，掩盖了 exchange 的原始失败
信息。占位 token 是误导性 fallback，不是阻止 OIDC exchange 的原因。

runner 实际使用 Node.js `24.18.0` 和 npm `11.16.0`，已经满足 npm Trusted Publishing 对
Node.js 和 npm CLI 的最低版本要求；workflow 也直接执行 `npm publish` 并具有
`id-token: write`，因此这些不是本次失败原因。

## 3. 修复方案

从 `actions/setup-node@v6` 配置中移除 `registry-url`，清除无效传统 token fallback；仓库
`.npmrc` 已显式将默认 registry 和 `@types` scope 固定到 `https://registry.npmjs.org/`，因此
registry 不会漂移。发布命令增加 `--loglevel verbose`，下一次 runner 必须明确记录 OIDC exchange
成功，或输出 registry 返回的具体失败信息。

这一步是让认证路径和错误证据变得确定，不在真实 exchange 成功前宣称 Trusted Publishing 已修复。

## 4. 改动文件清单

- `.github/workflows/release.yml`
- `.codestable/issues/2026-07-17-npm-oidc-placeholder-token/npm-oidc-placeholder-token-fix-note.md`

## 5. 验证结果

- 失败基线：GitHub Actions run `29558153140` 的两次尝试均在 `npm publish` 返回 `E404`，且
  发布步骤环境包含 setup-node 生成的临时 npm 配置和占位 `NODE_AUTH_TOKEN`。
- npm CLI `v11.16.0` 源码核验：`publish.js` 在读取 fallback credentials 前调用 `oidc()`；
  `oidc.js` 在 exchange 成功后覆盖发布 token，确认原先的认证顺序判断错误并已修正文档。
- workflow YAML 通过 Ruby 标准 YAML 解析。
- `pnpm run check` 通过，共 190 项测试通过；构建、lint、类型、文档、格式和
  `npm pack --dry-run` 均通过。
- `git diff --check` 通过；最终 tarball shasum 仍为
  `919aa5baf6d936f9f256725ea2ebdc0e1e8b2018`。
- 待标签更新后验证：verbose 日志出现 `Successfully retrieved and set token`、GitHub Actions 发布
  `cs-agent-mcp@0.1.1`，并从公开 registry 做空 cache 冷安装。若 exchange 仍失败，以 verbose
  原始信息继续修正 npm 网站的 Trusted Publisher 配置。

## 6. 遗留事项

- `v0.1.1` 已推送但 npm `0.1.1` 尚未发布；用户已明确授权将 annotated tag 更新到本修复提交。
- OIDC exchange 只能在 GitHub-hosted runner 上真实验证；当前提交是可观测的诊断修复，是否完成
  发布闭环以 runner exchange 与公开 registry 结果为准。
