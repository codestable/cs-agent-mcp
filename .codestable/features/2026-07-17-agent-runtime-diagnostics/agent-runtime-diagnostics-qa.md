---
doc_type: feature-qa
feature: 2026-07-17-agent-runtime-diagnostics
status: passed
tested: 2026-07-18
round: 1
---

# Agent 运行状态诊断 CLI QA 报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-design.md`
- Checklist: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-checklist.yaml`
- Review: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-review.md`（round 5 passed）
- Evidence pack: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-evidence-pack.md`
- Gate results: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-gate-results.json`（passed）
- DoD results: `.codestable/features/2026-07-17-agent-runtime-diagnostics/agent-runtime-diagnostics-dod-results.json`（passed）
- Diff basis: `23bd73868624ea843807a602ba550e1c803aa63d..530f75b`；QA 仅新增机读 gate 与本报告
- Baseline dirty files: none
- Feature type: functional
- Core evidence gate: 无参数 stdio/13 工具、agents list/status/attach、selector/nested fail-closed、generation/drain、poison allowlist、250ms/stat gate、Node permission 四能力、tarball 安装 smoke、完整 check

## 2. Verification Matrix

| ID | 来源 | 核心性 | 场景 / 风险 | 证据类型 | 命令或动作 | 期望 | 结果 |
|---|---|---|---|---|---|---|---|
| QA-001 | design 1 / C03/C09 | core-functional | 无参数 stdio 与 13 工具兼容 | e2e/package | DoD `pnpm run check` + tarball smoke | 13 工具、无诊断污染 | pass |
| QA-002 | design 2-5 / C01/C04 | core-functional | 精确发现、nested 损坏、selector fail-closed | integration | directed diagnostics + CLI tests | 损坏实例 warning/拒绝，完整 UUID 可用 | pass |
| QA-003 | design 6-8 / C05/C06 | core-functional | history/cursor、replacement 隔离、stopped final drain | integration | directed diagnostics tests | 不跨 generation，末尾事件先于 stopped terminal | pass |
| QA-004 | design 9 / C02/C16 | core-functional | JSONL allowlist、thought/raw/details poison、文本截断 | integration | poison + terminal real-shape fixture | 仅 allowlist；poison 不出现；截断信号正确 | pass |
| QA-005 | design 10 / C08 | core-functional | permission child 可 read/watch/kill，不能 write | process | Node permission test + 四能力 probe | 三种只读能力 true；write ERR_ACCESS_DENIED | pass |
| QA-006 | design 11 / C14/C17 | supporting | 10k history、250ms、target stat gate、watch error | function | fake scheduler/counting reader test | history 有界；非目标不 parse；无忙循环 | pass |
| QA-007 | design 12 / C18 | core-functional | 临时 tarball 全局安装 | package/e2e | npm pack + isolated prefix install + smoke | agents 四命令与 13 工具 lifecycle 全绿 | pass |
| QA-008 | review REV-022 | core-functional | `details.runtimeCode` 单字段可见且 details poison 隐藏 | integration | diagnostics real-shape fixture | status/attach 可见 runtimeCode；cwd/agentId/details 不可见 | pass |
| QA-009 | DoD CMD-001 | core-functional | 全仓检查 | build/test/package | `pnpm run check`（独立 npm cache） | format/docs/type/lint/build/test/pack 全绿 | pass |
| QA-010 | DoD CMD-002/003 | supporting | 两层 help 命令 | CLI | DoD runner | 退出 0，命令树完整 | pass |
| QA-011 | scope/cleanliness | non-functional | 范围与施工痕迹 | gate/diff | scope gate、rg、git diff --check | 无越界、debug/TODO/FIXME/XXX、格式错误 | pass |

## 3. Command Results

- `codestable-scope-gate.py --stage qa ...` → exit 0：passed，blocking/warnings 均为空。
- `codestable-dod-contract-gate.py --stage qa ...` → exit 0：DoD Contract 结构通过。
- `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache codestable-dod-runner.py ...` → exit 0：三条 DoD 命令通过；`pnpm run check` 212/212 tests，pack dry-run 成功。
- `node --test --test-name-pattern="follows under node read-only permissions" dist-test/test/mcp-cli.test.js` → exit 0：1/1。
- Node permission 四能力 probe → exit 0：`{"read":true,"watch":true,"kill":true,"writeDenied":true}`。
- diagnostics 风险定向集 → exit 0：6/6（nested、generation、stopped drain、250ms/stat、poison、runtimeCode/text truncation）。
- `npm pack --pack-destination <qa-temp>` + `npm install --global --prefix <qa-temp>/install <tgz>` → exit 0：隔离安装 96 packages。
- 以安装后 binary 执行 `scripts/package-smoke.mjs` → exit 0：`{"toolCount":13,"lifecycle":"ok","diagnostics":"ok"}`。
- `git diff --check` → exit 0；cleanliness `rg` → 无匹配。

## 4. Scenario Results

- [x] QA-001 无参数 stdio 与 13 工具：pass
  - Evidence: 全量 MCP E2E + 安装产物 smoke。
- [x] QA-002 discovery/nested/selector：pass
  - Evidence: malformed Event、Agent error details、Turn pending permission 均使单实例不可读；selector fail-closed tests 通过。
- [x] QA-003 attach lifecycle：pass
  - Evidence: replacement 直接 terminal 且不输出新代 event；stopped 二次 final drain 先输出末尾 event。
- [x] QA-004 allowlist：pass
  - Evidence: thought/rawInput/content/location raw/details cwd/agentId/stack 均不可见；runtimeCode 单字段可见。
- [x] QA-005 permission：pass
  - Evidence: live attach 在无 fs-write 下跟随成功；显式 probe 四个布尔值均为 true。
- [x] QA-006 performance：pass
  - Evidence: fake scheduler 验证 25ms 不触发、250ms 才 wake；非目标 snapshot 不重读，目标更新只重读目标。
- [x] QA-007 tarball：pass
  - Evidence: npm tarball 安装后的真实 binary 完成 agents help/list/status/attach 与 13 工具 lifecycle。
- [x] QA-008 runtimeCode/details：pass
  - Evidence: 真实 `error.details.runtimeCode` shape；开放 details 袋未被展开。
- [x] QA-009/010/011 DoD 与清洁度：pass
  - Evidence: 机读 gate results、DoD results 与命令退出码。

## 5. Findings

### failed

- none

### blocked

- none

### residual-risk

- `error.details` 是开放字段袋；未来新增可见字段必须显式 allowlist 并补 poison 断言。
- replacement 优先保证 generation 隔离，无法恢复 token 变化前尚未观察到的旧代尾事件。
- stale PID 复用、跨平台 `fs.watch` 合并/丢通知和单次 O(snapshot file size) 解析为 design 已接受风险。
- QA 在 macOS/Node 22.22.2 完成；其他平台的 watcher 行为由 1s fallback 保证最终可见，未逐平台实测。

## 6. Cleanliness

- Debug output: pass
- Temporary TODO/FIXME/XXX: pass
- Commented-out code: pass
- Unused imports / dead code from this feature: pass
- Out-of-scope files: pass

## 7. Verdict

- Status: passed
- Next: `cs-feat` acceptance 阶段。
