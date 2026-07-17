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

type AgentsListOptions = {
  all?: boolean;
  json?: boolean;
};

function configureLocalClaude(): void {
  process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS ??= "1";
  const executable = resolveClaudeCodeExecutable();
  if (executable) {
    process.env.CLAUDE_CODE_EXECUTABLE = executable;
  }
}

function createAgentsCommand(): Command {
  const agents = new Command("agents").description("查看本机 cs-agent-mcp Agent 诊断状态");

  agents
    .command("list")
    .description("列出本机可见 Agent")
    .option("--all", "包含 stopped/unknown 实例和 destroyed Agent")
    .option("--json", "输出 JSON")
    .action((options: AgentsListOptions) => {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schema: "cs-agent-mcp.diagnostics.v1", agents: [], warnings: [] })}\n`,
        );
        return;
      }
      process.stdout.write("No agents found\n");
    });

  agents
    .command("status")
    .description("查看单个 Agent 状态")
    .argument("<agent-selector>", "完整 Agent UUID 或唯一前缀")
    .option("--json", "输出 JSON");

  agents
    .command("attach")
    .description("只读跟随单个 Agent 的事件")
    .argument("<agent-selector>", "完整 Agent UUID 或唯一前缀")
    .option("--history <count>", "初始历史事件数量", "20")
    .option("--json", "输出 JSONL");

  return agents;
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
  program.addCommand(createAgentsCommand());

  await program.parseAsync(argv);
}

void main(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[cs-agent-mcp] ${message}\n`);
  process.exitCode = 1;
});
