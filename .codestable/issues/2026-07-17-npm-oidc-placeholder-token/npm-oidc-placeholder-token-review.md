---
doc_type: issue-review
issue: 2026-07-17-npm-oidc-placeholder-token
status: passed
reviewer: subagent+ocr
reviewed: 2026-07-17
round: 2
---

# npm OIDC 占位 token 修复代码审查报告

## 1. Scope And Inputs

- Fix note: `.codestable/issues/2026-07-17-npm-oidc-placeholder-token/npm-oidc-placeholder-token-fix-note.md`
- Evidence pack: none
- Gate results: none
- DoD results: none
- Implementation evidence: GitHub Actions run `29558153140` 两次失败日志、npm CLI `v11.16.0`
  源码、setup-node 源码、本地完整检查
- Diff basis: 当前 unstaged workflow diff 和未跟踪 issue 产物
- Baseline dirty files: none

### Independent Review

- Detection: 原生 Task agent 与 OCR CLI 均可用
- 环节 A 独立隔离 Task agent: native-agent，round 1 / round 2 completed
- 环节 B OCR CLI: round 1 / round 2 completed，0 comment
- OCR severity mapping: High->blocking/important，Medium->nit/suggestion，Low->discarded
- Merge policy: 两路结果均已逐条用 npm CLI `v11.16.0` 和 setup-node 源码核验
- Gate effect: `REV-001` 已在 review-fix 中关闭，无 blocking / important

## 2. Diff Summary

- 新增：OIDC 发布故障 fix-note
- 修改：从 `actions/setup-node@v6` 移除 `registry-url`
- 删除：none
- 未跟踪 / staged：fix-note 未跟踪；staged 为空
- 风险热点：npm Trusted Publishing 认证顺序与外部 registry 状态

## 3. Adversarial Pass

- 假设的生产 bug：删除传统 token 配置后，OIDC exchange 仍失败，发布只会从 `E404` 变为
  `ENEEDAUTH`
- 主动攻击过的反例：npm 已存在 fallback token、OIDC exchange 失败、pnpm cache 失效、默认 registry
  漂移、Trusted Publisher claim 不匹配
- 结果：npm CLI 源码证实 OIDC 先于 fallback token；round 1 升级的 `REV-001` 已通过修正文档
  定性和增加 verbose 证据关闭

## 4. Findings

### blocking

- [x] REV-001 `npm-oidc-placeholder-token-fix-note.md:19` 把占位 token 定性为阻止 OIDC exchange，
      与 npm CLI `v11.16.0` 的真实认证顺序矛盾
  - Evidence: `lib/commands/publish.js:143-148` 先调用 `oidc()`，再读取 registry credentials；
    `lib/utils/oidc.js:120-142` 在 exchange 成功后覆盖 token
  - Impact: 当前改动不能证明发布会成功，强制移动标签可能再次失败，且错误修复记录会误导后续排障
  - Expected fix scope: 将根因改为“OIDC exchange 失败且 fallback 掩盖原因”，下一次 runner 开启 npm
    verbose 日志；删除 `registry-url` 只能作为移除 fallback 的诊断改动
  - Resolution: fix-note 已纠正认证顺序，workflow 增加 `--loglevel verbose`；round 2 reviewer 核验
    通过

### important

none

### nit

- [x] REV-002 `npm-oidc-placeholder-token-fix-note.md:30` 默认 registry 描述遗漏仓库 `.npmrc` 的显式
      npmjs 配置
  - Resolution: fix-note 已写明 `.npmrc` 对默认 registry 和 `@types` scope 的两层保证

### suggestion

- 下一次 `npm publish` 增加 verbose 日志，确认出现 `Successfully retrieved and set token` 或取得
  exchange 的具体失败信息

### learning

- setup-node 的占位 token 会提供 fallback，但 npm `11.16.0` 仍会先尝试 OIDC；provenance 成功也不
  等价于 registry 接受 Trusted Publisher claims

### praise

- `id-token: write`、Node/npm 版本、tag/commit 元数据验证和重复发布跳过均已正确配置

## 5. Test And QA Focus

- QA 必须重点复核：runner verbose 日志中的 OIDC exchange 结果、Trusted Publisher 五项 claim、
  tag SHA 位于 `origin/main`
- Evidence pack residual risks / gate warnings：npm 网站外部配置无法从仓库独立确认
- 建议新增或加强的测试：无需新增单元测试；使用 tag 触发的真实 publish 作为功能验证
- 不能靠 review 完全确认的点：npm registry 是否接受当前 Trusted Publisher 配置

## 6. Residual Risk

- npm 网站上的 organization、repository、workflow、environment、allowed action 只能由真实 OIDC
  exchange 验证
- `.npmrc` 已显式锁定 npmjs，移除 setup-node 的 `registry-url` 不会改变 registry；`cache: pnpm`
  与认证配置是独立分支

## 7. Verdict

- Status: passed
- Next: 提交并推送 `main`，按用户授权更新 `v0.1.1` annotated tag，使用真实 runner 完成 OIDC
  exchange 和公开 registry 验证
