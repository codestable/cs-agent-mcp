import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentDiagnostics } from "../src/mcp/diagnostics/index.js";
import type { FacadeSnapshot } from "../src/mcp/facade/types.js";

const now = "2026-07-17T00:00:00.000Z";

function snapshot(agents: FacadeSnapshot["agents"]): FacadeSnapshot {
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

function agent(input: {
  agentId: string;
  rootExecutionId?: string;
  kind?: "root" | "managed";
  state?: FacadeSnapshot["agents"][string]["state"];
  cwd?: string;
}): FacadeSnapshot["agents"][string] {
  return {
    agentId: input.agentId,
    rootExecutionId: input.rootExecutionId ?? "root-1",
    kind: input.kind ?? "managed",
    agent: "claude",
    cwd: input.cwd ?? "/workspace",
    mode: "persistent",
    depth: input.kind === "root" ? 0 : 1,
    state: input.state ?? "idle",
    queueDepth: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function nextWithTimeout<T>(
  iterator: AsyncGenerator<T, number>,
  timeoutMs: number,
): Promise<IteratorResult<T, number> | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function assertTimelineValue<T>(result: IteratorResult<T, number>): T {
  assert.equal(result.done, false);
  return result.value;
}

test("agent diagnostics discovers precise snapshot files and maps instance/agent DTOs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const runningId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const stoppedId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  await writeJson(
    path.join(directory, `${runningId}.json`),
    snapshot({
      "root-agent": agent({
        agentId: "root-agent",
        kind: "root",
        cwd: "/running-root",
        state: "idle",
      }),
      "11111111-1111-4111-8111-111111111111": agent({
        agentId: "11111111-1111-4111-8111-111111111111",
        state: "running",
      }),
      "22222222-2222-4222-8222-222222222222": agent({
        agentId: "22222222-2222-4222-8222-222222222222",
        state: "destroyed",
      }),
    }),
  );
  await writeJson(
    path.join(directory, `${stoppedId}.json`),
    snapshot({
      "33333333-3333-4333-8333-333333333333": agent({
        agentId: "33333333-3333-4333-8333-333333333333",
        state: "idle",
      }),
    }),
  );
  await writeJson(path.join(directory, `${runningId}.json.tmp`), { ignored: true });
  await writeJson(path.join(directory, `${runningId}.json.lock`), { ignored: true });
  await writeJson(path.join(directory, `${runningId}.json.token.candidate`), { ignored: true });

  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async (lockPath) =>
      lockPath.includes(runningId)
        ? { state: "running", pid: 123, token: "running-token", createdAt: now }
        : { state: "stopped" },
  });

  const visible = await diagnostics.listAgents();
  assert.deepEqual(
    visible.agents.map((candidate) => candidate.agentId),
    ["root-agent", "11111111-1111-4111-8111-111111111111"],
  );
  assert.equal(visible.warnings.length, 0);
  assert.equal(visible.agents[0]?.instance.instanceId, runningId);
  assert.equal(visible.agents[0]?.instance.state, "running");
  assert.equal(visible.agents[0]?.instance.rootCwd, "/running-root");

  const all = await diagnostics.listAgents({ includeAll: true });
  assert.deepEqual(
    all.agents.map((candidate) => `${candidate.instance.state}:${candidate.agentId}`),
    [
      "running:root-agent",
      "running:11111111-1111-4111-8111-111111111111",
      "running:22222222-2222-4222-8222-222222222222",
      "stopped:33333333-3333-4333-8333-333333333333",
    ],
  );
});

test("agent diagnostics resolves selectors across the full readable set and fails closed on corrupt prefixes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-selector-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  await writeJson(
    path.join(directory, "cccccccccccccccccccccccc.json"),
    snapshot({
      "44444444-4444-4444-8444-444444444444": agent({
        agentId: "44444444-4444-4444-8444-444444444444",
        state: "destroyed",
      }),
      "44444444-5555-4555-8555-555555555555": agent({
        agentId: "44444444-5555-4555-8555-555555555555",
      }),
    }),
  );
  await fs.writeFile(path.join(directory, "dddddddddddddddddddddddd.json"), "{not-json", "utf8");
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () => ({ state: "running", pid: 123, token: "token", createdAt: now }),
  });

  const hidden = await diagnostics.resolveAgent("44444444-4444-4444-8444-444444444444");
  assert.equal(hidden.ok, true);
  assert.equal(hidden.ok ? hidden.agent.agentId : "", "44444444-4444-4444-8444-444444444444");
  assert.equal(hidden.warnings.length, 1);

  const ambiguous = await diagnostics.resolveAgent("44444444");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.ok ? "" : ambiguous.code, "AGENT_SELECTOR_UNSAFE");
  assert.match(ambiguous.ok ? "" : ambiguous.message, /complete agent id/i);
});

test("agent diagnostics attach drains cursor events before reporting an instance replacement", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-attach-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const instanceId = "eeeeeeeeeeeeeeeeeeeeeeee";
  const agentId = "55555555-5555-4555-8555-555555555555";
  const snapshotPath = path.join(directory, `${instanceId}.json`);
  let token = "generation-one";
  await writeJson(snapshotPath, {
    ...snapshot({
      [agentId]: agent({ agentId, state: "running" }),
    }),
    events: [
      {
        cursor: "1",
        rootExecutionId: "root-1",
        type: "turn.text_delta",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { stream: "output", text: "first" },
      },
    ],
  });
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () => ({ state: "running", pid: 123, token, createdAt: now }),
  });

  const iterator = diagnostics.attachAgent(agentId, { history: 1 });
  assert.equal(assertTimelineValue(await iterator.next()).kind, "snapshot");
  assert.equal(assertTimelineValue(await iterator.next()).kind, "event");

  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeJson(snapshotPath, {
    ...snapshot({
      [agentId]: agent({ agentId, state: "running" }),
    }),
    events: [
      {
        cursor: "1",
        rootExecutionId: "root-1",
        type: "turn.text_delta",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { stream: "output", text: "first" },
      },
      {
        cursor: "2",
        rootExecutionId: "root-1",
        type: "turn.text_delta",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { stream: "output", text: "second" },
      },
    ],
  });
  token = "generation-two";

  const drained = await pending;
  assert.equal(assertTimelineValue(drained).kind, "event");
  const terminal = await nextWithTimeout(iterator, 200);
  assert.notEqual(terminal, "timeout");
  const terminalItem = terminal === "timeout" ? undefined : assertTimelineValue(terminal);
  assert.equal(terminalItem?.kind, "terminal");
  assert.equal(terminalItem?.kind === "terminal" ? terminalItem.reason : "", "instance_replaced");
});
