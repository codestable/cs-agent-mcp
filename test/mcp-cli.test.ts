import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FacadeSnapshot } from "../src/mcp/facade/types.js";

const CLI_PATH = fileURLToPath(new URL("../src/mcp-cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const TEST_TIMESTAMP = "2026-07-17T00:00:00.000Z";

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { code, stdout, stderr };
}

async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { code, stdout, stderr };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function diagnosticSnapshot(agents: FacadeSnapshot["agents"]): FacadeSnapshot {
  return {
    schema: "cs-agent-mcp.facade.v1",
    revision: 1,
    nextCursor: 1,
    agents,
    turns: {},
    messages: {},
    permissions: {},
    events: [],
    idempotency: {},
    identities: {},
  };
}

function diagnosticAgent(input: {
  agentId: string;
  kind?: "root" | "managed";
  state?: FacadeSnapshot["agents"][string]["state"];
  cwd?: string;
}): FacadeSnapshot["agents"][string] {
  return {
    agentId: input.agentId,
    rootExecutionId: "root-1",
    kind: input.kind ?? "managed",
    agent: "claude",
    name: input.kind === "root" ? "root" : "worker",
    cwd: input.cwd ?? "/workspace",
    mode: "persistent",
    depth: input.kind === "root" ? 0 : 1,
    state: input.state ?? "idle",
    queueDepth: 0,
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
  };
}

async function writeDiagnosticSnapshot(
  home: string,
  instanceId: string,
  snapshot: FacadeSnapshot,
): Promise<string> {
  const facadesDir = path.join(home, ".cs-agent-mcp", "mcp", "facades");
  await fs.mkdir(facadesDir, { recursive: true });
  const snapshotPath = path.join(facadesDir, `${instanceId}.json`);
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  return snapshotPath;
}

async function writeRunningLock(snapshotPath: string): Promise<void> {
  await fs.writeFile(
    `${snapshotPath}.lock`,
    `${JSON.stringify({ pid: process.pid, token: "test-token", createdAt: TEST_TIMESTAMP })}\n`,
    "utf8",
  );
}

function permissionWarningOnly(stderr: string): boolean {
  return stderr
    .split("\n")
    .filter(Boolean)
    .every((line) => /ExperimentalWarning.*Permission/.test(line));
}

test("cs-agent-mcp exposes agents diagnostics subcommands without starting stdio", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-help-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const result = await runCli(["agents", "--help"], { HOME: home });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: cs-agent-mcp agents/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /attach/);
});

test("cs-agent-mcp agents list renders discovered snapshots as text and JSON", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-list-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const runningPath = await writeDiagnosticSnapshot(
    home,
    "aaaaaaaaaaaaaaaaaaaaaaaa",
    diagnosticSnapshot({
      "11111111-1111-4111-8111-111111111111": diagnosticAgent({
        agentId: "11111111-1111-4111-8111-111111111111",
        state: "running",
      }),
      "22222222-2222-4222-8222-222222222222": diagnosticAgent({
        agentId: "22222222-2222-4222-8222-222222222222",
        state: "destroyed",
      }),
    }),
  );
  await writeRunningLock(runningPath);
  await writeDiagnosticSnapshot(
    home,
    "bbbbbbbbbbbbbbbbbbbbbbbb",
    diagnosticSnapshot({
      "33333333-3333-4333-8333-333333333333": diagnosticAgent({
        agentId: "33333333-3333-4333-8333-333333333333",
      }),
    }),
  );

  const text = await runCli(["agents", "list"], { HOME: home });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /AGENT ID/);
  assert.match(text.stdout, /11111111-1111-4111-8111-111111111111/);
  assert.doesNotMatch(text.stdout, /22222222-2222-4222-8222-222222222222/);
  assert.doesNotMatch(text.stdout, /33333333-3333-4333-8333-333333333333/);

  const json = await runCli(["agents", "list", "--all", "--json"], { HOME: home });
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout) as {
    schema?: string;
    agents?: Array<{ agentId?: string; instance?: { state?: string } }>;
  };
  assert.equal(parsed.schema, "cs-agent-mcp.diagnostics.v1");
  assert.deepEqual(
    parsed.agents?.map((agent) => `${agent.instance?.state}:${agent.agentId}`),
    [
      "running:11111111-1111-4111-8111-111111111111",
      "running:22222222-2222-4222-8222-222222222222",
      "stopped:33333333-3333-4333-8333-333333333333",
    ],
  );
});

test("cs-agent-mcp diagnostics text distinguishes root identities from managed runtimes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-kind-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const rootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const managedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeDiagnosticSnapshot(home, "abababababababababababab", {
    ...diagnosticSnapshot({
      [rootId]: diagnosticAgent({ agentId: rootId, kind: "root" }),
      [managedId]: diagnosticAgent({ agentId: managedId, kind: "managed" }),
    }),
    nextCursor: 3,
    events: [
      {
        cursor: "1",
        rootExecutionId: "root-1",
        type: "agent.created",
        agentId: rootId,
        timestamp: TEST_TIMESTAMP,
        data: { kind: "root", agent: "claude" },
      },
      {
        cursor: "2",
        rootExecutionId: "root-1",
        type: "turn.text_delta",
        agentId: managedId,
        turnId: "turn-1",
        timestamp: TEST_TIMESTAMP,
        data: { stream: "output", text: "turn.text_delta" },
      },
    ],
  });

  const list = await runCli(["agents", "list", "--all"], { HOME: home });
  assert.equal(list.code, 0);
  assert.match(list.stdout, /AGENT ID {2}KIND {2}RUNTIME/);
  assert.match(list.stdout, new RegExp(`${rootId}  root  claude`));
  assert.match(list.stdout, new RegExp(`${managedId}  managed  claude`));

  const status = await runCli(["agents", "status", rootId], { HOME: home });
  assert.equal(status.code, 0);
  assert.match(status.stdout, /Kind: root/);
  assert.match(status.stdout, /Runtime: claude/);

  const attach = await runCli(["agents", "attach", rootId], { HOME: home });
  assert.equal(attach.code, 1);
  assert.equal(attach.stderr, "");
  assert.match(attach.stdout, new RegExp(`snapshot ${rootId} root claude idle`));
  assert.match(attach.stdout, /root agents are MCP caller identities/i);
  assert.match(attach.stdout, /no managed runtime output/i);
  assert.match(attach.stdout, /agent\.created created/);
  assert.doesNotMatch(attach.stdout, /agent\.created agent\.created/);

  const managedAttach = await runCli(["agents", "attach", managedId], { HOME: home });
  assert.equal(managedAttach.code, 1);
  assert.match(managedAttach.stdout, /turn\.text_delta turn\.text_delta/);
});

test("cs-agent-mcp agents status resolves hidden full ids and fails closed for prefixes with corrupt snapshots", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-status-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const snapshotPath = await writeDiagnosticSnapshot(
    home,
    "cccccccccccccccccccccccc",
    diagnosticSnapshot({
      "44444444-4444-4444-8444-444444444444": diagnosticAgent({
        agentId: "44444444-4444-4444-8444-444444444444",
        state: "destroyed",
      }),
    }),
  );
  await writeRunningLock(snapshotPath);
  await fs.writeFile(
    path.join(path.dirname(snapshotPath), "dddddddddddddddddddddddd.json"),
    "{not-json",
    "utf8",
  );

  const full = await runCli(
    ["agents", "status", "44444444-4444-4444-8444-444444444444", "--json"],
    { HOME: home },
  );
  assert.equal(full.code, 0);
  assert.match(full.stderr, /warning/i);
  const parsed = JSON.parse(full.stdout) as { agent?: { agentId?: string; state?: string } };
  assert.equal(parsed.agent?.agentId, "44444444-4444-4444-8444-444444444444");
  assert.equal(parsed.agent?.state, "destroyed");

  const prefix = await runCli(["agents", "status", "44444444"], { HOME: home });
  assert.equal(prefix.code, 1);
  assert.match(prefix.stderr, /complete agent id/i);
});

test("cs-agent-mcp agents attach emits JSONL history and terminal exit codes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-attach-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const destroyedId = "66666666-6666-4666-8666-666666666666";
  const stoppedId = "77777777-7777-4777-8777-777777777777";
  const runningPath = await writeDiagnosticSnapshot(home, "eeeeeeeeeeeeeeeeeeeeeeee", {
    ...diagnosticSnapshot({
      [destroyedId]: diagnosticAgent({ agentId: destroyedId, state: "destroyed" }),
    }),
    events: [
      {
        cursor: "1",
        rootExecutionId: "root-1",
        type: "turn.text_delta",
        agentId: destroyedId,
        turnId: "turn-1",
        timestamp: TEST_TIMESTAMP,
        data: { stream: "output", text: "done" },
      },
    ],
  });
  await writeRunningLock(runningPath);
  await writeDiagnosticSnapshot(
    home,
    "ffffffffffffffffffffffff",
    diagnosticSnapshot({
      [stoppedId]: diagnosticAgent({ agentId: stoppedId, state: "idle" }),
    }),
  );

  const destroyed = await runCli(["agents", "attach", destroyedId, "--json"], { HOME: home });
  assert.equal(destroyed.code, 0);
  const destroyedLines = destroyed.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind?: string; reason?: string });
  assert.deepEqual(
    destroyedLines.map((line) => line.kind),
    ["snapshot", "event", "terminal"],
  );
  assert.equal(destroyedLines[2]?.reason, "agent_destroyed");

  const stopped = await runCli(["agents", "attach", stoppedId, "--json"], { HOME: home });
  assert.equal(stopped.code, 1);
  const stoppedLines = stopped.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind?: string; reason?: string });
  assert.deepEqual(
    stoppedLines.map((line) => line.kind),
    ["snapshot", "terminal"],
  );
  assert.equal(stoppedLines[1]?.reason, "instance_stopped");
});

test("cs-agent-mcp agents attach follows under node read-only permissions", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-permission-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const agentId = "88888888-8888-4888-8888-888888888888";
  const snapshotPath = await writeDiagnosticSnapshot(home, "999999999999999999999999", {
    ...diagnosticSnapshot({
      [agentId]: diagnosticAgent({ agentId, state: "running" }),
    }),
    events: [],
  });
  await writeRunningLock(snapshotPath);

  const child = spawn(
    process.execPath,
    [
      "--permission",
      "--allow-fs-read=*",
      CLI_PATH,
      "agents",
      "attach",
      agentId,
      "--history",
      "0",
      "--json",
    ],
    { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => child.kill("SIGTERM"));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await waitFor(() => stdout.includes('"kind":"snapshot"'));
  const replacementPath = `${snapshotPath}.replacement`;
  await fs.writeFile(
    replacementPath,
    `${JSON.stringify({
      ...diagnosticSnapshot({
        [agentId]: diagnosticAgent({ agentId, state: "destroyed" }),
      }),
      events: [
        {
          cursor: "1",
          rootExecutionId: "root-1",
          type: "agent.destroyed",
          agentId,
          timestamp: TEST_TIMESTAMP,
          data: { state: "destroyed" },
        },
      ],
    })}\n`,
    "utf8",
  );
  await fs.rename(replacementPath, snapshotPath);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal(permissionWarningOnly(stderr), true);
  assert.match(stdout, /"kind":"event"/);
  assert.match(stdout, /"reason":"agent_destroyed"/);

  const denied = await runNode(
    [
      "--permission",
      "--allow-fs-read=*",
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(home, "denied.txt"))}, "x")`,
    ],
    {},
  );
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /ERR_ACCESS_DENIED/);
});

test("cs-agent-mcp agents attach treats Ctrl-C as an interrupted terminal", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-agents-interrupt-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const agentId = "99999999-9999-4999-8999-999999999999";
  const snapshotPath = await writeDiagnosticSnapshot(
    home,
    "121212121212121212121212",
    diagnosticSnapshot({
      [agentId]: diagnosticAgent({ agentId, state: "idle" }),
    }),
  );
  await writeRunningLock(snapshotPath);
  const child = spawn(process.execPath, [CLI_PATH, "agents", "attach", agentId, "--json"], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await waitFor(() => stdout.includes('"kind":"snapshot"'));
  child.kill("SIGINT");
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0);
  assert.match(stdout, /"reason":"interrupted"/);
});

test("cs-agent-mcp serves the facade over stdio", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-cli-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "--cwd", workspace],
    env: { ...getDefaultEnvironment(), HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "cs-agent-mcp-cli-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();

  assert.equal(tools.tools.length, 13);
  assert.equal(tools.tools[0]?.name, "cs_agent_capabilities");
  const createTool = tools.tools.find((tool) => tool.name === "cs_agent_create");
  const createSchema = createTool?.inputSchema as {
    properties?: {
      sessionOptions?: {
        properties?: { maxTurns?: { description?: string } };
      };
    };
  };
  const maxTurnsDescription =
    createSchema.properties?.sessionOptions?.properties?.maxTurns?.description ?? "";
  assert.match(maxTurnsDescription, /agentic turns/);
  assert.match(maxTurnsDescription, /8-12/);
  assert.match(maxTurnsDescription, /omit/);
});

test("cs-agent-mcp honors one MCP workspace root and requires cwd when roots are ambiguous", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-roots-"));
  const launcherCwd = path.join(home, "launcher");
  const firstRoot = path.join(home, "first-workspace");
  const secondRoot = path.join(home, "second-workspace");
  await Promise.all([
    fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true }),
    fs.mkdir(launcherCwd, { recursive: true }),
    fs.mkdir(firstRoot, { recursive: true }),
    fs.mkdir(secondRoot, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  const [canonicalFirstRoot, canonicalSecondRoot] = await Promise.all([
    fs.realpath(firstRoot),
    fs.realpath(secondRoot),
  ]);
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const startClient = async (name: string, roots: string[]) => {
    const client = new Client({ name, version: "1.0.0" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((root) => ({ uri: pathToFileURL(root).href })),
    }));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", launcherCwd],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    return client;
  };

  const singleRootClient = await startClient("cs-agent-mcp-single-root", [firstRoot]);
  try {
    const singleRootCreate = await singleRootClient.callTool({
      name: "cs_agent_create",
      arguments: { agent: "claude" },
    });
    const singleRootResult = singleRootCreate.structuredContent as { agent?: { cwd?: string } };
    assert.equal(singleRootResult.agent?.cwd, canonicalFirstRoot);
  } finally {
    await singleRootClient.close();
  }

  const emptyRootsClient = await startClient("cs-agent-mcp-empty-roots", []);
  try {
    const emptyRootsCreate = await emptyRootsClient.callTool({
      name: "cs_agent_create",
      arguments: { agent: "claude" },
    });
    const emptyRootsResult = emptyRootsCreate.structuredContent as { error?: { code?: string } };
    assert.equal(emptyRootsCreate.isError, true);
    assert.equal(emptyRootsResult.error?.code, "WORKSPACE_ROOT_INVALID");
  } finally {
    await emptyRootsClient.close();
  }

  const multipleRootsClient = await startClient("cs-agent-mcp-multiple-roots", [
    firstRoot,
    secondRoot,
  ]);
  t.after(async () => await multipleRootsClient.close());
  const ambiguous = await multipleRootsClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const ambiguousResult = ambiguous.structuredContent as { error?: { code?: string } };
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguousResult.error?.code, "WORKSPACE_ROOT_AMBIGUOUS");

  const explicit = await multipleRootsClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", cwd: secondRoot },
  });
  const explicitResult = explicit.structuredContent as { agent?: { cwd?: string } };
  assert.equal(explicitResult.agent?.cwd, canonicalSecondRoot);
});

test("a managed ACP agent recursively delegates through its injected MCP server", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-recursive-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        codex: {
          command: process.execPath,
          args: [MOCK_AGENT_PATH, "--supports-load-session"],
        },
        claude: {
          command: process.execPath,
          args: [MOCK_AGENT_PATH, "--supports-load-session"],
        },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "--cwd", workspace],
    env: { ...getDefaultEnvironment(), HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "cs-agent-mcp-recursive-test", version: "1.0.0" });
  t.after(async () => await client.close());
  await client.connect(transport);

  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);

  const sent = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "mcp-delegate codex echo recursive-result",
      idempotencyKey: "recursive-e2e",
    },
  });
  const receipt = sent.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(receipt.receipt?.turnId);

  const waited = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: receipt.receipt.turnId, waitMs: 30_000 },
  });
  const result = waited.structuredContent as {
    result?: { status?: string; message?: { content?: string } };
  };

  assert.equal(result.result?.status, "message");
  assert.equal(result.result.message?.content, "recursive-result");
});

test("a dormant managed agent loads the same ACP session after MCP process restart", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-restart-"));
  const workspace = path.join(home, "workspace");
  const createdSessionFile = path.join(home, "created-session.txt");
  const loadedSessionFile = path.join(home, "loaded-session.txt");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [
            MOCK_AGENT_PATH,
            "--supports-load-session",
            "--new-session-id-file",
            createdSessionFile,
            "--load-session-id-file",
            loadedSessionFile,
          ],
        },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const startClient = async (name: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    return client;
  };

  const firstClient = await startClient("cs-agent-mcp-before-restart");
  const created = await firstClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  const firstSend = await firstClient.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "echo before-restart",
      idempotencyKey: "before-restart",
    },
  });
  const firstReceipt = firstSend.structuredContent as {
    receipt?: { messageId?: string; turnId?: string };
  };
  assert.ok(firstReceipt.receipt?.messageId);
  assert.ok(firstReceipt.receipt?.turnId);
  await firstClient.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: firstReceipt.receipt.turnId, waitMs: 30_000 },
  });
  await firstClient.close();

  const secondClient = await startClient("cs-agent-mcp-after-restart");
  t.after(async () => await secondClient.close());
  const historicalTurn = await secondClient.callTool({
    name: "cs_agent_get_turn",
    arguments: { turnId: firstReceipt.receipt.turnId },
  });
  const historicalTurnResult = historicalTurn.structuredContent as {
    turn?: { state?: string; inputMessageId?: string };
  };
  assert.equal(historicalTurnResult.turn?.state, "completed");
  assert.equal(historicalTurnResult.turn.inputMessageId, firstReceipt.receipt.messageId);
  const historicalMessage = await secondClient.callTool({
    name: "cs_agent_get_message",
    arguments: { messageId: firstReceipt.receipt.messageId },
  });
  const historicalMessageResult = historicalMessage.structuredContent as {
    message?: { content?: string; turnId?: string };
  };
  assert.equal(historicalMessageResult.message?.content, "echo before-restart");
  assert.equal(historicalMessageResult.message.turnId, firstReceipt.receipt.turnId);
  const historicalEvents = await secondClient.callTool({
    name: "cs_agent_events",
    arguments: { afterCursor: "0", turnId: firstReceipt.receipt.turnId, limit: 1_000 },
  });
  const historicalEventsResult = historicalEvents.structuredContent as {
    page?: { events?: Array<{ turnId?: string }> };
  };
  assert.equal(
    historicalEventsResult.page?.events?.some(
      (event) => event.turnId === firstReceipt.receipt?.turnId,
    ),
    true,
  );
  const secondSend = await secondClient.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "echo after-restart",
      idempotencyKey: "after-restart",
    },
  });
  const secondReceipt = secondSend.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(secondReceipt.receipt?.turnId);
  const waited = await secondClient.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: secondReceipt.receipt.turnId, waitMs: 30_000 },
  });
  const result = waited.structuredContent as {
    result?: { status?: string; message?: { content?: string } };
  };

  assert.equal(result.result?.status, "message");
  assert.equal(result.result.message?.content, "after-restart");
  assert.equal(
    await fs.readFile(loadedSessionFile, "utf8"),
    await fs.readFile(createdSessionFile, "utf8"),
  );
});

test("restart recovery reports SESSION_RESUME_REQUIRED instead of creating a fresh session", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-resume-failure-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [MOCK_AGENT_PATH, "--load-session-not-found"],
        },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const startClient = async (name: string) => {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", workspace],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    return client;
  };

  const firstClient = await startClient("cs-agent-mcp-before-resume-failure");
  const created = await firstClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  const firstSend = await firstClient.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "echo establish-session",
      idempotencyKey: "establish-session",
    },
  });
  const firstReceipt = firstSend.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(firstReceipt.receipt?.turnId);
  await firstClient.callTool({
    name: "cs_agent_wait_turn",
    arguments: { turnId: firstReceipt.receipt.turnId, waitMs: 30_000 },
  });
  await firstClient.close();

  const secondClient = await startClient("cs-agent-mcp-after-resume-failure");
  t.after(async () => await secondClient.close());
  const secondSend = await secondClient.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "echo must-not-run-fresh",
      idempotencyKey: "resume-must-not-fallback",
    },
  });
  const secondReceipt = secondSend.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(secondReceipt.receipt?.turnId);
  const waited = await secondClient.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: secondReceipt.receipt.turnId, waitMs: 30_000 },
  });
  const result = waited.structuredContent as {
    result?: { status?: string; turn?: { state?: string; error?: { code?: string } } };
  };

  assert.equal(result.result?.status, "terminal_without_message");
  assert.equal(result.result?.turn?.state, "failed");
  assert.equal(result.result.turn.error?.code, "SESSION_RESUME_REQUIRED");
});

test("restart recovery refuses to replace a missing local persistent session record", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-missing-record-"));
  const workspace = path.join(home, "workspace");
  const configDir = path.join(home, ".cs-agent-mcp");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const startClient = async (name: string) => {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", workspace],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    return client;
  };

  const firstClient = await startClient("cs-agent-mcp-before-record-loss");
  const created = await firstClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  await firstClient.close();

  const sessionDir = path.join(configDir, "sessions");
  const sessionFiles = (await fs.readdir(sessionDir)).filter((entry) => entry.endsWith(".json"));
  assert.equal(sessionFiles.length, 1);
  await Promise.all(sessionFiles.map(async (entry) => await fs.rm(path.join(sessionDir, entry))));

  const secondClient = await startClient("cs-agent-mcp-after-record-loss");
  t.after(async () => await secondClient.close());
  const secondSend = await secondClient.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "echo must-not-create-fresh",
      idempotencyKey: "missing-record-must-fail",
    },
  });
  const secondSendContent = secondSend.structuredContent as { error?: { code?: string } };

  assert.equal(secondSend.isError, true);
  assert.equal(secondSendContent.error?.code, "SESSION_RESUME_REQUIRED");
});

test("a dormant persistent agent discards its original ACP session after restart", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-dormant-discard-"));
  const workspace = path.join(home, "workspace");
  const configDir = path.join(home, ".cs-agent-mcp");
  const createdSessionFile = path.join(home, "created-session.txt");
  const closeSessionMarker = path.join(home, "closed-session.txt");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [
            MOCK_AGENT_PATH,
            "--supports-load-session",
            "--new-session-id-file",
            createdSessionFile,
            "--close-session-marker",
            closeSessionMarker,
          ],
        },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const startClient = async (name: string) => {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", workspace],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    return client;
  };

  const firstClient = await startClient("cs-agent-mcp-before-dormant-discard");
  const created = await firstClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  await firstClient.close();

  const secondClient = await startClient("cs-agent-mcp-after-dormant-discard");
  t.after(async () => await secondClient.close());
  const destroyed = await secondClient.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId: child.agent.agentId, discardSession: true },
  });
  const destroyedContent = destroyed.structuredContent as { agent?: { state?: string } };

  assert.equal(destroyedContent.agent?.state, "destroyed");
  assert.equal(
    (await fs.readFile(closeSessionMarker, "utf8")).trim(),
    (await fs.readFile(createdSessionFile, "utf8")).trim(),
  );
});

test("cs_agent_create returns a structured error when the ACP agent cannot initialize", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-init-failure-"));
  const workspace = path.join(home, "workspace");
  const initializeMarker = path.join(home, "initialize-called.txt");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [
            MOCK_AGENT_PATH,
            "--initialize-marker",
            initializeMarker,
            "--initialize-error",
            "mock initialize failed",
          ],
        },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const client = new Client({ name: "cs-agent-mcp-init-failure", version: "1.0.0" });
  t.after(async () => await client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    }),
  );

  const capabilities = await client.callTool({
    name: "cs_agent_capabilities",
    arguments: { probeAgents: ["claude"] },
  });
  const capabilityResult = capabilities.structuredContent as {
    capabilities?: { agents?: Array<{ agent?: string; availability?: string }> };
  };
  assert.equal(
    capabilityResult.capabilities?.agents?.find((candidate) => candidate.agent === "claude")
      ?.availability,
    "unavailable",
  );

  const result = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const structured = result.structuredContent as {
    error?: { code?: string; message?: string; retryable?: boolean };
  };

  assert.equal(result.isError, true);
  assert.equal(structured.error?.code, "AGENT_UNAVAILABLE");
  assert.equal(structured.error?.message, "Could not create claude");
  assert.equal(await fs.readFile(initializeMarker, "utf8"), "called");
});

test("the default MCP permission policy does not silently approve writes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-permission-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH] },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const client = new Client({ name: "cs-agent-mcp-permission", version: "1.0.0" });
  t.after(async () => await client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    }),
  );
  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  const sent = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "permission edit modify source",
      idempotencyKey: "permission-default",
    },
  });
  const receipt = sent.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(receipt.receipt?.turnId);
  const waited = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: receipt.receipt.turnId, waitMs: 30_000 },
  });
  const outcome = waited.structuredContent as {
    result?: { status?: string; permission?: { permissionId?: string } };
  };

  assert.equal(outcome.result?.status, "action_required");
  assert.ok(outcome.result.permission?.permissionId);
  const rejected = await client.callTool({
    name: "cs_agent_respond_permission",
    arguments: { permissionId: outcome.result.permission.permissionId, outcome: "reject_once" },
  });
  assert.equal(rejected.isError, undefined);
});
