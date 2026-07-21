---
doc_type: issue-review
issue: 2026-07-21-managed-claude-mcp-identity-collision
status: passed
reviewer: subagent+ocr
reviewed: 2026-07-21
round: 3
---

# 受管 Claude MCP 身份入口冲突代码审查报告

## 1. Scope And Inputs

- Report：`managed-claude-mcp-identity-collision-report.md`
- Analysis：`managed-claude-mcp-identity-collision-analysis.md`
- Fix note：`managed-claude-mcp-identity-collision-fix-note.md`
- Implementation evidence：TDD RED/GREEN、280/280 全量 check、tarball smoke、全局安装态真实
  Codex/Claude 审查与 Claude→Codex 递归 E2E
- Diff basis：当前 unstaged/untracked issue diff；所有 dirty 文件均可归因于本 issue
- Baseline dirty files：none

### Independent Review

- Detection：原生独立 Task agent、通过最终全局 `cs-agent-mcp` 创建的真实 Codex/Claude reviewer、
  `ocr` CLI 均可用。
- 环节 A 独立隔离 Task agent：completed。Round 1 找到 `npm run exec` / `pnpm run dlx` false positive；
  Round 2 找到 pnpm `-w` / `dlx -c` arity 与未知 option false positive；两轮均先补 RED 后修复。
  最终隔离 HOME/全新 Broker 的 Codex、Claude 均返回 `SPEC PASS / CODE PASS`。
- 环节 B OCR CLI：completed；最终 review-fix 后 0 comment。
- OCR severity mapping：High→blocking/important，Medium→nit/suggestion，Low→discarded。
- Merge policy：所有外部 finding 均经当前源码、测试和真实命令反例核验；批准范围外的 wrapper 缺口归入
  residual risk。
- Gate effect：none。

## 2. Diff Summary

- 新增：`src/mcp/transport/claude-user-mcp.ts` 及本 issue 的 report/analysis/fix-note/review。
- 修改：`src/mcp/transport/workspace-facade.ts`、`src/mcp/facade/facade.ts`、
  `test/mcp-broker.test.ts`、`README.md`、`CHANGELOG.md`。
- 删除：none。
- 未跟踪：新 helper 与 issue 产物；staged：none。
- 风险热点：用户配置解析、managed/root 身份隔离、ACP 同名 MCP 覆盖顺序、恢复路径一致性。

## 3. Adversarial Pass

- 假设的生产 bug：package-manager option/subcommand 解析发生 false positive 或 false negative，使无关
  MCP 被覆盖，或合法控制面继续保留 root identity。
- 主动攻击过的反例：`npm run exec`、`pnpm run dlx`、`pnpm -w dlx`、`pnpm dlx -c`、未知独立值
  option、`other-mcp` 后续参数、Windows shim、配置损坏、HTTP/unknown wrapper、自定义 Claude agent、
  create/resume/discard recovery、非 Claude runtime。
- 结果：两项 important 均已由 RED/GREEN 关闭；最终独立双审与 OCR 未发现新的 blocking/important。

## 4. Findings

### blocking

none

### important

none

### nit

none

### suggestion

none

### learning

- package-manager argv 不能共用 option arity；同名短选项在 npm 与 pnpm、subcommand 前后可能有不同
  语义。未知独立 option 必须返回不确定并 fail-open，不能向后猜 target。

### praise

- 用户配置只提取冲突名称，不复制、不持久化；安全 alias 最后追加并复用当前 Agent bearer。
- create、dormant resume、discard recovery 三条路径统一传入持久化 `agent.agent`，Claude 判定基于
  registry 的实际 ACP command，而非显示名。

## 5. Test And QA Focus

- 已完成：`pnpm run check` 280/280、tarball 临时安装 14 tools smoke、最终全局安装包双 reviewer、
  未限定 namespace 的真实 Claude→Codex 递归与 parent/depth 断言。
- 建议后续保持：ACP adapter 升级时复核 session MCP 后项覆盖 user MCP 的归并方向。
- 不能靠 review 完全确认：Windows 实机行为，以及 design 明确排除的未知 shell/custom wrapper。

## 6. Residual Risk

- 只自动识别直接命令与已支持的 npx/npm/pnpm 形式；未知 shell/custom wrapper、bunx/yarn 等继续
  fail-open，这是批准 analysis 的明确边界。
- 只读取 `~/.claude.json` 顶层 user-scope；project/local scope 冲突不在本 issue 范围。
- 用户配置只在 Workspace Facade 启动时读取一次；热变更需要完整重启对应控制面。
- 修复不迁移历史上已持久化成 sibling 的 Agent；Windows shim 有单测但无 Windows 实机 E2E。

## 7. Verdict

- Status：passed。
- Next：issue 修复已满足提交前 gate；等待 owner 决定是否 commit/push/release。
