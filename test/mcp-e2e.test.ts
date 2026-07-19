import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  BROKER_DESCRIPTOR_SCHEMA,
  brokerPaths,
  writeBrokerDescriptorAtomic,
  type BrokerDescriptor,
} from "../src/mcp/broker/protocol.js";
import { acquireFacadeProcessLock } from "../src/mcp/transport/process-lock.js";

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
  "cs_agent_wait_many",
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

async function waitForPathState(
  targetPath: string,
  exists: boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await fs
      .stat(targetPath)
      .then(() => true)
      .catch(() => false);
    if (found === exists) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${targetPath} to ${exists ? "exist" : "disappear"}`);
}

async function waitForBrokerDescriptor(home: string): Promise<BrokerDescriptor> {
  const descriptorPath = path.join(home, ".cs-agent-mcp", "mcp", "broker.json");
  await waitForPathState(descriptorPath, true);
  return JSON.parse(await fs.readFile(descriptorPath, "utf8")) as BrokerDescriptor;
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Timed out waiting for pid ${child.pid ?? "unknown"} to exit`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function waitForAsyncCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for asynchronous condition");
}

async function readBrokerHealth(descriptor: BrokerDescriptor): Promise<{
  pid: number;
  activeLeaseCount: number;
  activeSessionCount: number;
  workspaceCount: number;
}> {
  const url = new URL(descriptor.endpoint);
  url.pathname = "/health";
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${descriptor.credential}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    pid: number;
    activeLeaseCount: number;
    activeSessionCount: number;
    workspaceCount: number;
  };
}

async function captureProcess(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

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

test("all 14 cs_agent tools complete a lifecycle through the cs-agent-mcp stdio entrypoint", async (t) => {
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
      content: "sleep 100",
      idempotencyKey: "submission-timeout-only",
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
    result?: { status?: string; message?: { content?: string } };
  };
  assert.equal(timeoutResultContent.result?.status, "message");
  assert.equal(timeoutResultContent.result?.message?.content, "slept 100ms");

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

test("wait many fans in concurrent ACP turns and resumes after permission", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-wait-many-"));
  const workspace = path.join(home, "workspace");
  const releasePath = path.join(workspace, "release-wait-many");
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

  const client = new Client({ name: "cs-agent-mcp-wait-many", version: "1.0.0" });
  t.after(async () => await client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    }),
  );

  const createdAgents = await Promise.all(
    ["codex", "claude"].map(async (agent) => {
      const created = await client.callTool({
        name: "cs_agent_create",
        arguments: { agent, name: `wait-many-${agent}` },
      });
      const content = created.structuredContent as { agent?: { agentId?: string } };
      assert.ok(content.agent?.agentId);
      return content.agent.agentId;
    }),
  );
  const barrierTurns = await Promise.all(
    createdAgents.map(async (agentId, index) => {
      const sent = await client.callTool({
        name: "cs_agent_send",
        arguments: {
          agentId,
          content: `file-barrier ${JSON.stringify({ path: releasePath, result: `barrier-${index}` })}`,
          idempotencyKey: `wait-many-barrier-${index}`,
        },
      });
      const content = sent.structuredContent as { receipt?: { turnId?: string } };
      assert.ok(content.receipt?.turnId);
      return content.receipt.turnId;
    }),
  );

  const running = await Promise.all(
    barrierTurns.map(
      async (turnId) => await waitForTurn(client, turnId, (turn) => turn.state === "running"),
    ),
  );
  assert.deepEqual(
    running.map((turn) => turn.state),
    ["running", "running"],
  );

  const barrierWait = client.callTool(
    {
      name: "cs_agent_wait_many",
      arguments: { turnIds: barrierTurns, mode: "all", waitMs: 30_000 },
    },
    undefined,
    { timeout: 45_000 },
  );
  await fs.writeFile(releasePath, "release", "utf8");
  const barrierResult = (await barrierWait).structuredContent as {
    result?: {
      ready?: Array<{
        status?: string;
        turn?: { turnId?: string };
        message?: { content?: string };
      }>;
      pendingTurnIds?: string[];
      timedOut?: boolean;
    };
  };
  assert.equal(barrierResult.result?.timedOut, false);
  assert.deepEqual(barrierResult.result?.pendingTurnIds, []);
  assert.deepEqual(
    barrierResult.result?.ready?.map((item) => ({
      status: item.status,
      turnId: item.turn?.turnId,
      content: item.message?.content,
    })),
    [
      { status: "message", turnId: barrierTurns[0], content: "barrier-0" },
      { status: "message", turnId: barrierTurns[1], content: "barrier-1" },
    ],
  );

  const permissionSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: createdAgents[0],
      content: "permission edit wait-many permission",
      idempotencyKey: "wait-many-permission",
    },
  });
  const peerSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: createdAgents[1],
      content: "echo wait-many-peer",
      idempotencyKey: "wait-many-permission-peer",
    },
  });
  const permissionTurnId = (permissionSend.structuredContent as { receipt?: { turnId?: string } })
    .receipt?.turnId;
  const peerTurnId = (peerSend.structuredContent as { receipt?: { turnId?: string } }).receipt
    ?.turnId;
  assert.ok(permissionTurnId);
  assert.ok(peerTurnId);
  await waitForTurn(client, peerTurnId, (turn) => turn.state === "completed");

  const interrupted = await client.callTool({
    name: "cs_agent_wait_many",
    arguments: { turnIds: [permissionTurnId, peerTurnId], mode: "all", waitMs: 30_000 },
  });
  const interruptedContent = interrupted.structuredContent as {
    result?: {
      ready?: Array<{
        status?: string;
        turn?: { turnId?: string };
        permission?: { permissionId?: string };
      }>;
      pendingTurnIds?: string[];
    };
  };
  const action = interruptedContent.result?.ready?.find(
    (item) => item.status === "action_required",
  );
  assert.equal(action?.turn?.turnId, permissionTurnId);
  assert.ok(action.permission?.permissionId);
  assert.deepEqual(interruptedContent.result?.pendingTurnIds, [permissionTurnId]);

  await client.callTool({
    name: "cs_agent_respond_permission",
    arguments: { permissionId: action.permission.permissionId, outcome: "allow_once" },
  });
  const resumed = await client.callTool({
    name: "cs_agent_wait_many",
    arguments: {
      turnIds: interruptedContent.result.pendingTurnIds,
      mode: "all",
      waitMs: 30_000,
    },
  });
  const resumedContent = resumed.structuredContent as {
    result?: { ready?: Array<{ status?: string; turn?: { turnId?: string } }> };
  };
  const accumulated = new Map(
    [...(interruptedContent.result?.ready ?? []), ...(resumedContent.result?.ready ?? [])].map(
      (item) => [item.turn?.turnId, item.status],
    ),
  );
  assert.deepEqual(
    [...accumulated.entries()],
    [
      [permissionTurnId, "message"],
      [peerTurnId, "message"],
    ],
  );

  for (const agentId of createdAgents) {
    await client.callTool({
      name: "cs_agent_destroy",
      arguments: { agentId, discardSession: true },
    });
  }
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
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(async (client) => await client.close()));
    await waitForPathState(path.join(home, ".cs-agent-mcp", "mcp", "broker.json"), false);
    await fs.rm(home, { recursive: true, force: true });
  });
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

  const descriptorPath = path.join(home, ".cs-agent-mcp", "mcp", "broker.json");
  const descriptorBeforeDiagnostics = await fs.readFile(descriptorPath, "utf8");
  const facadeDirectory = path.join(home, ".cs-agent-mcp", "mcp", "facades");
  const lockEntries = (await fs.readdir(facadeDirectory)).filter((entry) =>
    entry.endsWith(".lock"),
  );
  assert.equal(lockEntries.length, 2);
  const locksBeforeDiagnostics = new Map(
    await Promise.all(
      lockEntries.map(
        async (entry) =>
          [entry, await fs.readFile(path.join(facadeDirectory, entry), "utf8")] as const,
      ),
    ),
  );
  const diagnostics = await captureProcess(
    spawn(process.execPath, [CLI_PATH, "agents", "list", "--json"], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(diagnostics.code, 0, diagnostics.stderr);
  const diagnosticResult = JSON.parse(diagnostics.stdout) as {
    schema?: string;
    agents?: Array<{ instance?: { instanceId?: string; pid?: number } }>;
  };
  assert.equal(diagnosticResult.schema, "cs-agent-mcp.diagnostics.v1");
  const instanceIds = new Set(
    diagnosticResult.agents?.map((agent) => agent.instance?.instanceId).filter(Boolean),
  );
  assert.equal(instanceIds.size, 2);
  const brokerPid = (JSON.parse(descriptorBeforeDiagnostics) as BrokerDescriptor).pid;
  assert.equal(
    diagnosticResult.agents?.every((agent) => agent.instance?.pid === brokerPid),
    true,
  );
  for (const [agentId, expectedCwd] of [
    [firstCreatedContent.agent.agentId, canonicalFirstWorkspace],
    [secondCreatedContent.agent.agentId, canonicalSecondWorkspace],
  ] as const) {
    const diagnosticStatus = await captureProcess(
      spawn(process.execPath, [CLI_PATH, "agents", "status", agentId, "--json"], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(diagnosticStatus.code, 0, diagnosticStatus.stderr);
    const statusResult = JSON.parse(diagnosticStatus.stdout) as {
      agent?: {
        agentId?: string;
        cwd?: string;
        instance?: { instanceId?: string; pid?: number };
      };
    };
    assert.equal(statusResult.agent?.agentId, agentId);
    assert.equal(statusResult.agent?.cwd, expectedCwd);
    assert.equal(statusResult.agent?.instance?.pid, brokerPid);
    assert.ok(statusResult.agent?.instance?.instanceId);
  }
  assert.equal(await fs.readFile(descriptorPath, "utf8"), descriptorBeforeDiagnostics);
  for (const [entry, contents] of locksBeforeDiagnostics) {
    assert.equal(await fs.readFile(path.join(facadeDirectory, entry), "utf8"), contents);
  }

  const crossWorkspaceStatus = await secondClient.callTool({
    name: "cs_agent_status",
    arguments: { agentId: firstCreatedContent.agent.agentId },
  });
  const crossWorkspaceStatusContent = crossWorkspaceStatus.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(crossWorkspaceStatus.isError, true);
  assert.equal(crossWorkspaceStatusContent.error?.code, "AGENT_NOT_FOUND");

  for (const [client, agentId] of [
    [firstClient, firstCreatedContent.agent.agentId],
    [secondClient, secondCreatedContent.agent.agentId],
  ] as const) {
    const destroyed = await client.callTool({
      name: "cs_agent_destroy",
      arguments: { agentId },
    });
    assert.equal(destroyed.isError, undefined, JSON.stringify(destroyed.structuredContent));
    const attached = await captureProcess(
      spawn(process.execPath, [CLI_PATH, "agents", "attach", agentId, "--json"], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(attached.code, 0, attached.stderr);
    const attachedLines = attached.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind?: string; agent?: { agentId?: string } });
    assert.equal(attachedLines[0]?.kind, "snapshot");
    assert.equal(attachedLines[0]?.agent?.agentId, agentId);
    assert.equal(attachedLines.at(-1)?.kind, "terminal");
  }

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

test("independent stdio clients share one Broker, Workspace owner, and Agent tree", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-shared-workspace-"));
  const workspace = path.join(home, "workspace");
  const secondaryWorkspace = path.join(home, "workspace-secondary");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(secondaryWorkspace, { recursive: true }),
  ]);
  const canonicalRoots = (
    await Promise.all([fs.realpath(workspace), fs.realpath(secondaryWorkspace)])
  ).toSorted();
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );

  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(async (client) => await client.close()));
    const descriptorPath = path.join(home, ".cs-agent-mcp", "mcp", "broker.json");
    const descriptor = await fs
      .readFile(descriptorPath, "utf8")
      .then((raw) => JSON.parse(raw) as { pid?: number })
      .catch(() => undefined);
    if (descriptor?.pid) {
      try {
        process.kill(descriptor.pid, "SIGTERM");
      } catch {
        // The normal idle path already stopped it.
      }
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const startClient = async (name: string, roots: string[], rootsDelayMs = 0): Promise<Client> => {
    const client = new Client({ name, version: "1.0.0" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      if (rootsDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, rootsDelayMs));
      }
      return { roots: roots.map((root) => ({ uri: pathToFileURL(root).href })) };
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", workspace],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  };

  const [first, second] = await Promise.all([
    startClient("shared-workspace-a", [workspace, secondaryWorkspace]),
    startClient("shared-workspace-b", [secondaryWorkspace, workspace]),
  ]);
  assert.deepEqual(
    (await first.listTools()).tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );
  assert.deepEqual(
    (await second.listTools()).tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );
  for (const client of [first, second]) {
    const capabilities = await client.callTool({
      name: "cs_agent_capabilities",
      arguments: {},
    });
    assert.equal(capabilities.isError, undefined, JSON.stringify(capabilities.structuredContent));
  }

  const descriptorPath = path.join(home, ".cs-agent-mcp", "mcp", "broker.json");
  await waitForPathState(descriptorPath, true);
  const firstDescriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as {
    pid: number;
    credential: string;
  };
  assert.equal((await fs.stat(descriptorPath)).mode & 0o777, 0o600);
  assert.equal(firstDescriptor.credential.length, 64);
  const brokerLockPath = path.join(home, ".cs-agent-mcp", "mcp", "broker.lock");
  assert.equal((await fs.stat(brokerLockPath)).mode & 0o777, 0o600);
  const brokerDirectoryEntries = await fs.readdir(path.dirname(descriptorPath));
  assert.equal(
    brokerDirectoryEntries.some((entry) => entry.endsWith(".tmp")),
    false,
  );
  if (process.platform !== "win32") {
    const processCommand = await captureProcess(
      spawn("ps", ["-p", String(firstDescriptor.pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(processCommand.code, 0, processCommand.stderr);
    assert.equal(processCommand.stdout.includes(firstDescriptor.credential), false);
  }
  const workspaceStateKey = canonicalRoots.join("\0");
  const workspaceKey = createHash("sha256").update(workspaceStateKey).digest("hex").slice(0, 24);
  const workspaceLockPath = path.join(
    home,
    ".cs-agent-mcp",
    "mcp",
    "facades",
    `${workspaceKey}.json.lock`,
  );
  await waitForPathState(workspaceLockPath, true);
  const firstLock = JSON.parse(await fs.readFile(workspaceLockPath, "utf8")) as {
    pid: number;
    token: string;
  };
  assert.equal(firstLock.pid, firstDescriptor.pid);

  const created = await first.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "shared-child", cwd: workspace },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  const snapshotContents = await fs.readFile(
    path.join(home, ".cs-agent-mcp", "mcp", "facades", `${workspaceKey}.json`),
    "utf8",
  );
  assert.equal(snapshotContents.includes(firstDescriptor.credential), false);
  const listed = await second.callTool({ name: "cs_agent_list", arguments: { agent: "claude" } });
  const listedContent = listed.structuredContent as {
    result?: { agents?: Array<{ agentId?: string }> };
  };
  assert.deepEqual(
    listedContent.result?.agents?.map((agent) => agent.agentId),
    [child.agent.agentId],
  );
  const sent = await first.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "sleep 2000",
      idempotencyKey: "shared-root-long-turn",
    },
  });
  const receipt = sent.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(receipt.receipt?.turnId);

  await first.close();
  clients.splice(clients.indexOf(first), 1);
  const waited = await second.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: receipt.receipt.turnId, waitMs: 5_000 },
  });
  const waitedContent = waited.structuredContent as { result?: { status?: string } };
  assert.equal(waitedContent.result?.status, "message");
  const status = await second.callTool({
    name: "cs_agent_status",
    arguments: { agentId: child.agent.agentId },
  });
  assert.equal(status.isError, undefined);
  const secondDescriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as { pid: number };
  const secondLock = JSON.parse(await fs.readFile(workspaceLockPath, "utf8")) as { token: string };
  assert.equal(secondDescriptor.pid, firstDescriptor.pid);
  assert.equal(secondLock.token, firstLock.token);

  const cancellable = await second.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "sleep 30000",
      idempotencyKey: "shared-root-cross-cancel",
    },
  });
  const cancellableReceipt = cancellable.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(cancellableReceipt.receipt?.turnId);
  await waitForTurn(second, cancellableReceipt.receipt.turnId, (turn) => turn.state === "running");
  const cancelled = await second.callTool({
    name: "cs_agent_cancel",
    arguments: { turnId: cancellableReceipt.receipt.turnId, reason: "cross-client cancel" },
  });
  assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled.structuredContent));
  await waitForTurn(
    second,
    cancellableReceipt.receipt.turnId,
    (turn) => turn.state === "cancelled",
  );
  const sharedEvents = await second.callTool({
    name: "cs_agent_events",
    arguments: { agentId: child.agent.agentId, limit: 1_000 },
  });
  const sharedEventContent = sharedEvents.structuredContent as {
    page?: { events?: Array<{ type?: string; turnId?: string }> };
  };
  assert.equal(
    sharedEventContent.page?.events?.some(
      (event) =>
        event.type === "turn.cancelled" && event.turnId === cancellableReceipt.receipt?.turnId,
    ),
    true,
  );
  const destroyedShared = await second.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId: child.agent.agentId },
  });
  const destroyedSharedContent = destroyedShared.structuredContent as {
    agent?: { state?: string };
  };
  assert.equal(destroyedSharedContent.agent?.state, "destroyed");
  const postDetachCreate = await second.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "created-after-a-detached", cwd: workspace },
  });
  const postDetachChild = postDetachCreate.structuredContent as { agent?: { agentId?: string } };
  assert.ok(postDetachChild.agent?.agentId);
  await second.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId: postDetachChild.agent.agentId },
  });

  await second.close();
  clients.splice(clients.indexOf(second), 1);
  const reconnected = await startClient(
    "shared-workspace-grace-reconnect",
    [workspace, secondaryWorkspace],
    1_500,
  );
  const reconnectCapabilities = await reconnected.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  assert.equal(reconnectCapabilities.isError, undefined);
  const reconnectDescriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as {
    pid: number;
  };
  const reconnectLock = JSON.parse(await fs.readFile(workspaceLockPath, "utf8")) as {
    token: string;
  };
  assert.equal(reconnectDescriptor.pid, firstDescriptor.pid);
  assert.equal(reconnectLock.token, firstLock.token);
  await reconnected.close();
  clients.splice(clients.indexOf(reconnected), 1);
  await waitForPathState(workspaceLockPath, false);
  await waitForPathState(descriptorPath, false);
});

test("a SIGKILLed frontend expires its lease without disrupting another root", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-frontend-sigkill-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const canonicalWorkspace = await fs.realpath(workspace);
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );

  const clients: Client[] = [];
  let descriptor: BrokerDescriptor | undefined;
  t.after(async () => {
    await Promise.allSettled(clients.map(async (client) => await client.close()));
    if (descriptor) {
      try {
        process.kill(descriptor.pid, "SIGTERM");
      } catch {
        // The normal idle path already stopped it.
      }
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const startClient = async (name: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    await client.callTool({ name: "cs_agent_capabilities", arguments: {} });
    return { client, transport };
  };

  const [{ client: first, transport: firstTransport }, { client: second }] = await Promise.all([
    startClient("sigkill-root-a"),
    startClient("sigkill-root-b"),
  ]);
  descriptor = await waitForBrokerDescriptor(home);
  assert.equal((await readBrokerHealth(descriptor)).activeLeaseCount, 2);
  const workspaceKey = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 24);
  const lockPath = path.join(home, ".cs-agent-mcp", "mcp", "facades", `${workspaceKey}.json.lock`);
  const initialLock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token: string };
  const created = await first.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "survives-frontend" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);

  assert.ok(firstTransport.pid);
  process.kill(firstTransport.pid, "SIGKILL");
  await waitForAsyncCondition(async () => {
    try {
      return (await readBrokerHealth(descriptor as BrokerDescriptor)).activeLeaseCount === 1;
    } catch {
      return false;
    }
  });

  const status = await second.callTool({
    name: "cs_agent_status",
    arguments: { agentId: child.agent.agentId },
  });
  assert.equal(status.isError, undefined);
  const survivingLock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token: string };
  assert.equal(survivingLock.token, initialLock.token);

  await second.close();
  clients.splice(clients.indexOf(second), 1);
  await waitForPathState(path.join(home, ".cs-agent-mcp", "mcp", "broker.json"), false);
  descriptor = undefined;
});

test("a frontend SIGKILL during slow Workspace initialization is joined by its replacement", async (t) => {
  if (process.platform === "win32") {
    t.skip("named-pipe initialization gate is POSIX-only");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-slow-init-sigkill-"));
  const workspace = path.join(home, "workspace");
  const configDirectory = path.join(home, ".cs-agent-mcp");
  const configPath = path.join(configDirectory, "config.json");
  await Promise.all([
    fs.mkdir(configDirectory, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
  ]);
  const mkfifo = await captureProcess(
    spawn("mkfifo", [configPath], { stdio: ["ignore", "pipe", "pipe"] }),
  );
  assert.equal(mkfifo.code, 0, mkfifo.stderr);

  const clients: Client[] = [];
  let descriptor: BrokerDescriptor | undefined;
  t.after(async () => {
    await Promise.allSettled(clients.map(async (client) => await client.close()));
    if (descriptor) {
      try {
        process.kill(descriptor.pid, "SIGTERM");
      } catch {
        // The normal idle path already stopped it.
      }
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const startClient = async (name: string) => {
    let rootsRequested = false;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--cwd", workspace],
      env: { ...getDefaultEnvironment(), HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name, version: "1.0.0" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootsRequested = true;
      return { roots: [{ uri: pathToFileURL(workspace).href }] };
    });
    await client.connect(transport);
    clients.push(client);
    await waitForAsyncCondition(async () => rootsRequested);
    return { client, transport };
  };

  const { client: first, transport: firstTransport } = await startClient("slow-init-a");
  descriptor = await waitForBrokerDescriptor(home);
  await waitForAsyncCondition(async () => {
    const health = await readBrokerHealth(descriptor as BrokerDescriptor);
    return health.activeSessionCount === 1 && health.activeLeaseCount === 0;
  });
  assert.ok(firstTransport.pid);
  process.kill(firstTransport.pid, "SIGKILL");

  const { client: second } = await startClient("slow-init-b");
  const descriptorBeforeRelease = await waitForBrokerDescriptor(home);
  assert.equal(descriptorBeforeRelease.pid, descriptor.pid);
  await fs.writeFile(
    configPath,
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  const capabilities = await second.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  assert.equal(capabilities.isError, undefined, JSON.stringify(capabilities.structuredContent));
  await waitForAsyncCondition(async () => {
    const health = await readBrokerHealth(descriptor as BrokerDescriptor);
    return health.activeLeaseCount === 1;
  });

  await first.close().catch(() => undefined);
  clients.splice(clients.indexOf(first), 1);
  await second.close();
  clients.splice(clients.indexOf(second), 1);
  await waitForPathState(path.join(home, ".cs-agent-mcp", "mcp", "broker.json"), false);
  descriptor = undefined;
});

test("Broker SIGKILL fails the old frontend and the next connection recovers its snapshot", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-broker-sigkill-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const brokerDirectory = path.join(home, ".cs-agent-mcp", "mcp");
  await fs.mkdir(brokerDirectory, { recursive: true });
  await fs.writeFile(path.join(brokerDirectory, "broker.json"), '{"schema":');
  await fs.writeFile(
    path.join(brokerDirectory, "broker.lock"),
    `${JSON.stringify({
      pid: 999_999,
      token: "stale-broker-lock",
      createdAt: "2026-07-19T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );
  const clients: Client[] = [];
  let latestDescriptor: BrokerDescriptor | undefined;
  t.after(async () => {
    await Promise.allSettled(clients.map(async (client) => await client.close()));
    if (latestDescriptor) {
      try {
        process.kill(latestDescriptor.pid, "SIGTERM");
      } catch {
        // The normal idle path already stopped it.
      }
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const startClient = async (name: string): Promise<Client> => {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH, "--cwd", workspace],
        env: { ...getDefaultEnvironment(), HOME: home },
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  };

  const first = await startClient("broker-before-sigkill");
  const created = await first.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude", name: "recover-after-broker-kill" },
  });
  const child = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(child.agent?.agentId);
  const originalDescriptor = await waitForBrokerDescriptor(home);
  assert.equal(originalDescriptor.schema, BROKER_DESCRIPTOR_SCHEMA);
  latestDescriptor = originalDescriptor;
  process.kill(originalDescriptor.pid, "SIGKILL");
  await assert.rejects(
    first.callTool({ name: "cs_agent_list", arguments: {} }),
    /fetch failed|closed|connection/i,
  );
  await first.close().catch(() => undefined);
  clients.splice(clients.indexOf(first), 1);

  const second = await startClient("broker-after-sigkill");
  const listed = await second.callTool({ name: "cs_agent_list", arguments: {} });
  const listedContent = listed.structuredContent as {
    result?: { agents?: Array<{ agentId?: string }> };
  };
  assert.equal(listed.isError, undefined, JSON.stringify(listed.structuredContent));
  assert.equal(
    listedContent.result?.agents?.some((agent) => agent.agentId === child.agent?.agentId),
    true,
  );
  latestDescriptor = await waitForBrokerDescriptor(home);
  assert.notEqual(latestDescriptor.pid, originalDescriptor.pid);

  const resumed = await second.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "resumed after Broker crash",
      idempotencyKey: "broker-crash-resume",
    },
  });
  const resumedReceipt = resumed.structuredContent as { receipt?: { turnId?: string } };
  assert.ok(resumedReceipt.receipt?.turnId, JSON.stringify(resumed.structuredContent));
  const resumedMessage = await second.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId: resumedReceipt.receipt.turnId, waitMs: 5_000 },
  });
  const resumedContent = resumedMessage.structuredContent as { result?: { status?: string } };
  assert.equal(resumedContent.result?.status, "message");

  process.kill(latestDescriptor.pid, "SIGKILL");
  await second.close().catch(() => undefined);
  clients.splice(clients.indexOf(second), 1);
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [MOCK_AGENT_PATH, "--supports-load-session", "--load-session-not-found"],
        },
      },
    }),
  );
  const third = await startClient("broker-missing-session-after-sigkill");
  const missingSession = await third.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agent.agentId,
      content: "must not silently recreate",
      idempotencyKey: "broker-crash-missing-session",
    },
  });
  const missingSessionContent = missingSession.structuredContent as { error?: { code?: string } };
  assert.equal(missingSession.isError, true);
  assert.equal(missingSessionContent.error?.code, "SESSION_RESUME_REQUIRED");
  latestDescriptor = await waitForBrokerDescriptor(home);

  await third.close();
  clients.splice(clients.indexOf(third), 1);
  await waitForPathState(path.join(home, ".cs-agent-mcp", "mcp", "broker.json"), false);
  latestDescriptor = undefined;
});

test("protocol mismatch preserves an active old Broker and replaces an inactive one", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-protocol-mismatch-"));
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  let replacementPid: number | undefined;
  t.after(async () => {
    if (replacementPid) {
      try {
        process.kill(replacementPid, "SIGTERM");
      } catch {
        // The replacement Broker already reached idle exit.
      }
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const credential = "d".repeat(64);
  const brokerEpoch = "22222222-2222-4222-8222-222222222222";
  const runOldBroker = async (
    activeLeaseCount: number,
    lockReleaseDelayMs = 0,
    activeSessionCount = activeLeaseCount,
  ) => {
    let shutdownRequested = false;
    const processLock =
      lockReleaseDelayMs > 0
        ? await acquireFacadeProcessLock(brokerPaths(home).lockPath)
        : undefined;
    const server = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${credential}`);
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            schema: "cs-agent-mcp.broker-health.v1",
            protocolVersion: 999,
            packageVersion: "0.0.1",
            pid: process.pid,
            brokerEpoch,
            activeLeaseCount,
            activeSessionCount,
            workspaceCount: activeLeaseCount > 0 ? 1 : 0,
          }),
        );
        return;
      }
      if (pathname === "/shutdown") {
        shutdownRequested = true;
        response.writeHead(202).end();
        setImmediate(() => {
          void (async () => {
            await fs.rm(brokerPaths(home).descriptorPath, { force: true });
            server.close();
            await new Promise<void>((resolve) => setTimeout(resolve, lockReleaseDelayMs));
            await processLock?.release();
          })();
        });
        return;
      }
      response.writeHead(404).end();
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not resolve fake old Broker port"));
          return;
        }
        resolve(address.port);
      });
    });
    const descriptor: BrokerDescriptor = {
      schema: BROKER_DESCRIPTOR_SCHEMA,
      protocolVersion: 999,
      packageVersion: "0.0.1",
      pid: process.pid,
      endpoint: `http://127.0.0.1:${port}/mcp`,
      credential,
      brokerEpoch,
      readyAt: new Date().toISOString(),
    };
    await writeBrokerDescriptorAtomic(brokerPaths(home).descriptorPath, descriptor);
    return {
      server,
      descriptor,
      shutdownRequested: () => shutdownRequested,
    };
  };

  const active = await runOldBroker(1);
  const activeFrontend = spawn(process.execPath, [CLI_PATH, "--cwd", workspace], {
    env: { ...getDefaultEnvironment(), HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const activeResult = await captureProcess(activeFrontend);
  assert.equal(activeResult.code, 1);
  assert.equal(activeResult.stdout, "");
  assert.match(activeResult.stderr, /protocol 999 is incompatible with 1/);
  assert.equal(activeResult.stderr.includes(credential), false);
  assert.equal(active.shutdownRequested(), false);
  assert.equal(active.server.listening, true);
  await new Promise<void>((resolve) => active.server.close(() => resolve()));

  const initializing = await runOldBroker(0, 0, 1);
  const initializingFrontend = spawn(process.execPath, [CLI_PATH, "--cwd", workspace], {
    env: { ...getDefaultEnvironment(), HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const initializingResult = await captureProcess(initializingFrontend);
  assert.equal(initializingResult.code, 1);
  assert.match(initializingResult.stderr, /protocol 999 is incompatible with 1/);
  assert.equal(initializing.shutdownRequested(), false);
  await new Promise<void>((resolve) => initializing.server.close(() => resolve()));

  const inactive = await runOldBroker(0, 400);
  const inactiveFrontend = spawn(process.execPath, [CLI_PATH, "--cwd", workspace], {
    env: { ...getDefaultEnvironment(), HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inactiveResult = await captureProcess(inactiveFrontend);
  assert.equal(inactiveResult.code, 0, inactiveResult.stderr);
  assert.equal(inactive.shutdownRequested(), true);
  const replacement = await waitForBrokerDescriptor(home);
  assert.equal(replacement.protocolVersion, 1);
  assert.notEqual(replacement.brokerEpoch, inactive.descriptor.brokerEpoch);
  replacementPid = replacement.pid;
});

test("Broker reverse channels are session-isolated and fail closed on 405 or disconnect", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-reverse-channel-"));
  const firstWorkspace = path.join(home, "first");
  const secondWorkspace = path.join(home, "second");
  await fs.mkdir(path.join(home, ".cs-agent-mcp"), { recursive: true });
  await fs.mkdir(firstWorkspace, { recursive: true });
  await fs.mkdir(secondWorkspace, { recursive: true });
  await fs.writeFile(
    path.join(home, ".cs-agent-mcp", "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: process.execPath, args: [MOCK_AGENT_PATH, "--supports-load-session"] },
      },
    }),
  );

  const brokerProcess = spawn(process.execPath, [CLI_PATH, "--internal-broker"], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let brokerStdout = "";
  let brokerStderr = "";
  brokerProcess.stdout.setEncoding("utf8");
  brokerProcess.stderr.setEncoding("utf8");
  brokerProcess.stdout.on("data", (chunk: string) => {
    brokerStdout += chunk;
  });
  brokerProcess.stderr.on("data", (chunk: string) => {
    brokerStderr += chunk;
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(async (client) => await client.close()));
    brokerProcess.kill("SIGTERM");
    await waitForProcessExit(brokerProcess).catch(() => brokerProcess.kill("SIGKILL"));
    assert.equal(brokerStdout, "");
    assert.equal(brokerStderr, "");
    await fs.rm(home, { recursive: true, force: true });
  });

  const descriptor = await waitForBrokerDescriptor(home);
  const healthUrl = new URL(descriptor.endpoint);
  healthUrl.pathname = "/health";
  for (const authorization of [undefined, "Bearer wrong-token"]) {
    const response = await fetch(healthUrl, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }

  type TestFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
  const connectDirect = async (input: {
    name: string;
    cwd: string;
    root: string;
    fetch?: TestFetch;
    rootsDelayMs?: number;
  }): Promise<Client> => {
    const client = new Client(
      { name: input.name, version: "1.0.0" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      if (input.rootsDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, input.rootsDelayMs));
      }
      return { roots: [{ uri: pathToFileURL(input.root).href }] };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(descriptor.endpoint), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${descriptor.credential}`,
            "x-cs-agent-mcp-cwd": Buffer.from(input.cwd, "utf8").toString("base64url"),
          },
        },
        fetch: input.fetch,
        reconnectionOptions: {
          initialReconnectionDelay: 10,
          maxReconnectionDelay: 10,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      }),
    );
    clients.push(client);
    return client;
  };

  const delayedFetch: TestFetch = async (url, init) => {
    if (init?.method === "GET") {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    return await fetch(url, init);
  };
  const [delayedClient, readyClient] = await Promise.all([
    connectDirect({
      name: "reverse-delayed-a",
      cwd: firstWorkspace,
      root: firstWorkspace,
      fetch: delayedFetch,
    }),
    connectDirect({ name: "reverse-ready-b", cwd: secondWorkspace, root: secondWorkspace }),
  ]);
  let delayedSettled = false;
  const delayedCapabilities = delayedClient
    .callTool({ name: "cs_agent_capabilities", arguments: {} })
    .finally(() => {
      delayedSettled = true;
    });
  const readyCapabilities = await readyClient.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  assert.equal(readyCapabilities.isError, undefined);
  assert.equal(delayedSettled, false, "session B must not mark session A reverse-ready");
  assert.equal((await delayedCapabilities).isError, undefined);

  const methodNotAllowed = await connectDirect({
    name: "reverse-405",
    cwd: firstWorkspace,
    root: firstWorkspace,
    fetch: async (url, init) =>
      init?.method === "GET"
        ? new Response(null, { status: 405, statusText: "Method Not Allowed" })
        : await fetch(url, init),
  });
  const startedAt = Date.now();
  const unavailable = await methodNotAllowed.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  const unavailableContent = unavailable.structuredContent as { error?: { code?: string } };
  assert.equal(unavailable.isError, true);
  assert.equal(unavailableContent.error?.code, "BROKER_REVERSE_CHANNEL_UNAVAILABLE");
  assert.ok(Date.now() - startedAt < 6_000, "reverse-ready timeout must be bounded");

  const disconnected = await connectDirect({
    name: "reverse-disconnect",
    cwd: firstWorkspace,
    root: firstWorkspace,
    rootsDelayMs: 500,
    fetch: async (url, init) => {
      if (init?.method !== "GET") {
        return await fetch(url, init);
      }
      const abort = new AbortController();
      const response = await fetch(url, { ...init, signal: abort.signal });
      setTimeout(() => abort.abort(), 25).unref();
      return response;
    },
  });
  const disconnectedResult = await disconnected.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  const disconnectedContent = disconnectedResult.structuredContent as {
    error?: { code?: string };
  };
  assert.equal(disconnectedResult.isError, true);
  assert.equal(disconnectedContent.error?.code, "BROKER_REVERSE_CHANNEL_UNAVAILABLE");
});
