#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import { resolveClaudeCodeExecutable } from "./acp/agent-command.js";
import { loadResolvedConfig } from "./cli/config.js";
import { runMcpServer } from "./mcp-server.js";
import { getAcpxVersion } from "./version.js";

type CliOptions = {
  cwd: string;
};

function configureLocalClaude(): void {
  process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS ??= "1";
  const executable = resolveClaudeCodeExecutable();
  if (executable) {
    process.env.CLAUDE_CODE_EXECUTABLE = executable;
  }
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("cs-agent-mcp")
    .description("通过 MCP 创建、调用和编排本机编码 Agent")
    .version(getAcpxVersion())
    .option("--cwd <path>", "未提供 MCP workspace roots 时使用的工作目录", process.cwd())
    .allowExcessArguments(false)
    .showHelpAfterError()
    .action(async (options: CliOptions) => {
      const cwd = path.resolve(options.cwd);
      configureLocalClaude();
      const config = await loadResolvedConfig(cwd);
      await runMcpServer({ cwd, config });
    });

  await program.parseAsync(argv);
}

void main(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[cs-agent-mcp] ${message}\n`);
  process.exitCode = 1;
});
