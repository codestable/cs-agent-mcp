---
doc_type: issue-fix
issue: 2026-07-18-attach-root-empty-timeline
path: fast-track
fix_date: 2026-07-18
tags: [diagnostics, cli, attach]
---

# attach root 仅显示创建事件修复记录

## 1. 问题描述

用户从 `agents list` 选择唯一可见的 Agent 后执行 `agents attach`，文本输出只包含 idle snapshot
和一条重复的 `agent.created agent.created`，无法判断为什么没有任务输出。

## 2. 根因

目标 UUID 对应 Facade 自动创建的 `root` 调用者身份，而不是通过 `cs_agent_create` 创建的
`managed` runtime。该 root 从未运行 Turn，snapshot 中只有 `agent.created`。诊断 DTO 已包含
`kind`，但 `src/mcp-cli.ts` 的 list、status 和 attach 文本视图没有展示它，也没有解释 root 不承载
受管 runtime，导致正确但低信息量的时间线被误认为 attach 丢失输出。

## 3. 修复方案

- list 文本表格拆分 `KIND` 与 `RUNTIME`，明确展示 `root` / `managed`。
- status 和 attach snapshot 文本展示 kind；attach root 时说明其是 MCP caller identity，没有
  managed runtime 输出，并引导选择 managed Agent。
- `agent.created` 使用 `created` 作为文本动作摘要，避免重复整串类型，同时不改写其他事件正文。
- JSON/JSONL DTO、Facade schema、事件跟随和只读行为保持不变。

## 4. 改动文件清单

- `src/mcp-cli.ts`
- `test/mcp-cli.test.ts`
- `README.md`
- `CHANGELOG.md`
- `.codestable/issues/2026-07-18-attach-root-empty-timeline/attach-root-empty-timeline-fix-note.md`

## 5. 验证结果

- 失败基线：新增 CLI 回归测试最初在 `AGENT ID  KIND  RUNTIME` 断言处失败，实际输出仍为
  `AGENT ID  TYPE`，确认测试覆盖用户看到的缺口。
- 定向测试：root/managed 文本诊断测试通过，覆盖 list、status、attach root 提示和重复 summary。
- 完整检查：`pnpm run check` 通过，共 213 项测试通过；格式、文档、类型、lint、构建和
  `npm pack --dry-run` 均通过。
- 真实数据：使用修复后的 `dist/mcp-cli.js` attach 用户提供的 root UUID，输出明确标记
  `root codex idle`、root 说明和 `agent.created created`；Ctrl-C 正常输出 `terminal interrupted`
  并返回 0。

## 6. 遗留事项

- attach 仍是 Facade 事件的只读诊断工具，不能读取宿主 Codex/Claude 客户端自身的对话记录。
- 本次未改变 root Agent 的发现范围，以保持既有诊断设计和 JSON 公共契约。
