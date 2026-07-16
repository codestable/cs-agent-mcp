import assert from "node:assert/strict";
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

const CLI_PATH = fileURLToPath(new URL("../src/mcp-cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

test("cs-agent-mcp serves the facade over stdio", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-cli-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "--cwd", workspace],
    env: { ...getDefaultEnvironment(), HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "cs-agent-mcp-cli-test", version: "1.0.0" });
  t.after(async () => await client.close());

  await client.connect(transport);
  const tools = await client.listTools();

  assert.equal(tools.tools.length, 13);
  assert.equal(tools.tools[0]?.name, "cs_agent_capabilities");
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
