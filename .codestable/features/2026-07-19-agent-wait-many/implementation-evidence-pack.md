---
doc_type: feature-evidence-pack
feature: 2026-07-19-agent-wait-many
status: generated
---

# 2026-07-19-agent-wait-many evidence pack

## 1. Scope

- Design: `.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md`
- Checklist: `.codestable/features/2026-07-19-agent-wait-many/agent-wait-many-checklist.yaml`

## 2. DoD Results

```json
{
  "gate_id": "dod-runner",
  "stage": "implementation",
  "status": "passed",
  "blocking": [],
  "warnings": [],
  "evidence": [
    {
      "command": "pnpm run check",
      "exit_code": 0,
      "stdout": "PATH ordering finds a shim first\nok 251 - resolveClaudeCodeExecutable prefers a native sibling when PATH ordering finds a shim first\n  ---\n  duration_ms: 1.293125\n  type: 'test'\n  ...\n# Subtest: resolveWindowsExecutablePath follows a wrapper to a native entrypoint\nok 252 - resolveWindowsExecutablePath follows a wrapper to a native entrypoint\n  ---\n  duration_ms: 2.42375\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable returns undefined when CLAUDE_CODE_EXECUTABLE is already set\nok 253 - resolveClaudeCodeExecutable returns undefined when CLAUDE_CODE_EXECUTABLE is already set\n  ---\n  duration_ms: 1.100958\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable respects case-insensitive env var on Windows\nok 254 - resolveClaudeCodeExecutable respects case-insensitive env var on Windows\n  ---\n  duration_ms: 1.127042\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable finds an executable Claude CLI on POSIX PATH\nok 255 - resolveClaudeCodeExecutable finds an executable Claude CLI on POSIX PATH\n  ---\n  duration_ms: 2.038792\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable prefers the official POSIX user install over PATH\nok 256 - resolveClaudeCodeExecutable prefers the official POSIX user install over PATH\n  ---\n  duration_ms: 3.332875\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable ignores a non-executable Claude file on POSIX PATH\nok 257 - resolveClaudeCodeExecutable ignores a non-executable Claude file on POSIX PATH\n  ---\n  duration_ms: 1.448584\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable preserves an explicit POSIX Claude executable\nok 258 - resolveClaudeCodeExecutable preserves an explicit POSIX Claude executable\n  ---\n  duration_ms: 1.30825\n  type: 'test'\n  ...\n# Subtest: resolveClaudeCodeExecutable returns undefined when claude is not on PATH\nok 259 - resolveClaudeCodeExecutable returns undefined when claude is not on PATH\n  ---\n  duration_ms: 0.213083\n  type: 'test'\n  ...\n# Subtest: resolveCodexExecutable finds an executable Codex CLI on POSIX PATH\nok 260 - resolveCodexExecutable finds an executable Codex CLI on POSIX PATH\n  ---\n  duration_ms: 1.206125\n  type: 'test'\n  ...\n# Subtest: resolveCodexExecutable prefers the POSIX user install over PATH\nok 261 - resolveCodexExecutable prefers the POSIX user install over PATH\n  ---\n  duration_ms: 3.657084\n  type: 'test'\n  ...\n# Subtest: resolveCodexExecutable accepts Windows command shims and native executables\nok 262 - resolveCodexExecutable accepts Windows command shims and native executables\n  ---\n  duration_ms: 5.318542\n  type: 'test'\n  ...\n# Subtest: resolveCodexExecutable preserves an explicit CODEX_PATH\nok 263 - resolveCodexExecutable preserves an explicit CODEX_PATH\n  ---\n  duration_ms: 1.6155\n  type: 'test'\n  ...\n# Subtest: resolveCodexExecutable respects case-insensitive CODEX_PATH on Windows\nok 264 - resolveCodexExecutable respects case-insensitive CODEX_PATH on Windows\n  ---\n  duration_ms: 1.24975\n  type: 'test'\n  ...\n# Subtest: AcpClient injects the resolved CODEX_PATH into built-in Codex ACP launches\nok 265 - AcpClient injects the resolved CODEX_PATH into built-in Codex ACP launches\n  ---\n  duration_ms: 3.870833\n  type: 'test'\n  ...\n# Subtest: AcpClient preserves an explicit CODEX_PATH for built-in Codex ACP launches\nok 266 - AcpClient preserves an explicit CODEX_PATH for built-in Codex ACP launches\n  ---\n  duration_ms: 3.213584\n  type: 'test'\n  ...\n# Subtest: package smoke enables a shell only for Windows command wrappers\nok 267 - package smoke enables a shell only for Windows command wrappers\n  ---\n  duration_ms: 0.555917\n  type: 'test'\n  ...\n1..267\n# tests 267\n# suites 0\n# pass 267\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 57701.812375\n\n> cs-agent-mcp@0.2.4 pack:check /Users/wyattfang/work/cs-agent-mcp\n> npm pack --dry-run\n\n\n> cs-agent-mcp@0.2.4 prepack\n> tsdown --logLevel silent src/mcp-cli.ts --format esm --clean --platform node --target node22 --no-fixedExtension\n\ncs-agent-mcp-0.2.4.tgz\n",
      "stderr": "npm notice\nnpm notice 📦  cs-agent-mcp@0.2.4\nnpm notice Tarball Contents\nnpm notice 1.1kB LICENSE\nnpm notice 20.7kB README.md\nnpm notice 11B dist/mcp-cli.d.ts\nnpm notice 456.5kB dist/mcp-cli.js\nnpm notice 1.0MB dist/mcp-cli.js.map\nnpm notice 2.8kB dist/terminal-kit-adapter-BfOJdCLx.js\nnpm notice 6.1kB dist/terminal-kit-adapter-BfOJdCLx.js.map\nnpm notice 27.2kB dist/tui-CfrA8USR.js\nnpm notice 55.1kB dist/tui-CfrA8USR.js.map\nnpm notice 13.7kB docs/MCP_ARCHITECTURE.md\nnpm notice 3.5kB package.json\nnpm notice Tarball Details\nnpm notice name: cs-agent-mcp\nnpm notice version: 0.2.4\nnpm notice filename: cs-agent-mcp-0.2.4.tgz\nnpm notice package size: 344.7 kB\nnpm notice unpacked size: 1.6 MB\nnpm notice shasum: 9bacc03c4248a16c64e9e245a58ce9e31d6d09fe\nnpm notice integrity: sha512-qp2x6qwFSZden[...]ZfeHiEDwiw8zQ==\nnpm notice total files: 11\nnpm notice\n",
      "id": "CMD-001",
      "core": true,
      "failure_handling": "fix-or-block"
    },
    {
      "command": "pnpm run package:smoke:tarball",
      "exit_code": 0,
      "stdout": "\n> cs-agent-mcp@0.2.4 package:smoke:tarball /Users/wyattfang/work/cs-agent-mcp\n> node scripts/package-smoke-tarball.mjs\n\n\n> cs-agent-mcp@0.2.4 build:test /Users/wyattfang/work/cs-agent-mcp\n> node -e \"require('node:fs').rmSync('dist-test',{recursive:true,force:true})\" && tsc6 -p tsconfig.test.json\n\n\nadded 115 packages in 7s\n0.2.4\nUsage: cs-agent-mcp [options] [command]\n\n通过 MCP 创建、调用和编排本机编码 Agent\n\nOptions:\n  -V, --version  output the version number\n  --cwd <path>   未提供 MCP workspace roots 时使用的工作目录 (default:\n                 \"/Users/wyattfang/work/cs-agent-mcp\")\n  -h, --help     display help for command\n\nCommands:\n  agents         查看本机 cs-agent-mcp Agent 诊断状态\n\n> cs-agent-mcp@0.2.4 package:smoke /Users/wyattfang/work/cs-agent-mcp\n> node scripts/package-smoke.mjs\n\n{\"toolCount\":14,\"waitMany\":\"ok\",\"lifecycle\":\"ok\",\"diagnostics\":\"ok\"}\n",
      "stderr": "",
      "id": "CMD-002",
      "core": true,
      "failure_handling": "fix-or-block"
    },
    {
      "command": "pnpm run build:test && node --test dist-test/test/mcp-facade.test.js dist-test/test/mcp-e2e.test.js",
      "exit_code": 0,
      "stdout": "g without cancelling turns\nok 35 - MultiAgentFacade wait many timeout returns pending without cancelling turns\n  ---\n  duration_ms: 0.49125\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade waitAll stays pending until every turn is terminal\nok 36 - MultiAgentFacade waitAll stays pending until every turn is terminal\n  ---\n  duration_ms: 1.093917\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade waitAny is equivalent to wait many mode any\nok 37 - MultiAgentFacade waitAny is equivalent to wait many mode any\n  ---\n  duration_ms: 0.593208\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade waitAll returns permission early and can resume to terminal\nok 38 - MultiAgentFacade waitAll returns permission early and can resume to terminal\n  ---\n  duration_ms: 0.738042\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade waitAll projects terminal after cancelling a pending permission\nok 39 - MultiAgentFacade waitAll projects terminal after cancelling a pending permission\n  ---\n  duration_ms: 0.6945\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade waitAll can accumulate complete results after timeout\nok 40 - MultiAgentFacade waitAll can accumulate complete results after timeout\n  ---\n  duration_ms: 1.184875\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade wait many uses one store waiter for a batch\nok 41 - MultiAgentFacade wait many uses one store waiter for a batch\n  ---\n  duration_ms: 1.312042\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade returns permission control to an ancestor and resumes the runtime callback\nok 42 - MultiAgentFacade returns permission control to an ancestor and resumes the runtime callback\n  ---\n  duration_ms: 0.752792\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade cancels a queued turn without starting it\nok 43 - MultiAgentFacade cancels a queued turn without starting it\n  ---\n  duration_ms: 0.72775\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade propagates active turn cancellation to the ACP runtime\nok 44 - MultiAgentFacade propagates active turn cancellation to the ACP runtime\n  ---\n  duration_ms: 0.52325\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade cascades parent turn cancellation to active descendant turns\nok 45 - MultiAgentFacade cascades parent turn cancellation to active descendant turns\n  ---\n  duration_ms: 2.476125\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade requires cascade before destroying an agent with live descendants\nok 46 - MultiAgentFacade requires cascade before destroying an agent with live descendants\n  ---\n  duration_ms: 0.543\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade rejects managed agent self-destruction without changing state\nok 47 - MultiAgentFacade rejects managed agent self-destruction without changing state\n  ---\n  duration_ms: 0.202584\n  type: 'test'\n  ...\n# Subtest: MultiAgentFacade prepares a dormant persistent runtime before discarding it\nok 48 - MultiAgentFacade prepares a dormant persistent runtime before discarding it\n  ---\n  duration_ms: 0.312292\n  type: 'test'\n  ...\n# Subtest: MCP server exposes all facade tools and returns structured create results\nok 49 - MCP server exposes all facade tools and returns structured create results\n  ---\n  duration_ms: 11.806667\n  type: 'test'\n  ...\n# Subtest: Facade exposes max-turn failures consistently through state, events, and MCP\nok 50 - Facade exposes max-turn failures consistently through state, events, and MCP\n  ---\n  duration_ms: 2.831541\n  type: 'test'\n  ...\n# Subtest: MCP tools preserve facade errors, correlations, bounded waits, cursors, and lifecycle\nok 51 - MCP tools preserve facade errors, correlations, bounded waits, cursors, and lifecycle\n  ---\n  duration_ms: 26.226208\n  type: 'test'\n  ...\n# Subtest: loopback MCP authenticates a managed agent and supports recursive delegation\nok 52 - loopback MCP authenticates a managed agent and supports recursive delegation\n  ---\n  duration_ms: 35.751083\n  type: 'test'\n  ...\n1..52\n# tests 52\n# suites 0\n# pass 52\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 58968.615333\n",
      "stderr": "",
      "id": "CMD-003",
      "core": true,
      "failure_handling": "fix-or-block"
    }
  ],
  "providers": {}
}
```

## 3. Validation Commands

Extracted from checklist `dod.commands`; see DoD Results for command status.

## 4. Scope And Cleanliness

Design bytes: 11693
Checklist bytes: 3314

## 5. Residual Risks

- none

## 6. Provider Signals

```json
{
  "archguard": {
    "status": "skipped",
    "reason": "archguard collection disabled",
    "warnings": []
  },
  "meta_cc": {
    "status": "skipped",
    "reason": "meta-cc collection disabled",
    "warnings": []
  }
}
```

## 7. Gate Results

```json
{
  "gate_id": "scope-gate",
  "stage": "implementation",
  "status": "passed",
  "blocking": [],
  "warnings": [],
  "evidence": [
    {
      "changed_files": [
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
        "AGENTS.md",
        "CHANGELOG.md",
        "README.md",
        "docs/MCP_ARCHITECTURE.md",
        "package.json",
        "scripts/package-smoke.mjs",
        "src/mcp/facade/facade.ts",
        "src/mcp/facade/types.ts",
        "src/mcp/transport/server.ts",
        "test/mcp-cli.test.ts",
        "test/mcp-e2e.test.ts",
        "test/mcp-facade.test.ts",
        "test/mock-agent.ts",
        ".codestable/features/2026-07-19-agent-wait-many/agent-wait-many-checklist.yaml",
        ".codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design-review.md",
        ".codestable/features/2026-07-19-agent-wait-many/agent-wait-many-design.md",
        ".codestable/features/2026-07-19-agent-wait-many/agent-wait-many-implementation-evidence.md",
        ".codestable/features/2026-07-19-agent-wait-many/agent-wait-many-review.md",
        ".codestable/features/2026-07-19-agent-wait-many/goal-plan.md",
        ".codestable/features/2026-07-19-agent-wait-many/goal-protocol.md",
        ".codestable/features/2026-07-19-agent-wait-many/goal-state.yaml",
        ".codestable/features/2026-07-19-agent-wait-many/implementation-dod-gate.json",
        ".codestable/features/2026-07-19-agent-wait-many/implementation-evidence-pack.json",
        ".codestable/features/2026-07-19-agent-wait-many/implementation-evidence-pack.md",
        ".codestable/features/2026-07-19-agent-wait-many/implementation-scope-gate.json",
        "scripts/package-command-spawn.mjs",
        "scripts/package-smoke-tarball.mjs",
        "src/mcp/facade/wait-many.ts",
        "test/package-spawn.test.mjs"
      ],
      "ignored_machine_artifacts": [
        ".codestable/features/2026-07-19-agent-wait-many/implementation-dod-results.json"
      ],
      "allowed_prefixes": [
        ".codestable/features/2026-07-19-agent-wait-many",
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
        "AGENTS.md",
        "CHANGELOG.md",
        "README.md",
        "docs/MCP_ARCHITECTURE.md",
        "package.json",
        "scripts/package-smoke.mjs",
        "scripts/package-smoke-tarball.mjs",
        "scripts/package-command-spawn.mjs",
        "src/mcp/facade/facade.ts",
        "src/mcp/facade/types.ts",
        "src/mcp/facade/wait-many.ts",
        "src/mcp/transport/server.ts",
        "test/mcp-cli.test.ts",
        "test/mcp-e2e.test.ts",
        "test/mcp-facade.test.ts",
        "test/mock-agent.ts",
        "test/package-spawn.test.mjs"
      ]
    }
  ],
  "providers": {}
}
```
