---
doc_type: feature-implementation-evidence
feature: 2026-07-19-agent-wait-many
status: passed
updated: 2026-07-19
---

# Agent Wait Many Implementation Evidence

## Baseline

- Baseline ref：`73a52d29ae0dabf9af854d3d8f47211f4dca0d6b`
- codebase-memory MCP：`index_repository` 返回 `Transport closed`，按仓库约定降级为源码只读搜索。
- 定向基线在 driver 写入 S1 RED 前的既有用例全部通过；新增 contract 预期 14 tools，而实际仍为
  13，产生目标 RED `13 !== 14`。
- 中断的 native goal driver `/root/wait_many_goal_driver` 未完成 step；其唯一落盘改动是 S1 RED
  contract test，主线程保留后接管。

## S1 契约骨架

退出信号：`cs_agent_wait_many` 可发现，instructions 明示多 Turn fan-out/fan-in，输入边界和返回
形状测试仅因批量语义尚未实现而失败。

TDD 证据：

- Step: S1
- 行为：MCP 公开 14 个工具并提供统一 wait-many schema 与编排提示。
- RED：`MCP server exposes all facade tools and returns structured create results`；实际 13，预期 14。
- GREEN：`types.ts` 增加 Wait Many 类型；Facade capabilities 与 MCP server 注册
  `cs_agent_wait_many`，更新 initialize/send/single-wait descriptions。
- VERIFY：目标 Node test 1/1 passed；TypeScript test build passed。
- REFACTOR：无。
- 需求迭代：无，完全位于 approved design S1。

影响面：`src/mcp/facade/types.ts`、`src/mcp/facade/facade.ts`、
`src/mcp/transport/server.ts`、`test/mcp-facade.test.ts`。

清洁度：无调试输出、TODO/FIXME、注释死代码或方案外修改。Facade 入口暂时返回明确未实现错误，
作为 S2 RED 起点，不进入最终交付。

## S2 批量投影

退出信号：any 即时结果、空输入、重复、unknown/sibling 越权与 timeout 返回形状定向测试通过。

TDD 证据：

- Step: S2
- 行为：单 snapshot 原子验证后，有序投影 message、terminal、permission 与 running。
- RED：`MultiAgentFacade wait many projects mixed ready and pending turns in input order` 返回
  `RUNTIME_FAILURE: Wait many is not implemented`。
- GREEN：新增 `wait-many.ts` 纯投影；Facade 对 raw 1-64 先校验再去重，在一次 store read 内完成
  全部 Turn 的存在性、可见性、Message/Permission 解析和投影。
- VERIFY：`--test-name-pattern='wait many'` 4/4 passed；覆盖混合结果、输入顺序、重复、raw
  边界、unknown/sibling 整批失败、timeout 字段和不取消 Turn。
- REFACTOR：把计算从 2300+ 行 Facade 文件分离到同模块纯函数，未复制鉴权或终态规则。
- 需求迭代：无。

影响面：新增 `src/mcp/facade/wait-many.ts`，实现 `MultiAgentFacade.waitMany` 的即时投影。

清洁度：目标文件无 debug/TODO/FIXME/XXX；`git diff --check` 通过，无方案外修改。

## S3 并发等待

退出信号：all 的权限与 timeout 中断均可通过两轮等待累计完整结果，any 同轮收集多个 ready、
wrappers 等价，可计数 store 证明每轮只调用一次 waitForChange。

TDD 证据：

- Step: S3
- 行为：`waitAll` 通过 revision long-poll 等到全部终态，`waitAny` / `waitAll` 固定 mode 委托
  `waitMany`。
- RED：TypeScript 编译报 `Property 'waitAll' does not exist on type 'MultiAgentFacade'`。
- GREEN：`waitMany` 增加 deadline/revision 循环；每轮一次 snapshot read 与一次
  `waitForChange`；增加两个薄 wrapper。
- VERIFY：目标测试 9/9 passed；all 第一个 Turn 完成后仍 pending，第二个完成后返回；权限短路后
  续等覆盖 action_required；timeout 后续等累计 A/B；3-Turn batch 的 `peakWaiters=1`。
- REFACTOR：无。
- 需求迭代：无。

影响面：`MultiAgentFacade.waitMany`、`waitAny`、`waitAll` 和可计数 FacadeStore 测试装饰器。

清洁度：未增加 timer/listener per Turn、debug 输出或临时分支；无关 revision 唤醒后允许进入下一轮。

## S4 发布契约

退出信号：文件 barrier 释放前两个 Turn 同时 running，权限响应续等 E2E、`pnpm run check` 和实际
tarball 14 tools/wait-many smoke 全部通过，定向测试有非零通过数。

TDD 证据：

- Step: S4
- 行为：从 npm tarball 临时安装后的真实 binary 暴露 14 tools，并实际执行 wait-many 生命周期。
- RED：`pnpm run package:smoke:tarball` 返回 `ERR_PNPM_NO_SCRIPT`。
- GREEN：新增自包含 Node wrapper；package smoke 改为调用 `cs_agent_wait_many`；CI 与 release
  复用同一入口；mock agent 新增可取消文件 barrier；SDK E2E 覆盖并发与权限续等。
- VERIFY：
  - 真实多进程 E2E `wait many fans in concurrent ACP turns and resumes after permission` 1/1 passed；
    barrier 释放前两个 Turn 均为 running。
  - CMD-003 两个完整目标文件 51/51 passed，0 skipped。
  - `pnpm run check` 最终 265/265 passed，format/docs/typecheck/lint/build/pack 均通过。
  - `NPM_CONFIG_CACHE=/tmp/cs-agent-mcp-npm-cache pnpm run package:smoke:tarball` 输出
    `toolCount:14`、`waitMany:ok`、`lifecycle:ok`、`diagnostics:ok`。
- REFACTOR：抽取 Facade 文件内 snapshot 投影 guard，降低 `waitMany` 圈复杂度；行为测试 10/10
  和全量检查复验通过。
- 需求迭代：无。

影响面：MCP SDK E2E、mock ACP barrier、package smoke/wrapper、CI/release、README、AGENTS、
MCP 架构和 CHANGELOG 未发布区。

清洁度：wrapper 在 `finally` 删除 tarball 与临时 prefix；最终未发现 `0.2.4.tgz` 或临时安装目录。
目标文件无 debug/TODO/FIXME/XXX；历史 CHANGELOG 中 13 tools 保持历史事实，当前文档均为 14。

## Final Audit

- S1-S4 全部 done；C01-C12 留给 review/QA/acceptance 逐项判定。
- 公开新增仅 `cs_agent_wait_many`；没有 `cs_agent_run`、`cs_agent_wait_any`、
  `cs_agent_wait_all`、callback、webhook、outbox 或 snapshot v2。
- 新概念与 design 术语一致：Wait Many、Ready Item、Pending Turn、Any/All。
- 方案外触碰：无。release workflow 复用 tarball wrapper 是 design review FDR-001 suggestion 的窄修复。
- 首次全量 check 的 lint 问题已窄修复；第二次全量测试曾出现既有 protocol mismatch teardown
  `ENOTEMPTY` 竞态，隔离复测 1/1 和下一次完整 check 265/265 均通过。
- 知识候选：无需要提升为项目级 convention 的新规则。

## Review Fix Round 1

- REV-001 RED：新增 `MultiAgentFacade waitAll projects terminal after cancelling a pending permission`，
  首次得到 `action_required`，预期 `terminal_without_message`。
- REV-001 GREEN：`readPendingPermission` 只接受非终态 Turn 且 `Permission.state === "pending"`；投影
  顺序调整为 message → terminal → action_required。定向回归 1/1 passed。
- REV-002：新增 `scripts/package-command-spawn.mjs` 与 `test/package-spawn.test.mjs`；Windows
  `.cmd/.bat` 使用 `shell: true`，POSIX 和非 batch command 保持无 shell。package spawn 回归 1/1
  passed。
- tarball SDK smoke 改为通过 Node 启动安装包内 `dist/mcp-cli.js`，同时保留 binary 参数注入；避免
  MCP SDK 在 Windows 直接无 shell spawn `.cmd`。
- 修复后 fresh `pnpm run check`：267/267 passed，format/docs/typecheck/lint/build/pack 全部通过。
- 修复后 fresh `pnpm run package:smoke:tarball`：临时安装成功，输出 `toolCount:14`、
  `waitMany:ok`、`lifecycle:ok`、`diagnostics:ok`。

Implementation gates：scope gate passed、DoD contract gate passed、DoD runner 3/3 commands passed、
evidence pack passed。Round 1 blocking/important 已窄修复，可以进入独立代码复审。
