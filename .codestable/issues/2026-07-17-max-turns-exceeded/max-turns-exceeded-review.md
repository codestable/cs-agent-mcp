---
doc_type: issue-review
issue: 2026-07-17-max-turns-exceeded
status: passed
reviewer: subagent+ocr
reviewed: 2026-07-17
round: 3
---

# max-turns-exceeded 代码审查报告

## 1. Scope And Inputs

- Report: `max-turns-exceeded-report.md`
- Analysis: `max-turns-exceeded-analysis.md`
- Fix note: `max-turns-exceeded-fix-note.md`
- Implementation evidence: 134 项定向测试、198 项完整检查、真实 Claude ACP 验证
- Diff basis: 当前工作区 staged/unstaged/untracked diff
- Baseline dirty files: none；Paseo plan 模式复审前后工作区范围一致

### Independent Review

- Detection: Paseo subagent 与 OCR CLI 均可用
- 环节 A 独立隔离 Task agent: paseo `claude/opus` plan mode + completed
- 环节 B OCR CLI: completed
- OCR severity mapping: High→blocking/important，Medium→nit/suggestion，Low→discarded
- Merge policy: 两路结果已逐条本地核验后合并；OCR 唯一 Low finding 按规则丢弃
- Gate effect: none

## 2. Diff Summary

- 新增：本 issue report、analysis、fix-note、review
- 修改：错误归一化、MCP schema、四处测试、README、CHANGELOG
- 删除：none
- 未跟踪 / staged：issue 目录未跟踪；staged 为空
- 风险热点：公开错误码、prompt retry 判定、错误对象防御性解析、MCP schema

## 3. Adversarial Pass

- 假设的生产 bug：显式 retryable 元数据改变永久 ACP 错误的 prompt 级重试语义。
- 主动攻击过的反例：auth、permission、timeout、no-session、usage、max-turn、generic ACP
  internal、非 `RUNTIME` 携带 max-turn 文案、请求文本误命中、抛异常 getter、超长提示和 Facade
  code 映射测试假阳性。
- 结果：REV-001 至 REV-006 均真实关闭；未发现 blocking 或 important。

## 4. Findings

### blocking

none

### important

none

### nit

none

### suggestion

- 可后续补 options 来源的完整显式语义测试，以及白名单字段自身抛异常 getter 的测试。

### learning

- prompt retry 直接消费标准化 code/detailCode/retryable，可避免同一错误被两套分类条件分叉。

### praise

- 白名单字段和安全 getter 关闭了任意递归风险；Facade 测试真实覆盖 Turn、Agent、事件和 MCP
  四个公开表面，删除映射 wiring 会使测试失败。

## 5. Test And QA Focus

- QA 必须重点复核：真实 Claude 低上限仍公开 `MAX_TURNS_EXCEEDED`；普通 `-32603` internal
  error 仍可重试；非 `RUNTIME` code 不受 max-turn 文案改变。
- Evidence pack residual risks / gate warnings：已记录显式 retryable 与永久 ACP code 的理论边界。
- 建议新增或加强的测试：显式 `retryable: true` + 永久 ACP code；options 来源显式语义；白名单
  字段 getter。
- 不能靠 review 完全确认的点：上游未来是否提供专用 stop reason。

## 6. Residual Risk

- `isRetryablePromptError` 现在接受标准化后的显式 `retryable`。若未来 prompt 路径同时产生
  `retryable: true` 与永久 ACP code，需明确是公开可恢复语义还是同 session 重放语义；当前两处
  retry 循环收的是无该元数据的原始 ACP error，因此不可达。
- `data.details` 仍依赖上游载荷契约；如果未来开始回显用户 prompt，应改为专用结构化 subtype。

## 7. Verdict

- Status: passed
- Next: issue 修复收尾提交。
