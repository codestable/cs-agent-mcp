---
doc_type: issue-review
issue: 2026-07-17-auto-codex-path
status: passed
reviewer: subagent
reviewed: 2026-07-17
round: 2
---

# Codex 自动路径修复代码审查报告

## 1. Scope And Inputs

- Report: `.codestable/issues/2026-07-17-auto-codex-path/auto-codex-path-report.md`
- Fix note: `.codestable/issues/2026-07-17-auto-codex-path/auto-codex-path-fix-note.md`
- Evidence pack: none
- Gate results: none
- DoD results: none
- Implementation evidence: fix note、`pnpm run check`、隔离 tarball 安装和真实 Agent 调用
- Diff basis: 当前 unstaged diff + 本轮 issue 未跟踪文件；staged diff 为空
- Baseline dirty files: `.codestable/` onboarding 骨架属于本会话已确认基线，不作为业务代码 finding

### Independent Review

- Detection: Paseo subagent 和 OCR CLI 均可用；OCR LLM 连接测试通过
- 环节 A 独立隔离 Task agent: `paseo`，round 1 Agent
  `eefa287e-ea48-4811-96b8-c7d8d4df9a60`、round 2 Agent
  `8eb2d5a9-5699-4825-9dad-70e3465b12d9` 均 completed，Claude Opus `plan` 强制只读模式
- 环节 B OCR CLI: `skipped-scope-ambiguous`；未跟踪 `.codestable/` 同时包含 onboarding 基线和本轮
  issue 产物，OCR 不支持文件级 scope
- OCR severity mapping: High→blocking/important，Medium→nit/suggestion，Low→discarded
- Merge policy: 独立 reviewer 结果已逐条用仓库代码、依赖包源码和测试事实核验
- Gate effect: `REV-001` 已在 review-fix 中关闭，当前无 blocking/important

## 2. Diff Summary

- 新增：Codex 本机可执行文件解析、Codex ACP 启动识别和子进程环境注入、5 个 resolver 回归
  测试和 2 个 client 级 wiring 测试
- 修改：`src/acp/agent-command.ts`、`src/acp/client.ts`、`test/spawn-options.test.ts`、README、
  CHANGELOG、formatter 忽略范围
- 删除：none
- 未跟踪 / staged：CodeStable onboarding 与 issue 产物未跟踪；staged 为空
- 风险热点：跨平台进程启动环境和测试假阳性

## 3. Adversarial Pass

- 假设的生产 bug：resolver 正确但没有接入真实 `AcpClient` spawn 链路
- 主动攻击过的反例：删除 wiring、显式路径覆盖、Windows 小写环境变量、`.cmd` 启动、找不到本机
  Codex、非 Codex adapter 误注入、相对 PATH 条目
- 结果：round 1 的 wiring 假阳性升级为 `REV-001` 并已修复；round 2 对抗推演确认删除
  `codexAcp` 识别或环境注入任一段都会使测试失败。Windows `.cmd` 风险经
  `@agentclientprotocol/codex-acp@0.0.44` 源码确认使用 `shell: true` 后驳回；相对 Windows
  PATH 和 wiring fixture 的 POSIX 限定保留为 nit

## 4. Findings

### blocking

none

### important

- [x] REV-001 `test/spawn-options.test.ts:786` Codex ACP 识别与环境注入缺少 client 级测试
  - Resolution: 已新增两条 `resolveAgentLaunchPlan()` + `ensureLaunchSupport()` 组合测试，分别
    锁定自动注入和显式路径保留
  - Verification: round 2 reviewer 确认删除 `src/acp/client.ts:674` 的识别或
    `src/acp/client.ts:704` 的注入都会使断言失败；`pnpm run check` 共 190 项测试通过

### nit

- [ ] REV-002 `src/acp/agent-command.ts:414` Windows 相对 PATH 条目可能让注入值保持相对路径；
      实际 Windows PATH 通常为绝对路径，本轮不阻塞
- [ ] REV-003 `test/spawn-options.test.ts:786` client wiring fixture 按 POSIX 布置；若未来 CI 增加
      Windows runner，应补 Windows fixture 或让平台可注入。当前 CI/release 均为 Ubuntu，不阻塞

### suggestion

none

### learning

- 跨进程修复不能只测试 resolver；必须让测试覆盖命令识别、环境写入和 spawn 前时序
- `codex-acp@0.0.44` 在 Windows 用 `shell: true` 执行显式 `CODEX_PATH`，支持 `.cmd` 包装器

### praise

- 显式配置、Windows 大小写语义和子进程环境隔离边界清楚；改动没有污染宿主 `process.env`
- 注入放在唯一的 `AcpClient.start()` 链路中，覆盖内置安装和 package-exec 两种 Codex adapter

## 5. Test And QA Focus

- QA 必须重点复核：显式路径优先、非 Codex adapter 不注入、Windows `.cmd` 真实启动
- Evidence pack residual risks / gate warnings：Windows 实机未覆盖；Claude cold cache 下载耗时与本
  issue 无关
- 建议新增或加强的测试：Windows client wiring fixture、非 Codex adapter 负向注入测试
- 不能靠 review 完全确认的点：Windows 实机全链路、相对 PATH 条目

## 6. Residual Risk

- Windows `.cmd` 执行方式已由依赖源码确认，但仍缺 Windows 实机端到端验证
- POSIX 优先 `$HOME/.local/bin` 与 Claude 现有策略一致；该位置若残留旧版，会优先于 PATH
- Windows 相对 PATH 和 Windows client fixture 留待 Windows CI 接入时补强

## 7. Verdict

- Status: passed
- Next: issue 修复 gate 已通过，可进入提交/发布准备；本轮未获授权提交、推送或发布
