#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import { resolveClaudeCodeExecutable } from "./acp/agent-command.js";
import { loadResolvedConfig } from "./cli/config.js";
import { runMcpServer } from "./mcp-server.js";
import {
  createAgentDiagnostics,
  type AgentDiagnosticSummary,
  type DiagnosticTimelineItem,
  type DiagnosticWarning,
} from "./mcp/diagnostics/index.js";
import { getAcpxVersion } from "./version.js";

type CliOptions = {
  cwd: string;
};

type AgentsListOptions = {
  all?: boolean;
  json?: boolean;
};

type AgentsStatusOptions = {
  json?: boolean;
};

type AgentsAttachOptions = {
  history?: string;
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
    .action(async (options: AgentsListOptions) => {
      const result = await createAgentDiagnostics().listAgents({ includeAll: options.all });
      writeDiagnosticWarnings(result.warnings);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            schema: "cs-agent-mcp.diagnostics.v1",
            agents: result.agents,
            warnings: result.warnings,
          })}\n`,
        );
        return;
      }
      writeAgentsListText(result.agents);
    });

  agents
    .command("status")
    .description("查看单个 Agent 状态")
    .argument("<agent-selector>", "完整 Agent UUID 或唯一前缀")
    .option("--json", "输出 JSON")
    .action(async (selector: string, options: AgentsStatusOptions) => {
      const result = await createAgentDiagnostics().resolveAgent(selector);
      writeDiagnosticWarnings(result.warnings);
      if (!result.ok) {
        process.stderr.write(`[cs-agent-mcp] ${result.message}\n`);
        for (const candidate of result.candidates) {
          process.stderr.write(
            `  ${candidate.agentId} ${candidate.state} ${candidate.instance.state} ${candidate.cwd}\n`,
          );
        }
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            schema: "cs-agent-mcp.diagnostics.v1",
            agent: result.agent,
            warnings: result.warnings,
          })}\n`,
        );
        return;
      }
      writeAgentStatusText(result.agent);
    });

  agents
    .command("attach")
    .description("只读跟随单个 Agent 的事件")
    .argument("<agent-selector>", "完整 Agent UUID 或唯一前缀")
    .option("--history <count>", "初始历史事件数量", "20")
    .option("--json", "输出 JSONL")
    .action(async (selector: string, options: AgentsAttachOptions) => {
      const abort = new AbortController();
      const onInterrupt = () => abort.abort();
      process.once("SIGINT", onInterrupt);
      let exitCode = 0;
      try {
        const stream = createAgentDiagnostics().attachAgent(selector, {
          history: Number.parseInt(options.history ?? "20", 10),
          signal: abort.signal,
        });
        while (true) {
          const next = await stream.next();
          if (next.done) {
            exitCode = next.value;
            break;
          }
          writeTimelineItem(next.value, Boolean(options.json));
          if (next.value.kind === "terminal") {
            exitCode = terminalExitCode(next.value.reason);
          }
        }
      } catch (error) {
        process.stderr.write(
          `[cs-agent-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
        );
        exitCode = 1;
      } finally {
        process.removeListener("SIGINT", onInterrupt);
      }
      process.exitCode = exitCode;
    });

  return agents;
}

function writeDiagnosticWarnings(warnings: DiagnosticWarning[]): void {
  for (const warning of warnings) {
    process.stderr.write(`[cs-agent-mcp] warning: ${warning.snapshotPath}: ${warning.message}\n`);
  }
}

function writeAgentsListText(agents: AgentDiagnosticSummary[]): void {
  if (agents.length === 0) {
    process.stdout.write("No agents found\n");
    return;
  }
  process.stdout.write("AGENT ID  TYPE  NAME  STATE  TURN  QUEUE  WORKSPACE\n");
  for (const agent of agents) {
    process.stdout.write(
      `${agent.agentId}  ${agent.agent}  ${agent.name ?? "-"}  ${agent.state}  ${
        agent.activeTurnId ?? "-"
      }  ${agent.queueDepth}  ${agent.cwd}\n`,
    );
  }
}

function writeAgentStatusText(agent: AgentDiagnosticSummary): void {
  process.stdout.write(`Agent: ${agent.agentId}\n`);
  process.stdout.write(`State: ${agent.state}\n`);
  process.stdout.write(`Runtime: ${agent.agent}\n`);
  process.stdout.write(`Workspace: ${agent.cwd}\n`);
  process.stdout.write(`Instance: ${agent.instance.instanceId} (${agent.instance.state})\n`);
  if (agent.activeTurnId) {
    process.stdout.write(`Active turn: ${agent.activeTurnId}\n`);
  }
  process.stdout.write(`Queue depth: ${agent.queueDepth}\n`);
}

function writeTimelineItem(item: DiagnosticTimelineItem, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  if (item.kind === "snapshot") {
    process.stdout.write(`snapshot ${item.agent.agentId} ${item.agent.state}\n`);
    return;
  }
  if (item.kind === "event") {
    process.stdout.write(
      `${item.event.cursor} ${item.event.timestamp} ${item.event.type} ${item.event.summary}\n`,
    );
    return;
  }
  process.stdout.write(`terminal ${item.reason}\n`);
}

function terminalExitCode(
  reason: Extract<DiagnosticTimelineItem, { kind: "terminal" }>["reason"],
): number {
  return reason === "instance_stopped" ||
    reason === "instance_unknown" ||
    reason === "instance_replaced"
    ? 1
    : 0;
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
