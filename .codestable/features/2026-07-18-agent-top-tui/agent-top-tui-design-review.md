---
doc_type: feature-design-review
feature: 2026-07-18-agent-top-tui
status: passed
reviewer: subagent
reviewed: 2026-07-18
round: 2
---

# Agent 实时监控 TUI 设计审查

## 结论

Round 2 为 `passed`。Round 1 的终端注入、真实 PTY/tarball E2E、异步任务所有权、stale merge、
过滤子状态、测试注册和信号清理问题均已落实为显式设计与 DoD，可进入实现。

## Round 2 核验

- renderer 边界统一净化 CSI、OSC、DCS、C0/C1、双向控制符和多行输入，并要求 no-format 输出。
- E2E 明确使用隔离 HOME、tarball 临时安装和真实 PTY，覆盖键盘、SGR mouse、resize、Attach、
  Esc/q、cooked/echo 与 alternate-screen/cursor/mouse 恢复。
- list epoch 与 attach generation/pump 的所有权、失效和 shutdown 收束规则完整。
- 单 snapshot warning 的 stale rows、filter draft/committed、SIGTERM 143 与测试注册均有验收锚点。
- `--all` 仅决定初始值，运行期间仍可用 `a` 切换；Esc 在 attach pump 收束后立即刷新。

## Blocking

1. **缺少终端输出净化契约。** Agent name/cwd/event summary 虽经过 diagnostics allowlist，仍可能
   含 CSI、OSC 52、DCS、C0/C1、换行或 tab，破坏布局、剪贴板或终端恢复。renderer 必须在显示
   边界做独立净化，no-format 输出，并覆盖控制序列、NUL、换行、CJK/emoji poison fixture。
2. **真实 PTY 与 tarball TUI smoke 没有可执行证据路径。** DoD 必须提供脚本/命令：隔离 HOME、
   从 tarball 安装、启动真实 PTY、发送键盘和 SGR mouse、resize、进入 managed Attach、Esc/q，
   并验证退出后 cooked/echo/cursor/alternate screen 恢复。

## Important

1. 用 session epoch + pump promise 定义 list/attach 异步任务所有权；旧 epoch 的在途结果必须丢弃，
   shutdown 要等待或隔离 pending task。
2. terminal-kit adapter 每进程只创建一次；清理顺序为停止业务任务、自有 listener/timer、退出
   fullscreen、恢复 cursor、关闭 mouse/raw。库内部 process listener 作为残余风险记录。
3. 单个 snapshot warning 时按 instanceId 保留上一成功 rows 并标 stale，不能让选中 Agent 突然消失。
4. filter 必须有 navigation/filter-editing 子状态和 draft/committed 值，q 在编辑中只能作为正文。
5. 新测试文件必须显式注册进 `tsconfig.test.json` 和 package test command，防止只编译不执行。
6. 运行接口明确 stderr 所有权；raw Ctrl-C、SIGINT 与 SIGTERM 进入统一 shutdown，SIGTERM 保留非零语义。

## Nit 与建议

- checklist steps 增加稳定 ID，矩阵直接引用。
- 命令公开支持 `--all`。
- terminal-kit 在 top/ps action 中动态加载，默认 stdio MCP 不加载 TUI CJS 依赖。
- 表格行不换行，timeline 可安全换行；窄屏优先保留 STATE/RUNTIME/NAME。
- acceptance 回写 requirements/VISION.md 的 diagnostics 状态。

## 下一步

按 checklist 实现并以真实 tarball PTY E2E、完整 check、package smoke 和独立代码审查收口。
