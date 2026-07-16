import assert from "node:assert/strict";
import test from "node:test";
import type { EnsureRuntimeAgentInput } from "../src/mcp/facade/types.js";
import { createAcpxRuntimeAdapter } from "../src/mcp/runtime-adapter.js";
import type {
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../src/runtime.js";

test("acpx runtime adapter keeps one handle per managed agent and forwards scoped MCP definitions", async () => {
  const ensured: AcpRuntimeEnsureInput[] = [];
  const turns: AcpRuntimeTurnInput[] = [];
  const handle: AcpRuntimeHandle = {
    sessionKey: "session-child",
    backend: "acpx",
    runtimeSessionName: "encoded",
  };
  const runtime = {
    async ensureSession(input: AcpRuntimeEnsureInput) {
      ensured.push(input);
      return handle;
    },
    startTurn(input: AcpRuntimeTurnInput) {
      turns.push(input);
      return {
        requestId: input.requestId,
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => {},
        closeStream: async () => {},
      };
    },
    async getStatus() {
      return { summary: "ready" };
    },
    async close() {},
  };
  const adapter = createAcpxRuntimeAdapter({
    agents: ["codex", "claude"],
    createRuntime: () => runtime,
  });
  const base: EnsureRuntimeAgentInput = {
    agentId: "child-1",
    rootExecutionId: "root-1",
    sessionKey: "session-child",
    agent: "claude",
    cwd: "/workspace",
    mode: "persistent",
    mcpServers: [],
  };
  await adapter.ensureAgent(base, { onPermissionRequest: async () => undefined });
  await adapter.ensureAgent(
    {
      ...base,
      mcpServers: [
        {
          type: "http",
          name: "facade",
          url: "http://127.0.0.1:1234/mcp",
          headers: [],
        },
      ],
    },
    { onPermissionRequest: async () => undefined },
  );
  await adapter.startTurn({ agentId: "child-1", text: "review", requestId: "turn-1" }).result;

  assert.equal(ensured.length, 2);
  assert.equal(ensured[1]?.mcpServers?.length, 1);
  assert.equal(turns[0]?.handle, handle);
  assert.equal(turns[0]?.mode, "prompt");
});

test("acpx runtime adapter closes a pending initialization exactly once when destroyed", async () => {
  let releaseEnsure: (() => void) | undefined;
  const ensureGate = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  const handle: AcpRuntimeHandle = {
    sessionKey: "session-pending",
    backend: "acpx",
    runtimeSessionName: "pending",
  };
  const closes: Array<{ handle: AcpRuntimeHandle; discardPersistentState?: boolean }> = [];
  let ensureCount = 0;
  const runtime = {
    async ensureSession() {
      ensureCount += 1;
      await ensureGate;
      return handle;
    },
    startTurn(input: AcpRuntimeTurnInput) {
      return {
        requestId: input.requestId,
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => {},
        closeStream: async () => {},
      };
    },
    async getStatus() {
      return { summary: "ready" };
    },
    async close(input: { handle: AcpRuntimeHandle; discardPersistentState?: boolean }) {
      closes.push(input);
    },
  };
  const adapter = createAcpxRuntimeAdapter({
    agents: ["claude"],
    createRuntime: () => runtime,
  });
  const input: EnsureRuntimeAgentInput = {
    agentId: "pending-agent",
    rootExecutionId: "root-1",
    sessionKey: "session-pending",
    agent: "claude",
    cwd: "/workspace",
    mode: "persistent",
    mcpServers: [],
  };

  const firstEnsure = adapter.ensureAgent(input, { onPermissionRequest: async () => undefined });
  const secondEnsure = adapter.ensureAgent(input, { onPermissionRequest: async () => undefined });
  const firstDestroy = adapter.destroyAgent(input.agentId, { discardSession: false });
  const secondDestroy = adapter.destroyAgent(input.agentId, { discardSession: true });
  assert.equal(ensureCount, 1);
  assert.equal(closes.length, 0);

  releaseEnsure?.();
  await Promise.all([firstEnsure, secondEnsure, firstDestroy, secondDestroy]);

  assert.equal(ensureCount, 1);
  assert.equal(closes.length, 1);
  assert.equal(closes[0]?.handle, handle);
  assert.equal(closes[0]?.discardPersistentState, true);
  assert.throws(
    () => adapter.startTurn({ agentId: input.agentId, text: "late", requestId: "late-turn" }),
    { code: "SESSION_RESUME_REQUIRED" },
  );
});

test("acpx runtime adapter upgrades discard while a weaker close is in progress", async () => {
  let releaseClose: (() => void) | undefined;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const handle: AcpRuntimeHandle = {
    sessionKey: "session-upgrade",
    backend: "acpx",
    runtimeSessionName: "upgrade",
  };
  const closes: Array<boolean | undefined> = [];
  const runtime = {
    async ensureSession() {
      return handle;
    },
    startTurn(input: AcpRuntimeTurnInput) {
      return {
        requestId: input.requestId,
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => {},
        closeStream: async () => {},
      };
    },
    async getStatus() {
      return { summary: "ready" };
    },
    async close(input: { discardPersistentState?: boolean }) {
      closes.push(input.discardPersistentState);
      if (closes.length === 1) {
        await closeGate;
      }
    },
  };
  const adapter = createAcpxRuntimeAdapter({ agents: ["claude"], createRuntime: () => runtime });
  const input: EnsureRuntimeAgentInput = {
    agentId: "upgrade-agent",
    rootExecutionId: "root-1",
    sessionKey: "session-upgrade",
    agent: "claude",
    cwd: "/workspace",
    mode: "persistent",
    mcpServers: [],
  };
  await adapter.ensureAgent(input, { onPermissionRequest: async () => undefined });

  const weakerDestroy = adapter.destroyAgent(input.agentId, { discardSession: false });
  assert.deepEqual(closes, [false]);
  const strongerDestroy = adapter.destroyAgent(input.agentId, { discardSession: true });
  releaseClose?.();
  await Promise.all([weakerDestroy, strongerDestroy]);

  assert.deepEqual(closes, [false, true]);
});
