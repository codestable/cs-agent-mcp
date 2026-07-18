import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "cs_agent_capabilities",
  "cs_agent_create",
  "cs_agent_list",
  "cs_agent_status",
  "cs_agent_events",
  "cs_agent_send",
  "cs_agent_get_message",
  "cs_agent_wait_message",
  "cs_agent_get_turn",
  "cs_agent_wait_turn",
  "cs_agent_respond_permission",
  "cs_agent_cancel",
  "cs_agent_destroy",
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const binary = requiredEnvironment("CS_AGENT_MCP_BIN");
const mockAgent = requiredEnvironment("CS_AGENT_MCP_MOCK_AGENT");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-package-smoke-"));
const workspace = path.join(home, "workspace");
const configDir = path.join(home, ".cs-agent-mcp");
await Promise.all([
  fs.mkdir(workspace, { recursive: true }),
  fs.mkdir(configDir, { recursive: true }),
]);
await fs.writeFile(
  path.join(configDir, "config.json"),
  `${JSON.stringify({
    agents: {
      claude: {
        command: process.execPath,
        args: [mockAgent, "--supports-load-session", "--supports-close-session"],
      },
    },
  })}\n`,
  "utf8",
);

async function runBinary(args) {
  const child = spawn(binary, args, {
    env: { ...getDefaultEnvironment(), HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

const client = new Client({ name: "cs-agent-package-smoke", version: "1.0.0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    }),
  );
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );

  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "package-smoke" },
  });
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  const agentId = created.structuredContent?.agent?.agentId;
  assert.equal(typeof agentId, "string");

  const sent = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "echo package-smoke-ok",
      idempotencyKey: "package-smoke-turn",
    },
  });
  assert.equal(sent.isError, undefined);
  const turnId = sent.structuredContent?.receipt?.turnId;
  assert.equal(typeof turnId, "string");

  const waited = await client.callTool(
    {
      name: "cs_agent_wait_message",
      arguments: { turnId, waitMs: 30_000 },
    },
    undefined,
    { timeout: 45_000 },
  );
  assert.equal(waited.structuredContent?.result?.status, "message");
  assert.equal(waited.structuredContent?.result?.message?.content, "package-smoke-ok");

  const destroyed = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId, discardSession: true },
  });
  assert.equal(destroyed.structuredContent?.agent?.state, "destroyed");

  const agentsHelp = await runBinary(["agents", "--help"]);
  assert.equal(agentsHelp.code, 0, agentsHelp.stderr);
  assert.match(agentsHelp.stdout, /list/);
  assert.match(agentsHelp.stdout, /status/);
  assert.match(agentsHelp.stdout, /attach/);
  assert.match(agentsHelp.stdout, /top\|ps/);

  const agentsTopHelp = await runBinary(["agents", "top", "--help"]);
  assert.equal(agentsTopHelp.code, 0, agentsTopHelp.stderr);
  assert.match(agentsTopHelp.stdout, /--all/);

  const agentsPsHelp = await runBinary(["agents", "ps", "--help"]);
  assert.equal(agentsPsHelp.code, 0, agentsPsHelp.stderr);
  assert.match(agentsPsHelp.stdout, /top\|ps/);

  const agentsList = await runBinary(["agents", "list", "--all", "--json"]);
  assert.equal(agentsList.code, 0, agentsList.stderr);
  const listJson = JSON.parse(agentsList.stdout);
  assert.equal(
    listJson.agents.some((agent) => agent.agentId === agentId),
    true,
  );

  const agentsStatus = await runBinary(["agents", "status", agentId, "--json"]);
  assert.equal(agentsStatus.code, 0, agentsStatus.stderr);
  assert.equal(JSON.parse(agentsStatus.stdout).agent.agentId, agentId);

  const agentsAttach = await runBinary(["agents", "attach", agentId, "--history", "1", "--json"]);
  assert.equal(agentsAttach.code, 0, agentsAttach.stderr);
  assert.match(agentsAttach.stdout, /"kind":"terminal"/);
  assert.match(agentsAttach.stdout, /"reason":"agent_destroyed"/);

  process.stdout.write(
    `${JSON.stringify({ toolCount: tools.tools.length, lifecycle: "ok", diagnostics: "ok" })}\n`,
  );
} finally {
  await client.close().catch(() => {});
  await fs.rm(home, { recursive: true, force: true });
}
