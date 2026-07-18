import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentDiagnostics } from "../src/mcp/diagnostics/index.js";
import type { FacadeEvent, FacadeSnapshot } from "../src/mcp/facade/types.js";

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

function assertTimelineValue<T>(result: IteratorResult<T, number>): T {
  assert.equal(result.done, false);
  return result.value;
}

function createFakeScheduler() {
  type Timer = { callback: () => void; ms: number; active: boolean };
  const timers: Timer[] = [];
  return {
    scheduler: {
      setTimeout(callback: () => void, ms: number): Timer {
        const timer = { callback, ms, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout(handle: unknown): void {
        (handle as Timer).active = false;
      },
    },
    runActive(ms: number): void {
      for (const timer of timers.filter((candidate) => candidate.active && candidate.ms === ms)) {
        timer.active = false;
        timer.callback();
      }
    },
    activeDelays(): number[] {
      return timers.filter((candidate) => candidate.active).map((candidate) => candidate.ms);
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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

test("agent diagnostics rejects snapshots with malformed consumed nested fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-event-schema-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const instanceId = "cdcdcdcdcdcdcdcdcdcdcdcd";
  const agentId = "45454545-4545-4545-8545-454545454545";
  await writeJson(path.join(directory, `${instanceId}.json`), {
    ...snapshot({ [agentId]: agent({ agentId }) }),
    events: [
      {
        cursor: 1,
        rootExecutionId: "root-1",
        type: "turn.text_delta",
        agentId,
        timestamp: now,
        data: { stream: "output", text: "invalid cursor" },
      },
    ],
  });
  const badAgentId = "46464646-4646-4646-8646-464646464646";
  await writeJson(path.join(directory, "cececececececececececece.json"), {
    ...snapshot({
      [badAgentId]: {
        ...agent({ agentId: badAgentId }),
        lastError: { code: "BROKEN", message: 42, retryable: false },
      } as unknown as FacadeSnapshot["agents"][string],
    }),
  });
  const badTurnAgentId = "47474747-4747-4747-8747-474747474747";
  await writeJson(path.join(directory, "cfcfcfcfcfcfcfcfcfcfcfcf.json"), {
    ...snapshot({
      [badTurnAgentId]: {
        ...agent({ agentId: badTurnAgentId }),
        activeTurnId: "turn-bad",
      },
    }),
    turns: {
      "turn-bad": {
        turnId: "turn-bad",
        agentId: badTurnAgentId,
        state: "waiting_permission",
        revision: 1,
        pendingPermissionId: 99,
        createdAt: now,
      },
    },
  });
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () => ({ state: "running", pid: 123, token: "token", createdAt: now }),
  });

  const result = await diagnostics.listAgents({ includeAll: true });
  assert.equal(result.agents.length, 0);
  assert.equal(result.warnings.length, 3);
  assert.match(
    result.warnings.map((warning) => warning.message).join("\n"),
    /snapshot\.events\.0\.cursor.*snapshot\.agents\..*lastError\.message.*snapshot\.turns\.turn-bad\.pendingPermissionId/s,
  );
});

test("agent diagnostics attach does not cross a replacement generation", async (t) => {
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

  const terminal = assertTimelineValue(await pending);
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.kind === "terminal" ? terminal.reason : "", "instance_replaced");
  const done = await iterator.next();
  assert.equal(done.done, true);
  assert.equal(done.value, 1);
});

test("agent diagnostics attach performs a final drain before reporting a stopped instance", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-stop-drain-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const instanceId = "dededededededededededede";
  const agentId = "56565656-5656-4565-8565-565656565656";
  const snapshotPath = path.join(directory, `${instanceId}.json`);
  const changes: Array<() => void> = [];
  const fake = createFakeScheduler();
  let running = true;
  let snapshotReadCount = 0;
  await writeJson(snapshotPath, {
    ...snapshot({ [agentId]: agent({ agentId, state: "running" }) }),
    events: [],
  });
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () =>
      running
        ? { state: "running", pid: 123, token: "stable-token", createdAt: now }
        : { state: "stopped" },
    readFile: async (filePath) => {
      if (filePath === snapshotPath) {
        snapshotReadCount += 1;
      }
      return fs.readFile(filePath, "utf8");
    },
    watchFacadeChanges: (_facadesDir, onChange) => {
      changes.push(onChange);
      return { close() {} };
    },
    scheduler: fake.scheduler,
    fallbackMs: 1_000,
    finalDrainMs: 25,
  });

  const iterator = diagnostics.attachAgent(agentId, { history: 0 });
  assert.equal(assertTimelineValue(await iterator.next()).kind, "snapshot");
  const pending = iterator.next();
  await waitUntil(() => changes.length === 1);

  running = false;
  changes[0]?.();
  fake.runActive(250);
  await waitUntil(() => snapshotReadCount === 2);
  await writeJson(snapshotPath, {
    ...snapshot({ [agentId]: agent({ agentId, state: "running" }) }),
    events: [
      {
        cursor: "1",
        rootExecutionId: "root-1",
        type: "turn.failed",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { error: { code: "STOPPED", message: "final event" } },
      },
    ],
  });
  fake.runActive(25);

  const drained = assertTimelineValue(await pending);
  assert.equal(drained.kind, "event");
  assert.equal(drained.kind === "event" ? drained.event.cursor : "", "1");
  const terminal = assertTimelineValue(await iterator.next());
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.kind === "terminal" ? terminal.reason : "", "instance_stopped");
});

test("agent diagnostics attach gates unrelated changes and enforces the minimum reread interval", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-debounce-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const instanceId = "ffffffffffffffffffffffff";
  const agentId = "77777777-7777-4777-8777-777777777777";
  const snapshotPath = path.join(directory, `${instanceId}.json`);
  const otherSnapshotPath = path.join(directory, "121212121212121212121212.json");
  const changes: Array<() => void> = [];
  const errors: Array<() => void> = [];
  const fake = createFakeScheduler();
  let snapshotReadCount = 0;
  let otherSnapshotReadCount = 0;
  await writeJson(snapshotPath, {
    ...snapshot({
      [agentId]: agent({ agentId, state: "running" }),
    }),
    events: [],
  });
  await writeJson(
    otherSnapshotPath,
    snapshot({
      "78787878-7878-4787-8787-787878787878": agent({
        agentId: "78787878-7878-4787-8787-787878787878",
      }),
    }),
  );
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () => ({ state: "running", pid: 123, token: "stable-token", createdAt: now }),
    readFile: async (filePath) => {
      if (filePath === snapshotPath) {
        snapshotReadCount += 1;
      }
      if (filePath === otherSnapshotPath) {
        otherSnapshotReadCount += 1;
      }
      return fs.readFile(filePath, "utf8");
    },
    watchFacadeChanges: (_facadesDir, onChange, onError) => {
      changes.push(onChange);
      errors.push(onError);
      return { close() {} };
    },
    scheduler: fake.scheduler,
    debounceMs: 25,
    fallbackMs: 1_000,
  });

  const iterator = diagnostics.attachAgent(agentId, { history: 0 });
  assert.equal(assertTimelineValue(await iterator.next()).kind, "snapshot");
  assert.equal(snapshotReadCount, 1);
  const pending = iterator.next();
  await Promise.resolve();
  assert.equal(changes.length, 1);

  await writeJson(
    otherSnapshotPath,
    snapshot({
      "78787878-7878-4787-8787-787878787878": agent({
        agentId: "78787878-7878-4787-8787-787878787878",
        state: "running",
      }),
    }),
  );
  errors[0]?.();
  errors[0]?.();
  assert.equal(snapshotReadCount, 1);
  fake.runActive(25);
  assert.equal(snapshotReadCount, 1);
  assert.ok(fake.activeDelays().includes(250));
  fake.runActive(250);
  await waitUntil(() => changes.length === 2);
  assert.equal(snapshotReadCount, 1);

  const events: FacadeEvent[] = Array.from({ length: 10_000 }, (_, index) => ({
    cursor: String(index + 1),
    rootExecutionId: "root-1",
    type: "turn.text_delta",
    agentId,
    turnId: "turn-1",
    timestamp: now,
    data: { stream: "output", text: `burst-${index + 1}` },
  }));
  await writeJson(snapshotPath, {
    ...snapshot({
      [agentId]: agent({ agentId, state: "running" }),
    }),
    events,
  });
  changes[1]?.();
  changes[1]?.();
  changes[1]?.();
  assert.equal(snapshotReadCount, 1);

  fake.runActive(25);
  assert.equal(snapshotReadCount, 1);
  fake.runActive(250);
  const firstEvent = assertTimelineValue(await pending);
  assert.equal(firstEvent.kind, "event");
  assert.equal(firstEvent.kind === "event" ? firstEvent.event.cursor : "", "1");
  assert.equal(snapshotReadCount, 2);
  assert.equal(otherSnapshotReadCount, 1);
  await iterator.return(0);
});

test("agent diagnostics attach projects event allowlists without poison fields and caps long history", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-harden-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const instanceId = "abababababababababababab";
  const agentId = "66666666-6666-4666-8666-666666666666";
  const events: FacadeEvent[] = Array.from({ length: 10_000 }, (_, index) => ({
    cursor: String(index + 1),
    rootExecutionId: "root-1",
    type: "turn.text_delta",
    agentId,
    turnId: "turn-1",
    timestamp: now,
    data: { stream: "output", text: `event-${index + 1}` },
  }));
  events.push(
    {
      cursor: "10001",
      rootExecutionId: "root-1",
      type: "turn.text_delta",
      agentId,
      turnId: "turn-1",
      timestamp: now,
      data: { stream: "thought", text: "secret-thought" },
    },
    {
      cursor: "10002",
      rootExecutionId: "root-1",
      type: "turn.tool_call",
      agentId,
      turnId: "turn-1",
      timestamp: now,
      data: {
        toolCallId: "tool-1",
        status: "completed",
        title: "Read file",
        kind: "read",
        locations: [{ path: "src/index.ts", line: 12, column: 3, raw: "drop-me" }],
        rawInput: "secret-input",
        content: "secret-content",
      },
    },
  );
  await writeJson(path.join(directory, `${instanceId}.json`), {
    ...snapshot({
      [agentId]: agent({ agentId, state: "destroyed" }),
    }),
    events,
  });
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () => ({ state: "running", pid: 123, token: "token", createdAt: now }),
  });

  const iterator = diagnostics.attachAgent(agentId, { history: 4 });
  assert.equal(assertTimelineValue(await iterator.next()).kind, "snapshot");
  const projected = [
    assertTimelineValue(await iterator.next()),
    assertTimelineValue(await iterator.next()),
    assertTimelineValue(await iterator.next()),
    assertTimelineValue(await iterator.next()),
  ];
  assert.deepEqual(
    projected.map((item) => (item.kind === "event" ? item.event.cursor : "")),
    ["9999", "10000", "10001", "10002"],
  );
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /secret-thought|secret-input|secret-content|drop-me/);
  const thought = projected[2];
  assert.equal(thought.kind === "event" ? thought.event.detail.omitted : undefined, true);
  const tool = projected[3];
  assert.deepEqual(tool.kind === "event" ? tool.event.detail.locations : undefined, [
    { path: "src/index.ts", line: 12, column: 3 },
  ]);
});

test("agent diagnostics truncates all allowlisted diagnostic text fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-diagnostics-truncate-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const instanceId = "343434343434343434343434";
  const agentId = "89898989-8989-4898-8989-898989898989";
  const longText = "x".repeat(2_001);
  await writeJson(path.join(directory, `${instanceId}.json`), {
    ...snapshot({
      [agentId]: {
        ...agent({ agentId, state: "destroyed" }),
        lastError: { code: "LONG", message: longText, retryable: false },
      },
    }),
    events: [
      {
        cursor: "1",
        rootExecutionId: "root-1",
        type: "turn.status",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { text: longText },
      },
      {
        cursor: "2",
        rootExecutionId: "root-1",
        type: "turn.tool_call",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { title: longText },
      },
      {
        cursor: "3",
        rootExecutionId: "root-1",
        type: "turn.failed",
        agentId,
        turnId: "turn-1",
        timestamp: now,
        data: { message: longText },
      },
    ],
  });
  const diagnostics = createAgentDiagnostics({
    facadesDir: directory,
    probeLock: async () => ({ state: "running", pid: 123, token: "token", createdAt: now }),
  });

  const resolved = await diagnostics.resolveAgent(agentId);
  assert.equal(resolved.ok, true);
  const lastError = resolved.ok
    ? (resolved.agent.lastError as unknown as Record<string, unknown>)
    : {};
  assert.equal(typeof lastError.message === "string" ? lastError.message.length : 0, 2_000);
  assert.equal(lastError.truncated, true);

  const iterator = diagnostics.attachAgent(agentId, { history: 3 });
  assert.equal(assertTimelineValue(await iterator.next()).kind, "snapshot");
  for (const field of ["text", "title", "message"]) {
    const item = assertTimelineValue(await iterator.next());
    assert.equal(item.kind === "event" ? item.event.summary.length : 0, 2_000);
    assert.equal(item.kind === "event" ? item.event.truncated : false, true);
    assert.equal(
      item.kind === "event" && typeof item.event.detail[field] === "string"
        ? item.event.detail[field].length
        : 0,
      2_000,
    );
    assert.equal(item.kind === "event" ? item.event.detail.truncated : false, true);
  }
});
