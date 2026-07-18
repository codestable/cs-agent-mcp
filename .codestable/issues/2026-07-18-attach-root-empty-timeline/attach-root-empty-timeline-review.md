---
doc_type: issue-review
issue: 2026-07-18-attach-root-empty-timeline
status: passed
reviewer: ocr
reviewed: 2026-07-18
round: 1
---

# attach root 仅显示创建事件代码审查报告

## 1. Scope And Inputs

- Issue fix-note: `.codestable/issues/2026-07-18-attach-root-empty-timeline/attach-root-empty-timeline-fix-note.md`
- Implementation evidence: 用户确认的快速通道范围、失败基线、完整检查和真实 UUID 复验
- Diff basis: 当前工作区 `git status --short` 与 `git diff`
- Baseline dirty files: none

### Independent Review

- Detection: 当前宿主提供 Task-agent 能力，但会话策略要求用户显式授权后才能启动；OCR CLI 可用
- 环节 A 独立隔离 Task agent: local-only + skipped-by-user
- 环节 B OCR CLI: completed，扫描结果为 0 comments
- OCR severity mapping: High→blocking/important，Medium→nit/suggestion，Low→discarded
- Merge policy: OCR 结果与主 agent 本地整体、行级和对抗式审查合并核验
- Gate effect: 用户明确接受 `OCR+self` 降级

## 2. Diff Summary

- 新增：issue fix-note、review 报告
- 修改：`src/mcp-cli.ts`、`test/mcp-cli.test.ts`、`README.md`、`CHANGELOG.md`
- 删除：none
- 未跟踪 / staged：issue 目录未跟踪，其余实现和文档未暂存
- 风险热点：用户可见文本 CLI；不涉及 JSON API、Facade schema、权限、数据写入或并发逻辑

## 3. Adversarial Pass

- 假设的生产 bug：通过比较 `summary === type` 推断 fallback，可能误改内容恰好等于事件类型的真实
  runtime 文本
- 主动攻击过的反例：`turn.text_delta` 的正文为字面量 `turn.text_delta`；root/managed 类型切换；
  stopped attach 终态；JSONL 分支
- 结果：通用 summary 转换在 review 中被收窄为仅处理 `agent.created`，并增加真实文本保留断言；
  最终 diff 无 blocking 或 important finding

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

- Facade 的 root Agent 是调用者身份，不是 managed runtime；诊断文本必须显式展示 `kind`，否则
  即使底层状态完全正确，用户也会把空时间线判断为数据丢失。

### praise

- 修复只消费 DTO 既有字段，不扩大持久化或 JSON allowlist；回归测试同时证明 root 提示和 managed
  runtime 正文不被 summary 格式化误改。

## 5. Test And QA Focus

- QA 必须重点复核：`agents list --all` 的 `KIND/RUNTIME` 列、root status、running root attach 提示、
  managed Agent 的正常历史和 live follow
- Evidence pack residual risks / gate warnings：none
- 建议新增或加强的测试：none
- 不能靠 review 完全确认的点：不同终端宽度下文本表格的视觉对齐不属于本次正确性范围

## 6. Residual Risk

- attach 仍不能读取宿主 Codex/Claude 客户端自身对话；README 与 root 提示已明确该产品边界。

## 7. Verdict

- Status: passed
- Next: issue 修复进入提交收尾
