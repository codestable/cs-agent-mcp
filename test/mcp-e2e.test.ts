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
] as const;

type TurnSnapshot = {
  turnId: string;
  state: string;
  revision: number;
  inputMessageId: string;
  resultMessageId?: string;
};

async function waitForTurn(
  client: Client,
  turnId: string,
  predicate: (turn: TurnSnapshot) => boolean,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + 30_000;
  let current = await client.callTool({ name: "cs_agent_get_turn", arguments: { turnId } });

  while (true) {
    const content = current.structuredContent as { turn?: TurnSnapshot };
    assert.ok(content.turn);
    if (predicate(content.turn)) {
      return content.turn;
    }
    assert.ok(Date.now() < deadline, `Timed out waiting for turn ${turnId}`);
    current = await client.callTool({
      name: "cs_agent_wait_turn",
      arguments: {
        turnId,
        afterRevision: content.turn.revision,
        waitMs: Math.min(deadline - Date.now(), 5_000),
      },
    });
    const waited = current.structuredContent as { result?: { turn?: TurnSnapshot } };
    assert.ok(waited.result?.turn);
    current = {
      ...current,
      structuredContent: { turn: waited.result.turn },
    };
  }
}

async function waitForChildAgent(
  client: Client,
  parentAgentId: string,
  agent: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const listed = await client.callTool({
      name: "cs_agent_list",
      arguments: { parentAgentId, agent },
    });
    const content = listed.structuredContent as {
      result?: { agents?: Array<{ agentId?: string }> };
    };
    const childId = content.result?.agents?.[0]?.agentId;
    if (childId) {
      return childId;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${agent} child of ${parentAgentId}`);
}

async function waitForStartedTurn(client: Client, agentId: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  let cursor = "0";
  while (Date.now() < deadline) {
    const events = await client.callTool({
      name: "cs_agent_events",
      arguments: {
        afterCursor: cursor,
        agentId,
        limit: 1_000,
        waitMs: Math.min(deadline - Date.now(), 1_000),
      },
    });
    const content = events.structuredContent as {
      page?: {
        events?: Array<{ type?: string; turnId?: string }>;
        nextCursor?: string;
      };
    };
    const turnId = content.page?.events?.find((event) => event.type === "turn.started")?.turnId;
    if (turnId) {
      return turnId;
    }
    cursor = content.page?.nextCursor ?? cursor;
  }
  throw new Error(`Timed out waiting for a started turn on ${agentId}`);
}

test("all 13 cs_agent tools complete a lifecycle through the cs-agent-mcp stdio entrypoint", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-e2e-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const canonicalWorkspace = await fs.realpath(workspace);
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        codex: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
        claude: {
          command: process.execPath,
          args: [MOCK_AGENT_PATH, "--supports-load-session", "--supports-close-session"],
        },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const client = new Client({ name: "cs-agent-mcp-full-e2e", version: "1.0.0" });
  t.after(async () => await client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    }),
  );

  const listedTools = await client.listTools();
  assert.deepEqual(
    listedTools.tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );

  const capabilities = await client.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  const capabilityContent = capabilities.structuredContent as {
    capabilities?: {
      tools?: string[];
      limits?: { maxWaitMs?: number };
      agents?: Array<{ agent?: string; availability?: string }>;
    };
  };
  assert.deepEqual(capabilityContent.capabilities?.tools, EXPECTED_TOOLS);
  assert.equal(capabilityContent.capabilities?.limits?.maxWaitMs, 30_000);
  const advertisedAgents = new Set(
    capabilityContent.capabilities?.agents?.map((candidate) => candidate.agent),
  );
  for (const agent of ["pi", "openclaw", "gemini"]) {
    assert.equal(advertisedAgents.has(agent), true, `${agent} must remain MCP-discoverable`);
  }

  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "reviewer" },
  });
  const createdContent = created.structuredContent as {
    agent?: { agentId?: string; agent?: string; name?: string; cwd?: string; state?: string };
  };
  assert.ok(createdContent.agent?.agentId);
  assert.deepEqual(
    {
      agent: createdContent.agent.agent,
      name: createdContent.agent.name,
      cwd: createdContent.agent.cwd,
      state: createdContent.agent.state,
    },
    { agent: "claude", name: "reviewer", cwd: canonicalWorkspace, state: "idle" },
  );
  assert.equal(Object.hasOwn(createdContent.agent, "command"), false);
  assert.equal(Object.hasOwn(createdContent.agent, "token"), false);
  const agentId = createdContent.agent.agentId;

  const agents = await client.callTool({
    name: "cs_agent_list",
    arguments: { agent: "claude", state: "idle" },
  });
  const agentsContent = agents.structuredContent as {
    result?: { agents?: Array<{ agentId?: string }>; hasMore?: boolean };
  };
  assert.deepEqual(
    agentsContent.result?.agents?.map((agent) => agent.agentId),
    [agentId],
  );
  assert.equal(agentsContent.result?.hasMore, false);

  const initialStatus = await client.callTool({
    name: "cs_agent_status",
    arguments: { agentId },
  });
  const initialStatusContent = initialStatus.structuredContent as {
    status?: { agent?: { state?: string; queueDepth?: number } };
  };
  assert.equal(initialStatusContent.status?.agent?.state, "idle");
  assert.equal(initialStatusContent.status.agent.queueDepth, 0);

  const firstSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "echo review-complete",
      idempotencyKey: "review-once",
    },
  });
  const firstReceipt = firstSend.structuredContent as {
    receipt?: {
      messageId?: string;
      turnId?: string;
      accepted?: boolean;
      queuePosition?: number;
    };
  };
  assert.ok(firstReceipt.receipt?.messageId);
  assert.ok(firstReceipt.receipt.turnId);
  assert.equal(firstReceipt.receipt.accepted, true);
  const inputMessageId = firstReceipt.receipt.messageId;
  const firstTurnId = firstReceipt.receipt.turnId;

  const retriedSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "echo review-complete",
      idempotencyKey: "review-once",
    },
  });
  const retriedReceipt = retriedSend.structuredContent as {
    receipt?: { messageId?: string; turnId?: string };
  };
  assert.deepEqual(retriedReceipt.receipt, firstReceipt.receipt);

  const inputMessage = await client.callTool({
    name: "cs_agent_get_message",
    arguments: { messageId: inputMessageId },
  });
  const inputMessageContent = inputMessage.structuredContent as {
    message?: { direction?: string; content?: string; turnId?: string };
  };
  assert.deepEqual(
    {
      direction: inputMessageContent.message?.direction,
      content: inputMessageContent.message?.content,
      turnId: inputMessageContent.message?.turnId,
    },
    { direction: "inbound", content: "echo review-complete", turnId: firstTurnId },
  );

  const completedTurn = await waitForTurn(
    client,
    firstTurnId,
    (turn) => turn.state === "completed",
  );
  assert.equal(completedTurn.inputMessageId, inputMessageId);
  assert.ok(completedTurn.resultMessageId);

  const waitedMessage = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { messageId: inputMessageId, waitMs: 30_000 },
  });
  const waitedMessageContent = waitedMessage.structuredContent as {
    result?: { status?: string; message?: { messageId?: string; content?: string } };
  };
  assert.equal(waitedMessageContent.result?.status, "message");
  assert.equal(waitedMessageContent.result.message?.messageId, completedTurn.resultMessageId);
  assert.equal(waitedMessageContent.result.message.content, "review-complete");

  const outputMessage = await client.callTool({
    name: "cs_agent_get_message",
    arguments: { messageId: completedTurn.resultMessageId },
  });
  const outputMessageContent = outputMessage.structuredContent as {
    message?: { direction?: string; content?: string; inReplyTo?: string };
  };
  assert.deepEqual(
    {
      direction: outputMessageContent.message?.direction,
      content: outputMessageContent.message?.content,
      inReplyTo: outputMessageContent.message?.inReplyTo,
    },
    { direction: "outbound", content: "review-complete", inReplyTo: inputMessageId },
  );

  const events = await client.callTool({
    name: "cs_agent_events",
    arguments: { afterCursor: "0", turnId: firstTurnId, limit: 1_000 },
  });
  const eventsContent = events.structuredContent as {
    page?: { events?: Array<{ type?: string; turnId?: string }>; nextCursor?: string };
  };
  assert.deepEqual(
    new Set(eventsContent.page?.events?.map((event) => event.type)),
    new Set([
      "audit.mutation",
      "message.accepted",
      "message.completed",
      "turn.queued",
      "turn.started",
      "turn.text_delta",
      "turn.completed",
    ]),
  );
  assert.equal(
    eventsContent.page?.events?.every((event) => event.turnId === firstTurnId),
    true,
  );
  assert.ok(eventsContent.page?.nextCursor);

  const attachmentSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "inspect-prompt",
      attachments: [
        { mediaType: "image/png", data: "aW1hZ2U=" },
        { mediaType: "audio/wav", data: "UklGRg==" },
      ],
      idempotencyKey: "attachment-round-trip",
    },
  });
  const attachmentReceipt = attachmentSend.structuredContent as {
    receipt?: { messageId?: string; turnId?: string };
  };
  assert.ok(attachmentReceipt.receipt?.messageId);
  assert.ok(attachmentReceipt.receipt.turnId);
  const attachmentMessage = await client.callTool({
    name: "cs_agent_get_message",
    arguments: { messageId: attachmentReceipt.receipt.messageId },
  });
  const attachmentMessageContent = attachmentMessage.structuredContent as {
    message?: { attachments?: Array<{ mediaType?: string; data?: string }> };
  };
  assert.deepEqual(attachmentMessageContent.message?.attachments, [
    { mediaType: "image/png", data: "aW1hZ2U=" },
    { mediaType: "audio/wav", data: "UklGRg==" },
  ]);
  const attachmentResult = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: attachmentReceipt.receipt.turnId, waitMs: 30_000 },
  });
  const attachmentResultContent = attachmentResult.structuredContent as {
    result?: { status?: string; message?: { content?: string } };
  };
  assert.equal(attachmentResultContent.result?.status, "message");
  assert.deepEqual(JSON.parse(attachmentResultContent.result.message?.content ?? "null"), [
    { type: "text", text: "inspect-prompt" },
    { type: "image", mimeType: "image/png", bytes: 8 },
    { type: "audio", mimeType: "audio/wav", bytes: 8 },
  ]);

  const timeoutSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "sleep 5000",
      idempotencyKey: "absolute-deadline",
      timeoutMs: 50,
    },
  });
  const timeoutReceipt = timeoutSend.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(timeoutReceipt.receipt?.turnId);
  const timeoutResult = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: timeoutReceipt.receipt.turnId, waitMs: 3_000 },
  });
  const timeoutResultContent = timeoutResult.structuredContent as {
    result?: { status?: string; turn?: { state?: string; error?: { code?: string } } };
  };
  assert.equal(timeoutResultContent.result?.status, "terminal_without_message");
  assert.equal(timeoutResultContent.result.turn?.state, "failed");
  assert.equal(timeoutResultContent.result.turn.error?.code, "TIMEOUT");

  const permissionSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "permission edit review write",
      idempotencyKey: "permission-round-trip",
    },
  });
  const permissionReceipt = permissionSend.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(permissionReceipt.receipt?.turnId);
  const permissionWait = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: permissionReceipt.receipt.turnId, waitMs: 30_000 },
  });
  const permissionWaitContent = permissionWait.structuredContent as {
    result?: { status?: string; permission?: { permissionId?: string } };
  };
  assert.equal(permissionWaitContent.result?.status, "action_required");
  assert.ok(permissionWaitContent.result.permission?.permissionId);
  const permissionId = permissionWaitContent.result.permission.permissionId;

  const allowed = await client.callTool({
    name: "cs_agent_respond_permission",
    arguments: { permissionId, outcome: "allow_once" },
  });
  const allowedContent = allowed.structuredContent as {
    permission?: { state?: string; outcome?: string };
  };
  assert.deepEqual(
    { state: allowedContent.permission?.state, outcome: allowedContent.permission?.outcome },
    { state: "resolved", outcome: "allow_once" },
  );
  const permissionResult = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: permissionReceipt.receipt.turnId, waitMs: 30_000 },
  });
  const permissionResultContent = permissionResult.structuredContent as {
    result?: { status?: string; message?: { content?: string }; turn?: { state?: string } };
  };
  assert.equal(permissionResultContent.result?.status, "message");
  assert.equal(permissionResultContent.result.message?.content, "permission selected:allow");
  assert.equal(permissionResultContent.result.turn?.state, "completed");

  const conflictingPermission = await client.callTool({
    name: "cs_agent_respond_permission",
    arguments: { permissionId, outcome: "reject_once" },
  });
  const conflictingPermissionContent = conflictingPermission.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(conflictingPermission.isError, true);
  assert.equal(conflictingPermissionContent.error?.code, "PERMISSION_ALREADY_RESOLVED");

  const cancellableSend = await client.callTool({
    name: "cs_agent_send",
    arguments: { agentId, content: "sleep 30000", idempotencyKey: "cancel-active-turn" },
  });
  const cancellableReceipt = cancellableSend.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(cancellableReceipt.receipt?.turnId);
  await waitForTurn(client, cancellableReceipt.receipt.turnId, (turn) => turn.state === "running");
  const cancelled = await client.callTool({
    name: "cs_agent_cancel",
    arguments: { turnId: cancellableReceipt.receipt.turnId, reason: "E2E cancellation" },
  });
  assert.equal(cancelled.isError, undefined);
  const cancelledTurn = await waitForTurn(
    client,
    cancellableReceipt.receipt.turnId,
    (turn) => turn.state === "cancelled",
  );
  assert.equal(cancelledTurn.state, "cancelled");
  const cancelledMessage = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: cancellableReceipt.receipt.turnId, waitMs: 30_000 },
  });
  const cancelledMessageContent = cancelledMessage.structuredContent as {
    result?: { status?: string; turn?: { state?: string } };
  };
  assert.equal(cancelledMessageContent.result?.status, "terminal_without_message");
  assert.equal(cancelledMessageContent.result.turn?.state, "cancelled");

  const destroyed = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId, discardSession: true },
  });
  assert.equal(destroyed.isError, undefined, JSON.stringify(destroyed.structuredContent));
  const destroyedContent = destroyed.structuredContent as { agent?: { state?: string } };
  assert.equal(destroyedContent.agent?.state, "destroyed");
  const repeatedDestroy = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId, discardSession: true },
  });
  const repeatedDestroyContent = repeatedDestroy.structuredContent as {
    agent?: { state?: string };
  };
  assert.equal(repeatedDestroyContent.agent?.state, "destroyed");
  const destroyEvents = await client.callTool({
    name: "cs_agent_events",
    arguments: { afterCursor: "0", agentId, limit: 1_000 },
  });
  const destroyEventsContent = destroyEvents.structuredContent as {
    page?: { events?: Array<{ type?: string }> };
  };
  assert.equal(
    destroyEventsContent.page?.events?.filter((event) => event.type === "agent.destroyed").length,
    1,
  );
  const finalStatus = await client.callTool({
    name: "cs_agent_status",
    arguments: { agentId },
  });
  const finalStatusContent = finalStatus.structuredContent as {
    status?: { agent?: { state?: string } };
  };
  assert.equal(finalStatusContent.status?.agent?.state, "destroyed");
});

test("a failed session discard leaves the managed agent recoverable", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-discard-recovery-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        codex: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const client = new Client({ name: "cs-agent-mcp-discard-recovery", version: "1.0.0" });
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
  const createdContent = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(createdContent.agent?.agentId);
  const agentId = createdContent.agent.agentId;

  const unsupportedDiscard = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId, discardSession: true },
  });
  const unsupportedDiscardContent = unsupportedDiscard.structuredContent as {
    error?: { code?: string; message?: string };
  };
  assert.equal(unsupportedDiscard.isError, true);
  assert.equal(unsupportedDiscardContent.error?.code, "RUNTIME_FAILURE");
  assert.match(unsupportedDiscardContent.error?.message ?? "", /does not support session\/close/);

  const failedStatus = await client.callTool({
    name: "cs_agent_status",
    arguments: { agentId },
  });
  const failedStatusContent = failedStatus.structuredContent as {
    status?: { agent?: { state?: string; lastError?: { code?: string } } };
  };
  assert.equal(failedStatusContent.status?.agent?.state, "failed");
  assert.equal(failedStatusContent.status.agent.lastError?.code, "RUNTIME_FAILURE");

  const delegated = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId,
      content: "mcp-delegate codex echo recovered-after-discard",
      idempotencyKey: "recover-after-discard",
    },
  });
  const delegatedContent = delegated.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(delegatedContent.receipt?.turnId);
  const recovered = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: delegatedContent.receipt.turnId, waitMs: 30_000 },
  });
  const recoveredContent = recovered.structuredContent as {
    result?: { status?: string; message?: { content?: string } };
  };
  assert.equal(recoveredContent.result?.status, "message");
  assert.equal(recoveredContent.result.message?.content, "recovered-after-discard");

  const destroyed = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId, cascade: true },
  });
  const destroyedContent = destroyed.structuredContent as { agent?: { state?: string } };
  assert.equal(destroyedContent.agent?.state, "destroyed");
});

test("cancelling a delegated parent turn cancels its active recursive child turn", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-cancel-cascade-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        codex: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const client = new Client({ name: "cs-agent-mcp-cancel-cascade", version: "1.0.0" });
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
  const createdContent = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(createdContent.agent?.agentId);
  const claudeAgentId = createdContent.agent.agentId;

  const delegated = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: claudeAgentId,
      content: "mcp-delegate codex sleep 30000",
      idempotencyKey: "cancel-recursive-parent",
    },
  });
  const delegatedContent = delegated.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(delegatedContent.receipt?.turnId);
  const parentTurnId = delegatedContent.receipt.turnId;
  const codexAgentId = await waitForChildAgent(client, claudeAgentId, "codex");
  const childTurnId = await waitForStartedTurn(client, codexAgentId);

  const childBeforeCancel = await client.callTool({
    name: "cs_agent_get_turn",
    arguments: { turnId: childTurnId },
  });
  const childBeforeCancelContent = childBeforeCancel.structuredContent as {
    turn?: { state?: string; parentTurnId?: string };
  };
  assert.equal(childBeforeCancelContent.turn?.state, "running");
  assert.equal(childBeforeCancelContent.turn.parentTurnId, parentTurnId);

  const cancelled = await client.callTool({
    name: "cs_agent_cancel",
    arguments: { turnId: parentTurnId, reason: "stop delegated review" },
  });
  assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled.structuredContent));
  const [parentTurn, childTurn] = await Promise.all([
    waitForTurn(client, parentTurnId, (turn) => turn.state === "cancelled"),
    waitForTurn(client, childTurnId, (turn) => turn.state === "cancelled"),
  ]);
  assert.equal(parentTurn.state, "cancelled");
  assert.equal(childTurn.state, "cancelled");

  const destroyed = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId: claudeAgentId, cascade: true },
  });
  const destroyedContent = destroyed.structuredContent as { agent?: { state?: string } };
  assert.equal(destroyedContent.agent?.state, "destroyed");
});

test("MCP workspace roots isolate concurrent facades and reject unsafe paths", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-root-isolation-"));
  const launcherCwd = path.join(home, "launcher");
  const firstWorkspace = path.join(home, "first-workspace");
  const secondWorkspace = path.join(home, "second-workspace");
  await Promise.all([
    fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true }),
    fs.mkdir(launcherCwd, { recursive: true }),
    fs.mkdir(firstWorkspace, { recursive: true }),
    fs.mkdir(secondWorkspace, { recursive: true }),
  ]);
  const [canonicalFirstWorkspace, canonicalSecondWorkspace] = await Promise.all([
    fs.realpath(firstWorkspace),
    fs.realpath(secondWorkspace),
  ]);
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  const clients: Client[] = [];
  t.after(async () => await Promise.all(clients.map(async (client) => await client.close())));
  const startClient = async (name: string, rootUris: string[]): Promise<Client> => {
    const client = new Client({ name, version: "1.0.0" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: rootUris.map((uri) => ({ uri })),
    }));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", launcherCwd],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  };

  const firstClient = await startClient("acpx-first-workspace", [
    pathToFileURL(firstWorkspace).href,
  ]);
  const secondClient = await startClient("acpx-second-workspace", [
    pathToFileURL(secondWorkspace).href,
  ]);

  const firstCreated = await firstClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "first" },
  });
  const firstCreatedContent = firstCreated.structuredContent as {
    agent?: { agentId?: string; cwd?: string };
  };
  assert.ok(firstCreatedContent.agent?.agentId);
  assert.equal(firstCreatedContent.agent.cwd, canonicalFirstWorkspace);

  const secondCreated = await secondClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "second" },
  });
  const secondCreatedContent = secondCreated.structuredContent as {
    agent?: { agentId?: string; cwd?: string };
  };
  assert.ok(secondCreatedContent.agent?.agentId);
  assert.equal(secondCreatedContent.agent.cwd, canonicalSecondWorkspace);
  assert.notEqual(secondCreatedContent.agent.agentId, firstCreatedContent.agent.agentId);

  const firstAgents = await firstClient.callTool({
    name: "cs_agent_list",
    arguments: { agent: "claude" },
  });
  const firstAgentsContent = firstAgents.structuredContent as {
    result?: { agents?: Array<{ agentId?: string }> };
  };
  assert.deepEqual(
    firstAgentsContent.result?.agents?.map((agent) => agent.agentId),
    [firstCreatedContent.agent.agentId],
  );
  const secondAgents = await secondClient.callTool({
    name: "cs_agent_list",
    arguments: { agent: "claude" },
  });
  const secondAgentsContent = secondAgents.structuredContent as {
    result?: { agents?: Array<{ agentId?: string }> };
  };
  assert.deepEqual(
    secondAgentsContent.result?.agents?.map((agent) => agent.agentId),
    [secondCreatedContent.agent.agentId],
  );

  const crossWorkspaceStatus = await secondClient.callTool({
    name: "cs_agent_status",
    arguments: { agentId: firstCreatedContent.agent.agentId },
  });
  const crossWorkspaceStatusContent = crossWorkspaceStatus.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(crossWorkspaceStatus.isError, true);
  assert.equal(crossWorkspaceStatusContent.error?.code, "AGENT_NOT_FOUND");

  const escapedCwd = await firstClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", cwd: secondWorkspace },
  });
  const escapedCwdContent = escapedCwd.structuredContent as { error?: { code?: string } };
  assert.equal(escapedCwd.isError, true);
  assert.equal(escapedCwdContent.error?.code, "UNAUTHORIZED");

  const remoteRootClient = await startClient("acpx-remote-root", ["https://example.com/repo"]);
  const remoteRoot = await remoteRootClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const remoteRootContent = remoteRoot.structuredContent as { error?: { code?: string } };
  assert.equal(remoteRoot.isError, true);
  assert.equal(
    remoteRootContent.error?.code,
    "WORKSPACE_ROOT_INVALID",
    JSON.stringify(remoteRoot.structuredContent),
  );

  const invalidFileRootClient = await startClient("acpx-invalid-file-root", [
    "file:///tmp/acpx%2Foutside",
  ]);
  const invalidFileRoot = await invalidFileRootClient.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const invalidFileRootContent = invalidFileRoot.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(invalidFileRoot.isError, true);
  assert.equal(
    invalidFileRootContent.error?.code,
    "WORKSPACE_ROOT_INVALID",
    JSON.stringify(invalidFileRoot.structuredContent),
  );
});
