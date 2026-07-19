---
doc_type: feature-qa
feature: 2026-07-19-agent-wait-many
status: passed
tested: 2026-07-19
round: 1
---

# Agent Wait Many QA 报告

## 1. Scope And Inputs

- Design：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md`
- Checklist：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-checklist.yaml`
- Review：`.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-review.md`，Round 2 passed
- Evidence pack：`.codestable/features/2026-07-19-agent-wait-many/implementation-evidence-pack.md`
- Gate results：scope/DoD contract/evidence pack passed，无 warning
- DoD results：`implementation-dod-results.json`，review 后 fresh 3/3 passed
- Diff basis：当前 unstaged/untracked feature diff；review 后产品代码未变化
- Baseline dirty files：none；全部非忽略改动可归因本 feature
- Feature type：functional
- Core evidence gate：公开 MCP 14 tools、Facade any/all、权限与 timeout 中断、原子隔离、单 waiter、
  真实多进程 barrier fan-out/fan-in、tarball 临时安装 smoke

## 2. Verification Matrix

| ID     | 来源        | 核心性          | 场景 / 风险                                 | 证据类型             | 命令或动作      | 期望                               | 结果 |
| ------ | ----------- | --------------- | ------------------------------------------- | -------------------- | --------------- | ---------------------------------- | ---- |
| QA-001 | C01/C02/C10 | core-functional | 14 tools、单 MCP 入口、Facade wrappers      | contract/integration | CMD-001/CMD-003 | 仅新增 wait_many，wrappers 等价    | pass |
| QA-002 | C03/C06     | core-functional | any 全部 ready、有序去重、raw/MCP 边界      | unit/integration     | CMD-003         | ready/pending 输入序，非法输入拒绝 | pass |
| QA-003 | C04/C05     | core-functional | all 权限/timeout 中断并跨轮累计             | unit/e2e             | CMD-003         | 不取消 Turn，续等后累计完整        | pass |
| QA-004 | C07         | core-functional | unknown/sibling 原子失败                    | security regression  | CMD-003         | 整批失败且无部分泄漏               | pass |
| QA-005 | C08         | core-functional | 单 revision waiter                          | instrumented unit    | CMD-003         | peak waiter 为 1                   | pass |
| QA-006 | C09         | core-functional | 多 Agent 真实多进程并发                     | MCP SDK E2E          | CMD-003         | barrier 释放前两个 Turn 均 running | pass |
| QA-007 | C10         | core-functional | 实际 tarball 临时安装和 wait-many           | package smoke        | CMD-002         | 14 tools 且实际生命周期成功        | pass |
| QA-008 | C11/C12     | supporting      | 无额外公开工具/schema v2，旧行为兼容        | diff/full regression | CMD-001 + diff  | 无范围扩张，旧测试全绿             | pass |
| QA-009 | Review      | supporting      | cancelled Permission 不误报 action_required | unit                 | CMD-003         | terminal_without_message           | pass |
| QA-010 | Review      | supporting      | Windows `.cmd/.bat` spawn 分支              | unit                 | CMD-001         | 仅 win32 batch 启用 shell          | pass |

## 3. Command Results

- `pnpm run check` → exit 0：267/267 passed；format/docs/typecheck/lint/build/pack 全部通过。
- `pnpm run package:smoke:tarball` → exit 0：实际 `npm pack`、临时 prefix 安装、版本/帮助、MCP SDK
  生命周期均通过；输出 `toolCount:14`、`waitMany:ok`、`lifecycle:ok`、`diagnostics:ok`。
- `pnpm run build:test && node --test dist-test/test/mcp-facade.test.js dist-test/test/mcp-e2e.test.js`
  → exit 0：52/52 passed，0 skipped。
- 未运行：真实 Windows runner。当前主机为 macOS；设计核心路径由实际 POSIX tarball smoke 与 win32
  command option 单测覆盖，Windows 实机属于非阻塞平台 residual risk。

## 4. Scenario Results

- [x] QA-001/002 any、all、wrappers、边界与顺序：pass。
  - Evidence：Facade 与 MCP contract/integration tests。
- [x] QA-003 权限/timeout 两轮累计：pass。
  - Evidence：权限响应续等、timeout 后续等、cancelled permission 终态回归。
- [x] QA-004 越权整批失败：pass。
  - Evidence：unknown 与 sibling actor 回归均返回既有错误，无部分结果。
- [x] QA-005 单 waiter：pass。
  - Evidence：计数 store 断言 `peakWaiters=1`。
- [x] QA-006 多进程 fan-out/fan-in：pass。
  - Evidence：MCP SDK 在创建 release file 前观察两个不同 Agent Turn 均为 running。
- [x] QA-007 tarball 用户路径：pass。
  - Evidence：安装包 binary + SDK 实际调用 wait-many，随后 destroy 与 diagnostics 验证成功。
- [x] QA-008 兼容性与范围：pass。
  - Evidence：267/267 全量回归与 scope gate；snapshot v1 未修改。

## 5. Findings

### failed

none。

### blocked

none。

### residual-risk

- Windows batch 启动路径已由纯函数分支测试覆盖，但未在 Windows runner 执行完整 tarball E2E；不属于
  批量等待核心语义，后续 CI matrix 可补强。
- 高频无关 Workspace mutation 会增加全 snapshot 重读次数；批准设计已明确接受该有界权衡。

## 6. Cleanliness

- Debug output：pass。
- Temporary TODO/FIXME/XXX：pass。
- Commented-out code：pass。
- Unused imports / dead code from this feature：pass，type-aware lint 通过。
- Out-of-scope files：pass，scope gate 覆盖全部 dirty/untracked feature 文件。
- Package artifacts：pass，fresh wrapper 清理当前版本 tarball 与临时安装目录。

## 7. Verdict

- Status：passed。
- Next：进入 `cs-feat` acceptance 阶段，由独立 Task agent 按 C01-C12 做终端功能验收。
