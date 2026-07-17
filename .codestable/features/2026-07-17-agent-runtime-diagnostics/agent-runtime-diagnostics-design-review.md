---
doc_type: feature-design-review
feature: 2026-07-17-agent-runtime-diagnostics
status: passed
reviewed: 2026-07-17
round: 3
---

# agent-runtime-diagnostics feature design 审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Intent / brainstorm: none
- Roadmap: none
- Related docs: requirement、VISION、`docs/MCP_ARCHITECTURE.md`
- Code facts checked: CLI、Facade snapshot/event/store、process lock、entrypoint、runtime event、test/package smoke scripts

### Independent Review

- Status: completed
- Detection: paseo
- Provider / agent: `providers.audit` -> `claude/opus`，`e75cce08-ce2e-4b11-8a8b-7255cd39ad63`
- Raw output: FDR-011/012/013 closed；round 2 nit closed；无新增 blocking/important
- Merge policy: 已逐条用 design、checklist 和代码事实核验；reviewer 已归档
- Gate effect: none

## 2. Design Summary

- Goal: 提供 `cs-agent-mcp agents list|status|attach` 本地只读诊断 CLI，无参数继续直接启动 stdio MCP。
- Key contracts: snapshot/lock 观察、不连接 HTTP；selector 全集解析；稳定 DTO 与事件 allowlist；
  watcher + fallback + final drain；Node permission model 证明 live attach 无写能力。
- Steps: S0-S5；先隔离既有 `max-turns-exceeded` 改动，再实现 CLI、读模型、查询、跟随和交付。
- Checks: C01-C18，全部为 pending，覆盖测试注册、stream fail-closed、性能 seam 和 tarball smoke。
- Baseline / validation: 198 测试基线；设计文档格式、Markdown、YAML 与 diff whitespace 已通过。

## 3. Findings

### blocking

none

### important

none

### nit

- [ ] FDR-017 poison fixture 除 text delta 外，至少再覆盖一个 lifecycle 事件的未知字段与 request 原文，证明总括 allowlist 同样 fail-closed。

### suggestion

- [ ] FDR-018 README/help 说明文本表格显示短 UUID 前缀，JSON 恒返回完整 UUID。

### learning

- Facade 内部消费可信内存事件时可用 `stream !== "thought"`，诊断 mapper 面对不可信磁盘 snapshot
  必须反向使用 `stream === "output"` allowlist；不能复制内部聚合条件。
- 显式测试文件清单属于验证证据链的一部分，新增测试文件必须注册并证明实际执行。

### praise

- live readonly 使用 OS capability gate，而不是会被正常 writer 干扰的前后 hash 断言。
- follower 的计数 reader/fake clock 留在内部 seam，公开 AgentDiagnostics 接口保持稳定和窄小。

## 4. User Review Focus

- 用户需要重点拍板：attach 会展示目标 Agent 的 output 和有界工具摘要；不展示 thought、raw tool
  payload、Permission request 或其他 Agent 消息。
- implement 需要重点遵守：S0 基线隔离、精确文件发现、selector 全集规则、event mapper exhaustive、
  final drain、测试注册和 tarball smoke。
- code review / QA / acceptance 需要重点复核：permission 四证据、lifecycle poison、C14/C17 parse 上界、
  PID 复用与跨平台 watcher residual。

## 5. Evidence Confidence Ledger

| Check                         | Verdict | Evidence Class | Basis                                                                  | Follow-up             |
| ----------------------------- | ------- | -------------- | ---------------------------------------------------------------------- | --------------------- |
| Acceptance Coverage Matrix    | pass    | E              | 12 个场景均映射到 step、证据和命令                                     | 下游执行              |
| DoD Contract                  | pass    | E              | Design/Impl/Review/QA/Accept 与 artifacts 完整                         | none                  |
| Steps and checks traceability | pass    | E              | S0-S5、C01-C18 可回到 design 契约                                      | none                  |
| Roadmap contract compliance   | n/a     | E              | 无 roadmap                                                             | none                  |
| Module interface design       | pass    | C              | 稳定 DTO、窄 persistence/lock probe、内部 follower seam                | implementation review |
| Validation and artifacts      | pass    | C              | test registration、permission gate、fake clock、package smoke 均有落点 | QA 留证               |

Summary: E=4, C=2, H=0, H-only core checks=none。

## 6. Residual Risk

- PID 复用可能让 stale lock 暂时误报 running；诊断路径不清 stale lock。
- v1 snapshot 整体 JSON 与无界事件使 parse 保持 O(file size)，只能限制重读频率。
- 目录 watcher 会被其他 workspace 唤醒且跨平台有延迟差异，stat gate + 1s fallback 只保证最终可见。
- `package-smoke.mjs` 当前尚未覆盖 agents 子命令，必须在 S5 实现并由 C18 验证。
- 性能场景非 core，但 C14/C17 仍受 DOD-IMPL-001 约束，QA/acceptance 必须核对真实执行结果。

## 7. Verdict

- Status: passed
- Next: 交给用户整体 review；design 保持 `draft`，不得自动批准或进入实现。
