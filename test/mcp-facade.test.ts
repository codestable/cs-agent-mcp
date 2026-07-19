import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MultiAgentFacade } from "../src/mcp/facade/facade.js";
import { createFacadeIdentityIssuer } from "../src/mcp/facade/identity.js";
import { createInMemoryFacadeStore } from "../src/mcp/facade/store.js";
import type {
  AgentRuntimeAdapter,
  EnsureRuntimeAgentInput,
  FacadeActor,
  FacadeLimits,
  FacadeStore,
  RuntimeAgentHooks,
  RuntimeTurn,
  StartRuntimeTurnInput,
} from "../src/mcp/facade/types.js";
import { startFacadeHttpServer } from "../src/mcp/transport/http.js";
import { createFacadeMcpServer } from "../src/mcp/transport/server.js";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
} from "../src/runtime.js";

const TEST_WORKSPACE_DIRECTORY = await fs.mkdtemp(
  path.join(os.tmpdir(), "cs-agent-facade-workspace-"),
);
const TEST_WORKSPACE = await fs.realpath(TEST_WORKSPACE_DIRECTORY);
after(async () => await fs.rm(TEST_WORKSPACE_DIRECTORY, { recursive: true, force: true }));

class FakeAgentRuntime implements AgentRuntimeAdapter {
  readonly ensured: Array<{
    input: EnsureRuntimeAgentInput;
    hooks: RuntimeAgentHooks;
  }> = [];
  readonly started: StartRuntimeTurnInput[] = [];
  readonly destroyed: string[] = [];

  listAgents(): string[] {
    return ["pi", "openclaw", "codex", "claude", "missing"];
  }

  async probeAgent(agent: string): Promise<{ available: boolean; reason?: string }> {
    return agent === "missing"
      ? { available: false, reason: "not installed" }
      : { available: true };
  }

  async ensureAgent(input: EnsureRuntimeAgentInput, hooks: RuntimeAgentHooks): Promise<void> {
    this.ensured.push({ input, hooks });
  }

  startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    const events = (async function* (): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "text_delta", text: `review:${input.text}`, stream: "output" };
    })();
    const result: Promise<AcpRuntimeTurnResult> = Promise.resolve({
      status: "completed",
      stopReason: "end_turn",
    });
    return {
      events,
      result,
      cancel: async () => {},
    };
  }

  async getStatus(): Promise<{ summary?: string }> {
    return { summary: "ready" };
  }

  async destroyAgent(agentId: string): Promise<void> {
    this.destroyed.push(agentId);
  }
}

class FailingShutdownAgentRuntime extends FakeAgentRuntime {
  async shutdown(): Promise<void> {
    throw new Error("adapter shutdown failed");
  }
}

class MaxTurnsFailedAgentRuntime extends FakeAgentRuntime {
  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {})(),
      result: Promise.resolve({
        status: "failed",
        error: {
          code: "RUNTIME",
          detailCode: "MAX_TURNS_EXCEEDED",
          message: "The agent reached its configured sessionOptions.maxTurns",
          retryable: false,
        },
      }),
      cancel: async () => {},
    };
  }
}

class PartialTimeoutAgentRuntime extends FakeAgentRuntime {
  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {
        yield { type: "text_delta", text: "partial review", stream: "output" };
      })(),
      result: Promise.resolve({
        status: "failed",
        error: {
          code: "TIMEOUT",
          message: "Timed out before the prompt completed",
        },
      }),
      cancel: async () => {},
    };
  }
}

class ControlledAgentRuntime extends FakeAgentRuntime {
  readonly completions: Array<(result: AcpRuntimeTurnResult) => void> = [];
  readonly cancellations: string[] = [];

  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    let complete: ((result: AcpRuntimeTurnResult) => void) | undefined;
    const result = new Promise<AcpRuntimeTurnResult>((resolve) => {
      complete = resolve;
    });
    this.completions.push((value) => complete?.(value));
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {})(),
      result,
      cancel: async () => {
        this.cancellations.push(input.requestId);
        complete?.({ status: "cancelled", stopReason: "cancelled" });
      },
    };
  }
}

class BurstTextAgentRuntime extends FakeAgentRuntime {
  constructor(private readonly deltaCount: number) {
    super();
  }

  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    const deltaCount = this.deltaCount;
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {
        for (let index = 0; index < deltaCount; index += 1) {
          yield { type: "text_delta", text: "x", stream: "output" };
        }
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    };
  }
}

class MixedEventAgentRuntime extends FakeAgentRuntime {
  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {
        yield { type: "text_delta", text: "A", stream: "output", tag: "agent_message_chunk" };
        yield { type: "text_delta", text: "B", stream: "output", tag: "agent_message_chunk" };
        yield { type: "text_delta", text: "T1", stream: "thought", tag: "agent_thought_chunk" };
        yield { type: "text_delta", text: "T2", stream: "thought", tag: "agent_thought_chunk" };
        yield { type: "text_delta", text: "C", stream: "output", tag: "agent_message_chunk" };
        yield { type: "tool_call", text: "inspect", toolCallId: "tool-1" };
        yield { type: "text_delta", text: "D", stream: "output", tag: "agent_message_chunk" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    };
  }
}

class ThrowingEventAgentRuntime extends FakeAgentRuntime {
  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {
        yield { type: "text_delta", text: "before-error", stream: "output" };
        throw new Error("event stream failed");
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    };
  }
}

class FailOnceAgentRuntime extends FakeAgentRuntime {
  private shouldFail = true;

  override async ensureAgent(
    input: EnsureRuntimeAgentInput,
    hooks: RuntimeAgentHooks,
  ): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("create failed");
    }
    await super.ensureAgent(input, hooks);
  }
}

class GatedEnsureAgentRuntime extends FakeAgentRuntime {
  private gate?: Promise<void>;
  private releaseGate?: () => void;

  blockEnsures(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  releaseEnsures(): void {
    this.releaseGate?.();
    this.gate = undefined;
    this.releaseGate = undefined;
  }

  override async ensureAgent(
    input: EnsureRuntimeAgentInput,
    hooks: RuntimeAgentHooks,
  ): Promise<void> {
    const gate = this.gate;
    await super.ensureAgent(input, hooks);
    await gate;
  }
}

class PermissionAgentRuntime extends FakeAgentRuntime {
  decision?: AcpPermissionDecision;

  override startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
    this.started.push(input);
    const request: AcpPermissionRequest = {
      sessionId: input.agentId,
      raw: {
        sessionId: input.agentId,
        toolCall: { toolCallId: "write-1", title: "write file", kind: "edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
      inferredKind: "edit",
    };
    const result = (async (): Promise<AcpRuntimeTurnResult> => {
      const ensured = this.ensured.find((candidate) => candidate.input.agentId === input.agentId);
      this.decision = await ensured?.hooks.onPermissionRequest(request, {
        signal: new AbortController().signal,
      });
      return { status: "completed" };
    })();
    return {
      events: (async function* (): AsyncIterable<AcpRuntimeEvent> {})(),
      result,
      cancel: async () => {},
    };
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await nextTask();
  }
}

function createHarness(
  runtime = new FakeAgentRuntime(),
  limits?: Partial<FacadeLimits>,
  allowedCwdRoots = [TEST_WORKSPACE],
  store: FacadeStore = createInMemoryFacadeStore(),
) {
  const identity = createFacadeIdentityIssuer({ store });
  const facade = new MultiAgentFacade({
    store,
    identity,
    runtime,
    rootExecutionId: "root-execution",
    allowedCwdRoots,
    mcpServersForToken: (issuedIdentity): McpServer[] => [
      {
        type: "http",
        name: "acpx-facade",
        url: "http://127.0.0.1:43123/mcp",
        headers: [{ name: "Authorization", value: `Bearer ${issuedIdentity}` }],
      },
    ],
    limits,
  });
  return { facade, identity, runtime, store };
}

test("MultiAgentFacade closes its public gate and propagates runtime shutdown failures", async () => {
  const { facade } = createHarness(new FailingShutdownAgentRuntime());
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };

  const shutdown = facade.shutdown();
  await assert.rejects(facade.capabilities({}, actor), { code: "SESSION_RESUME_REQUIRED" });
  await assert.rejects(shutdown, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(
      error.errors.some(
        (cause) => cause instanceof Error && cause.message === "adapter shutdown failed",
      ),
      true,
    );
    return true;
  });
});

test("MultiAgentFacade rejects a workspace symlink that escapes an allowed root", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-workspace-root-"));
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside");
  const escape = path.join(root, "escape");
  await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
  await fs.symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  const runtime = new FakeAgentRuntime();
  const { facade } = createHarness(runtime, undefined, [root]);
  const rootAgent = await facade.bootstrapRoot({ agent: "codex", cwd: root });
  const actor: FacadeActor = {
    rootExecutionId: rootAgent.rootExecutionId,
    agentId: rootAgent.agentId,
  };

  await assert.rejects(facade.createAgent({ agent: "claude", cwd: escape }, actor), {
    code: "UNAUTHORIZED",
  });
  assert.equal(runtime.ensured.length, 0);
  await assert.rejects(
    facade.createAgent({ agent: "claude", cwd: path.join(root, "missing") }, actor),
    { code: "UNAUTHORIZED" },
  );
});

test("MultiAgentFacade revalidates a dormant agent cwd before resume", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-resume-root-"));
  const root = path.join(directory, "root");
  const work = path.join(root, "work");
  const outside = path.join(directory, "outside");
  await Promise.all([fs.mkdir(work, { recursive: true }), fs.mkdir(outside)]);
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  const runtime = new FakeAgentRuntime();
  const { facade, store } = createHarness(runtime, undefined, [root]);
  const rootAgent = await facade.bootstrapRoot({ agent: "codex", cwd: root });
  const actor: FacadeActor = {
    rootExecutionId: rootAgent.rootExecutionId,
    agentId: rootAgent.agentId,
  };
  const child = await facade.createAgent({ agent: "claude", cwd: work }, actor);
  await store.update((snapshot) => {
    const current = snapshot.agents[child.agentId];
    assert.ok(current);
    current.state = "dormant";
  });
  await fs.rm(work, { recursive: true });
  await fs.symlink(outside, work, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    facade.send(
      { agentId: child.agentId, content: "escape", idempotencyKey: "resume-symlink" },
      actor,
    ),
    { code: "SESSION_RESUME_REQUIRED" },
  );
  assert.equal(runtime.ensured.length, 1);
  assert.equal(await store.read((snapshot) => snapshot.agents[child.agentId]?.state), "failed");
});

test("MultiAgentFacade does not revive an agent destroyed while creation is pending", async () => {
  const runtime = new GatedEnsureAgentRuntime();
  runtime.blockEnsures();
  const { facade, store } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };

  const creation = facade.createAgent({ agent: "claude" }, actor);
  await waitForCondition(() => runtime.ensured.length === 1);
  const agentId = runtime.ensured[0]?.input.agentId;
  assert.ok(agentId);
  const rejectedCreation = assert.rejects(creation, { code: "AGENT_NOT_FOUND" });
  const destroyed = await facade.destroyAgent({ agentId }, actor);
  runtime.releaseEnsures();

  await rejectedCreation;
  assert.equal(destroyed.state, "destroyed");
  assert.equal(await store.read((snapshot) => snapshot.agents[agentId]?.state), "destroyed");
});

test("MultiAgentFacade rejects a send while agent creation is pending", async () => {
  const runtime = new GatedEnsureAgentRuntime();
  runtime.blockEnsures();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };

  const creation = facade.createAgent({ agent: "claude" }, actor);
  await waitForCondition(() => runtime.ensured.length === 1);
  const agentId = runtime.ensured[0]?.input.agentId;
  assert.ok(agentId);
  await assert.rejects(
    facade.send({ agentId, content: "too early", idempotencyKey: "creating-send" }, actor),
    { code: "AGENT_NOT_READY" },
  );
  runtime.releaseEnsures();

  assert.equal((await creation).state, "idle");
  assert.equal(runtime.started.length, 0);
});

test("MultiAgentFacade resumes one dormant agent only once for concurrent sends", async () => {
  const runtime = new GatedEnsureAgentRuntime();
  const { facade, store } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  await store.update((snapshot) => {
    const current = snapshot.agents[child.agentId];
    assert.ok(current);
    current.state = "dormant";
  });
  runtime.blockEnsures();

  const first = facade.send(
    { agentId: child.agentId, content: "first", idempotencyKey: "resume-first" },
    actor,
  );
  await waitForCondition(() => runtime.ensured.length === 2);
  const second = facade.send(
    { agentId: child.agentId, content: "second", idempotencyKey: "resume-second" },
    actor,
  );
  await nextTask();
  assert.equal(runtime.ensured.length, 2);

  runtime.releaseEnsures();
  await Promise.all([first, second]);
  assert.equal(runtime.ensured.length, 2);
});

test("MultiAgentFacade does not revive interrupted creating or destroying agents", async () => {
  const { facade, store } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const creating = await facade.createAgent({ agent: "claude" }, actor);
  const destroying = await facade.createAgent({ agent: "codex" }, actor);
  const idle = await facade.createAgent({ agent: "pi" }, actor);
  await store.update((snapshot) => {
    const creatingAgent = snapshot.agents[creating.agentId];
    const destroyingAgent = snapshot.agents[destroying.agentId];
    assert.ok(creatingAgent);
    assert.ok(destroyingAgent);
    creatingAgent.state = "creating";
    destroyingAgent.state = "destroying";
  });

  await facade.recoverAfterRestart();

  assert.deepEqual(
    await store.read((snapshot) => ({
      creating: snapshot.agents[creating.agentId]?.state,
      destroying: snapshot.agents[destroying.agentId]?.state,
      idle: snapshot.agents[idle.agentId]?.state,
    })),
    { creating: "destroyed", destroying: "destroyed", idle: "dormant" },
  );
});

async function waitForTerminalTurn(facade: MultiAgentFacade, actor: FacadeActor, turnId: string) {
  let turn = await facade.getTurn({ turnId }, actor);
  while (!(["completed", "failed", "cancelled"] as const).includes(turn.state as never)) {
    const waited = await facade.waitTurn(
      { turnId, afterRevision: turn.revision, waitMs: 1_000 },
      actor,
    );
    turn = waited.turn;
  }
  return turn;
}

test("MultiAgentFacade rejects delegation beyond the configured depth", async () => {
  const { facade } = createHarness(new FakeAgentRuntime(), { maxDelegationDepth: 1 });
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, rootActor);
  const childActor: FacadeActor = {
    rootExecutionId: child.rootExecutionId,
    agentId: child.agentId,
  };

  await assert.rejects(facade.createAgent({ agent: "codex" }, childActor), {
    code: "DELEGATION_DEPTH_EXCEEDED",
  });
});

test("MultiAgentFacade reports bounded availability probes and rejects unavailable agents", async () => {
  const { facade } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };

  const unprobed = await facade.capabilities({}, actor);
  assert.equal(
    unprobed.agents.find((candidate) => candidate.agent === "claude")?.availability,
    "unknown",
  );
  const probed = await facade.capabilities({ probeAgents: ["missing"] }, actor);
  assert.deepEqual(
    probed.agents.find((candidate) => candidate.agent === "missing"),
    { agent: "missing", availability: "unavailable", reason: "not installed" },
  );
  await assert.rejects(facade.createAgent({ agent: "missing" }, actor), {
    code: "AGENT_UNAVAILABLE",
    message: "not installed",
  });
});

test("MultiAgentFacade rejects creation beyond the managed agent limit", async () => {
  const { facade } = createHarness(new FakeAgentRuntime(), { maxManagedAgents: 1 });
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  await facade.createAgent({ agent: "claude" }, actor);

  await assert.rejects(facade.createAgent({ agent: "codex" }, actor), {
    code: "AGENT_LIMIT_REACHED",
  });
});

test("MultiAgentFacade releases managed agent capacity only after destroy", async () => {
  const { facade } = createHarness(new FailOnceAgentRuntime(), { maxManagedAgents: 1 });
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };

  await assert.rejects(facade.createAgent({ agent: "claude" }, actor), {
    code: "AGENT_UNAVAILABLE",
  });
  await assert.rejects(facade.createAgent({ agent: "codex" }, actor), {
    code: "AGENT_LIMIT_REACHED",
  });
  const failed = await facade.listAgents({ state: "failed" }, actor);
  assert.equal(failed.agents.length, 1);
  await facade.destroyAgent({ agentId: failed.agents[0]?.agentId ?? "" }, actor);
  const replacement = await facade.createAgent({ agent: "claude" }, actor);

  assert.equal(replacement.state, "idle");
});

test("MultiAgentFacade rejects sends beyond the per-agent queue limit", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime, { maxQueuedTurnsPerAgent: 1 });
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const active = await facade.send(
    { agentId: child.agentId, content: "active", idempotencyKey: "queue-limit-1" },
    actor,
  );
  await nextTask();
  const queued = await facade.send(
    { agentId: child.agentId, content: "queued", idempotencyKey: "queue-limit-2" },
    actor,
  );

  await assert.rejects(
    facade.send(
      { agentId: child.agentId, content: "rejected", idempotencyKey: "queue-limit-3" },
      actor,
    ),
    { code: "TURN_QUEUE_FULL", retryable: true },
  );
  await facade.cancel({ turnId: active.turnId }, actor);
  await facade.cancel({ turnId: queued.turnId }, actor);
});

test("MultiAgentFacade injects a scoped identity without recording its raw token", async () => {
  const { facade, identity, runtime, store } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };

  const child = await facade.createAgent({ agent: "claude" }, actor);

  assert.equal(child.kind, "managed");
  assert.equal(child.parentAgentId, root.agentId);
  assert.equal(child.cwd, TEST_WORKSPACE);
  assert.equal(child.depth, 1);
  assert.equal(child.state, "idle");
  assert.equal(runtime.ensured.length, 1);
  assert.equal(runtime.ensured[0]?.input.agentId, child.agentId);
  assert.equal(runtime.ensured[0]?.input.agent, "claude");
  const authorization = runtime.ensured[0]?.input.mcpServers[0];
  assert.equal(authorization && "type" in authorization ? authorization.type : undefined, "http");
  if (
    authorization &&
    "type" in authorization &&
    (authorization.type === "http" || authorization.type === "sse")
  ) {
    assert.match(authorization.headers[0]?.value ?? "", /^Bearer /);
    const issuedIdentity = authorization.headers[0]?.value.replace(/^Bearer /, "") ?? "";
    assert.deepEqual(await identity.authenticate(issuedIdentity), {
      rootExecutionId: root.rootExecutionId,
      agentId: child.agentId,
    });
    const persistedState = await store.read((snapshot) => JSON.stringify(snapshot));
    assert.equal(persistedState.includes(issuedIdentity), false);
    assert.equal(persistedState.includes("Authorization"), false);
    assert.equal(persistedState.includes("Bearer "), false);
  }
});

test("MultiAgentFacade sends one idempotent message and records its terminal reply", async () => {
  const { facade, runtime } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);

  const first = await facade.send(
    {
      agentId: child.agentId,
      content: "inspect the diff",
      idempotencyKey: "review-1",
    },
    actor,
  );
  const retried = await facade.send(
    {
      agentId: child.agentId,
      content: "inspect the diff",
      idempotencyKey: "review-1",
    },
    actor,
  );
  const turn = await waitForTerminalTurn(facade, actor, first.turnId);
  const waitedMessage = await facade.waitMessage({ turnId: first.turnId, waitMs: 1_000 }, actor);

  assert.deepEqual(retried, first);
  assert.equal(runtime.started.length, 1);
  assert.equal(turn.state, "completed");
  assert.equal(waitedMessage.status, "message");
  if (waitedMessage.status === "message") {
    assert.equal(waitedMessage.message.content, "review:inspect the diff");
    assert.equal(waitedMessage.message.inReplyTo, first.messageId);
  }
  const events = await facade.events({ turnId: first.turnId, afterCursor: "0" }, actor);
  assert.equal(
    events.events.some((event) => event.type === "turn.started"),
    true,
  );
  assert.equal(
    events.events.some((event) => event.type === "turn.text_delta"),
    true,
  );
  assert.equal(
    events.events.some((event) => event.type === "turn.completed"),
    true,
  );
});

test("MultiAgentFacade does not apply the send acceptance timeout to task completion", async () => {
  const { facade, runtime } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);

  const receipt = await facade.send(
    {
      agentId: child.agentId,
      content: "complete the full review",
      idempotencyKey: "acceptance-timeout-only",
      timeoutMs: 25,
    },
    actor,
  );
  const retried = await facade.send(
    {
      agentId: child.agentId,
      content: "complete the full review",
      idempotencyKey: "acceptance-timeout-only",
      timeoutMs: 50,
    },
    actor,
  );
  const turn = await waitForTerminalTurn(facade, actor, receipt.turnId);

  assert.deepEqual(retried, receipt);
  assert.equal(turn.state, "completed");
  assert.equal(turn.timeoutMs, undefined);
  assert.equal(runtime.started[0]?.timeoutMs, undefined);
});

test("MultiAgentFacade reuses and migrates a legacy timeout fingerprint", async () => {
  const { facade, runtime, store } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const input = {
    agentId: child.agentId,
    content: "complete the full review",
    idempotencyKey: "legacy-timeout-fingerprint",
    timeoutMs: 25,
  };
  const receipt = await facade.send(input, actor);
  const idempotencyId = `${actor.agentId}:${input.idempotencyKey}`;
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId,
        content: input.content,
        attachments: [],
        timeoutMs: input.timeoutMs,
      }),
    )
    .digest("hex");
  const currentFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId,
        content: input.content,
        attachments: [],
      }),
    )
    .digest("hex");
  await store.update((snapshot) => {
    const existing = snapshot.idempotency[idempotencyId];
    const turn = snapshot.turns[receipt.turnId];
    assert.ok(existing);
    assert.ok(turn);
    existing.fingerprint = legacyFingerprint;
    turn.timeoutMs = input.timeoutMs;
  });

  await assert.rejects(
    facade.send({ ...input, content: "different review", timeoutMs: 50 }, actor),
    { code: "IDEMPOTENCY_CONFLICT" },
  );

  const retried = await facade.send({ ...input, timeoutMs: 50 }, actor);
  const migratedFingerprint = await store.read(
    (snapshot) => snapshot.idempotency[idempotencyId]?.fingerprint,
  );
  await waitForTerminalTurn(facade, actor, receipt.turnId);

  assert.deepEqual(retried, receipt);
  assert.equal(migratedFingerprint, currentFingerprint);
  assert.equal(runtime.started.length, 1);
});

test("MultiAgentFacade rejects malformed legacy timeout fingerprint linkage", async () => {
  const { facade, store } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const input = {
    agentId: child.agentId,
    content: "complete the full review",
    idempotencyKey: "malformed-legacy-timeout-fingerprint",
    timeoutMs: 25,
  };
  const receipt = await facade.send(input, actor);
  await waitForTerminalTurn(facade, actor, receipt.turnId);
  const idempotencyId = `${actor.agentId}:${input.idempotencyKey}`;

  for (const malformedTimeoutMs of [null, "25", { value: 25 }, 0, -1, 1.5, 86_400_001]) {
    const malformedFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          agentId: input.agentId,
          content: input.content,
          attachments: [],
          timeoutMs: malformedTimeoutMs,
        }),
      )
      .digest("hex");
    await store.update((snapshot) => {
      const existing = snapshot.idempotency[idempotencyId];
      const turn = snapshot.turns[receipt.turnId];
      assert.ok(existing);
      assert.ok(turn);
      existing.fingerprint = malformedFingerprint;
      turn.timeoutMs = malformedTimeoutMs as unknown as number;
    });

    await assert.rejects(facade.send({ ...input, timeoutMs: 50 }, actor), {
      code: "IDEMPOTENCY_CONFLICT",
    });
  }

  await store.update((snapshot) => {
    const existing = snapshot.idempotency[idempotencyId];
    const turn = snapshot.turns[receipt.turnId];
    assert.ok(existing);
    assert.ok(turn);
    existing.fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          agentId: input.agentId,
          content: input.content,
          attachments: [],
          timeoutMs: input.timeoutMs,
        }),
      )
      .digest("hex");
    delete turn.timeoutMs;
  });
  await assert.rejects(facade.send({ ...input, timeoutMs: 50 }, actor), {
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("MultiAgentFacade rejects internally inconsistent legacy receipt records", async () => {
  const { facade, store } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const input = {
    agentId: child.agentId,
    content: "complete the full review",
    idempotencyKey: "inconsistent-legacy-receipt",
    timeoutMs: 25,
  };
  const receipt = await facade.send(input, actor);
  await waitForTerminalTurn(facade, actor, receipt.turnId);
  const idempotencyId = `${actor.agentId}:${input.idempotencyKey}`;
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId,
        content: input.content,
        attachments: [],
        timeoutMs: input.timeoutMs,
      }),
    )
    .digest("hex");

  for (const corruptedRecord of ["turn", "message"] as const) {
    await store.update((snapshot) => {
      const existing = snapshot.idempotency[idempotencyId];
      const turn = snapshot.turns[receipt.turnId];
      const message = snapshot.messages[receipt.messageId];
      assert.ok(existing);
      assert.ok(turn);
      assert.ok(message);
      existing.fingerprint = legacyFingerprint;
      turn.timeoutMs = input.timeoutMs;
      turn.turnId =
        corruptedRecord === "turn" ? "00000000-0000-4000-8000-000000000201" : receipt.turnId;
      message.messageId =
        corruptedRecord === "message" ? "00000000-0000-4000-8000-000000000202" : receipt.messageId;
    });

    await assert.rejects(facade.send({ ...input, timeoutMs: 50 }, actor), {
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
});

test("MultiAgentFacade rejects a legacy fingerprint linked to the wrong turn", async () => {
  const { facade, store } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const expectedTarget = await facade.createAgent({ agent: "claude" }, actor);
  const wrongTarget = await facade.createAgent({ agent: "codex" }, actor);
  const input = {
    agentId: expectedTarget.agentId,
    content: "complete the full review",
    idempotencyKey: "wrong-legacy-turn-linkage",
    timeoutMs: 25,
  };
  const receipt = await facade.send(input, actor);
  const wrongReceipt = await facade.send(
    {
      agentId: wrongTarget.agentId,
      content: "unrelated task",
      idempotencyKey: "wrong-legacy-turn-source",
    },
    actor,
  );
  await Promise.all([
    waitForTerminalTurn(facade, actor, receipt.turnId),
    waitForTerminalTurn(facade, actor, wrongReceipt.turnId),
  ]);
  const idempotencyId = `${actor.agentId}:${input.idempotencyKey}`;
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId,
        content: input.content,
        attachments: [],
        timeoutMs: input.timeoutMs,
      }),
    )
    .digest("hex");
  await store.update((snapshot) => {
    const existing = snapshot.idempotency[idempotencyId];
    const wrongTurn = snapshot.turns[wrongReceipt.turnId];
    assert.ok(existing);
    assert.ok(wrongTurn);
    existing.fingerprint = legacyFingerprint;
    existing.receipt = wrongReceipt;
    wrongTurn.timeoutMs = input.timeoutMs;
  });

  await assert.rejects(facade.send({ ...input, timeoutMs: 50 }, actor), {
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("MultiAgentFacade retains partial timeout events without creating a final message", async () => {
  const { facade } = createHarness(new PartialTimeoutAgentRuntime());
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);

  const receipt = await facade.send(
    {
      agentId: child.agentId,
      content: "complete the full review",
      idempotencyKey: "partial-timeout",
    },
    actor,
  );
  const result = await facade.waitMessage({ turnId: receipt.turnId, waitMs: 1_000 }, actor);
  const events = await facade.events({ turnId: receipt.turnId, afterCursor: "0" }, actor);

  assert.equal(result.status, "terminal_without_message");
  assert.equal(result.turn.state, "failed");
  assert.equal(result.turn.error?.code, "TIMEOUT");
  assert.equal(result.turn.resultMessageId, undefined);
  assert.equal(
    events.events.some(
      (event) =>
        event.type === "turn.text_delta" &&
        (event.data as { text?: string }).text === "partial review",
    ),
    true,
  );
});

test("MultiAgentFacade batches consecutive text deltas without losing output", async () => {
  const deltaCount = 1_000;
  const runtime = new BurstTextAgentRuntime(deltaCount);
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "stream", idempotencyKey: "batched-stream" },
    actor,
  );

  await waitForTerminalTurn(facade, actor, receipt.turnId);
  const response = await facade.waitMessage({ turnId: receipt.turnId }, actor);
  const events = await facade.events(
    { turnId: receipt.turnId, afterCursor: "0", limit: 1_000 },
    actor,
  );
  const textEvents = events.events.filter((event) => event.type === "turn.text_delta");

  assert.equal(textEvents.length, Math.ceil(deltaCount / 16));
  assert.equal(
    textEvents.map((event) => (event.data as { text: string }).text).join(""),
    "x".repeat(deltaCount),
  );
  assert.equal(response.status, "message");
  if (response.status === "message") {
    assert.equal(response.message.content, "x".repeat(deltaCount));
  }
});

test("MultiAgentFacade preserves mixed runtime event order while batching text", async () => {
  const { facade } = createHarness(new MixedEventAgentRuntime());
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "mixed", idempotencyKey: "mixed-events" },
    actor,
  );

  await waitForTerminalTurn(facade, actor, receipt.turnId);
  const response = await facade.waitMessage({ turnId: receipt.turnId }, actor);
  const page = await facade.events(
    { turnId: receipt.turnId, afterCursor: "0", limit: 1_000 },
    actor,
  );
  const runtimeEvents = page.events.filter(
    (event) => event.type === "turn.text_delta" || event.type === "turn.tool_call",
  );

  assert.deepEqual(
    runtimeEvents.map((event) => ({
      type: event.type,
      text: (event.data as { text?: string }).text,
      stream: (event.data as { stream?: string }).stream,
    })),
    [
      { type: "turn.text_delta", text: "AB", stream: "output" },
      { type: "turn.text_delta", text: "T1T2", stream: "thought" },
      { type: "turn.text_delta", text: "C", stream: "output" },
      { type: "turn.tool_call", text: "inspect", stream: undefined },
      { type: "turn.text_delta", text: "D", stream: "output" },
    ],
  );
  assert.equal(response.status, "message");
  if (response.status === "message") {
    assert.equal(response.message.content, "ABCD");
  }
});

test("MultiAgentFacade flushes a partial text batch before an event stream failure", async () => {
  const { facade } = createHarness(new ThrowingEventAgentRuntime());
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "fail", idempotencyKey: "stream-failure" },
    actor,
  );

  const turn = await waitForTerminalTurn(facade, actor, receipt.turnId);
  const page = await facade.events(
    { turnId: receipt.turnId, afterCursor: "0", limit: 1_000 },
    actor,
  );
  const textEvent = page.events.find((event) => event.type === "turn.text_delta");

  assert.equal(turn.state, "failed");
  assert.equal((textEvent?.data as { text?: string })?.text, "before-error");
});

test("MultiAgentFacade runs turns for one managed agent in FIFO order", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);

  const first = await facade.send(
    { agentId: child.agentId, content: "first", idempotencyKey: "fifo-1" },
    actor,
  );
  const second = await facade.send(
    { agentId: child.agentId, content: "second", idempotencyKey: "fifo-2" },
    actor,
  );
  await nextTask();

  assert.deepEqual(
    runtime.started.map((turn) => turn.text),
    ["first"],
  );
  runtime.completions[0]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, first.turnId);
  await nextTask();
  assert.deepEqual(
    runtime.started.map((turn) => turn.text),
    ["first", "second"],
  );
  runtime.completions[1]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, second.turnId);
});

test("MultiAgentFacade enforces the root-wide active turn limit across agents", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime, { maxConcurrentTurns: 1 });
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const firstAgent = await facade.createAgent({ agent: "claude" }, actor);
  const secondAgent = await facade.createAgent({ agent: "codex" }, actor);
  const first = await facade.send(
    { agentId: firstAgent.agentId, content: "first", idempotencyKey: "limit-1" },
    actor,
  );
  const second = await facade.send(
    { agentId: secondAgent.agentId, content: "second", idempotencyKey: "limit-2" },
    actor,
  );
  await nextTask();

  assert.equal(runtime.started.length, 1);
  runtime.completions[0]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, first.turnId);
  await nextTask();
  assert.equal(runtime.started.length, 2);
  runtime.completions[1]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, second.turnId);
});

test("MultiAgentFacade runs turns for different agents concurrently", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const firstAgent = await facade.createAgent({ agent: "claude" }, actor);
  const secondAgent = await facade.createAgent({ agent: "codex" }, actor);
  const first = await facade.send(
    { agentId: firstAgent.agentId, content: "first", idempotencyKey: "parallel-1" },
    actor,
  );
  const second = await facade.send(
    { agentId: secondAgent.agentId, content: "second", idempotencyKey: "parallel-2" },
    actor,
  );
  await nextTask();

  assert.deepEqual(new Set(runtime.started.map((turn) => turn.text)), new Set(["first", "second"]));
  assert.equal((await facade.getTurn({ turnId: first.turnId }, actor)).state, "running");
  assert.equal((await facade.getTurn({ turnId: second.turnId }, actor)).state, "running");

  runtime.completions[0]?.({ status: "completed" });
  runtime.completions[1]?.({ status: "completed" });
  await Promise.all([
    waitForTerminalTurn(facade, actor, first.turnId),
    waitForTerminalTurn(facade, actor, second.turnId),
  ]);
});

test("MultiAgentFacade wait many projects mixed ready and pending turns in input order", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade, store } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const agents = await Promise.all(
    ["claude", "codex", "pi", "openclaw"].map(
      async (agent) => await facade.createAgent({ agent }, actor),
    ),
  );
  const turns = await Promise.all(
    agents.map(
      async (agent, index) =>
        await facade.send(
          {
            agentId: agent.agentId,
            content: `wait-many-${index}`,
            idempotencyKey: `wait-many-${index}`,
          },
          actor,
        ),
    ),
  );
  await waitForCondition(() => runtime.started.length === turns.length);

  const messageId = "00000000-0000-4000-8000-000000000101";
  const permissionId = "00000000-0000-4000-8000-000000000102";
  await store.update((snapshot) => {
    const messageTurn = snapshot.turns[turns[0].turnId];
    messageTurn.state = "completed";
    messageTurn.resultMessageId = messageId;
    snapshot.messages[messageId] = {
      messageId,
      rootExecutionId: root.rootExecutionId,
      direction: "outbound",
      fromAgentId: messageTurn.agentId,
      toAgentId: root.agentId,
      turnId: messageTurn.turnId,
      inReplyTo: messageTurn.inputMessageId,
      content: "first ready",
      createdAt: new Date().toISOString(),
    };

    snapshot.turns[turns[1].turnId].state = "failed";

    const permissionTurn = snapshot.turns[turns[2].turnId];
    permissionTurn.state = "waiting_permission";
    permissionTurn.pendingPermissionId = permissionId;
    snapshot.permissions[permissionId] = {
      permissionId,
      rootExecutionId: root.rootExecutionId,
      agentId: permissionTurn.agentId,
      turnId: permissionTurn.turnId,
      state: "pending",
      request: {
        sessionId: permissionTurn.agentId,
        raw: {
          sessionId: permissionTurn.agentId,
          toolCall: { toolCallId: "wait-many-write", title: "write file", kind: "edit" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        inferredKind: "edit",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  });

  const result = await facade.waitMany(
    {
      turnIds: [
        turns[3].turnId,
        turns[0].turnId,
        turns[1].turnId,
        turns[2].turnId,
        turns[0].turnId,
      ],
      mode: "any",
    },
    actor,
  );

  assert.deepEqual(
    result.ready.map((item) => ({ status: item.status, turnId: item.turn.turnId })),
    [
      { status: "message", turnId: turns[0].turnId },
      { status: "terminal_without_message", turnId: turns[1].turnId },
      { status: "action_required", turnId: turns[2].turnId },
    ],
  );
  assert.deepEqual(result.pendingTurnIds, [turns[3].turnId, turns[2].turnId]);
  assert.equal(result.mode, "any");
  assert.equal(result.timedOut, false);
  assert.equal(Object.hasOwn(result, "retryAfterMs"), false);
});

test("MultiAgentFacade wait many validates raw batch length before deduplication", async () => {
  const { facade } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };

  await assert.rejects(facade.waitMany({ turnIds: [] }, actor), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(
    facade.waitMany(
      { turnIds: Array.from({ length: 65 }, () => "00000000-0000-4000-8000-000000000103") },
      actor,
    ),
    { code: "INVALID_ARGUMENT" },
  );
});

test("MultiAgentFacade wait many fails the whole batch for unknown or sibling turns", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const parent = await facade.createAgent({ agent: "claude" }, rootActor);
  const sibling = await facade.createAgent({ agent: "pi" }, rootActor);
  const parentActor: FacadeActor = {
    rootExecutionId: parent.rootExecutionId,
    agentId: parent.agentId,
  };
  const descendant = await facade.createAgent({ agent: "codex" }, parentActor);
  const visibleTurn = await facade.send(
    { agentId: descendant.agentId, content: "visible", idempotencyKey: "wait-many-visible" },
    parentActor,
  );
  const siblingTurn = await facade.send(
    { agentId: sibling.agentId, content: "sibling", idempotencyKey: "wait-many-sibling" },
    rootActor,
  );

  await assert.rejects(
    facade.waitMany(
      {
        turnIds: [visibleTurn.turnId, "00000000-0000-4000-8000-000000000104"],
      },
      parentActor,
    ),
    { code: "TURN_NOT_FOUND" },
  );
  await assert.rejects(
    facade.waitMany({ turnIds: [visibleTurn.turnId, siblingTurn.turnId] }, parentActor),
    { code: "UNAUTHORIZED" },
  );
});

test("MultiAgentFacade wait many timeout returns pending without cancelling turns", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "keep running", idempotencyKey: "wait-many-timeout" },
    actor,
  );
  await waitForCondition(() => runtime.started.length === 1);

  const result = await facade.waitMany({ turnIds: [receipt.turnId], waitMs: 0 }, actor);

  assert.deepEqual(result, {
    mode: "any",
    ready: [],
    pendingTurnIds: [receipt.turnId],
    timedOut: true,
    retryAfterMs: 0,
  });
  assert.equal((await facade.getTurn({ turnId: receipt.turnId }, actor)).state, "running");
  assert.deepEqual(runtime.cancellations, []);
});

test("MultiAgentFacade waitAll stays pending until every turn is terminal", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const firstAgent = await facade.createAgent({ agent: "claude" }, actor);
  const secondAgent = await facade.createAgent({ agent: "pi" }, actor);
  const first = await facade.send(
    { agentId: firstAgent.agentId, content: "first", idempotencyKey: "wait-all-first" },
    actor,
  );
  const second = await facade.send(
    { agentId: secondAgent.agentId, content: "second", idempotencyKey: "wait-all-second" },
    actor,
  );
  await waitForCondition(() => runtime.started.length === 2);

  let settled = false;
  const waiting = facade
    .waitAll({ turnIds: [first.turnId, second.turnId], waitMs: 1_000 }, actor)
    .finally(() => {
      settled = true;
    });
  await nextTask();
  runtime.completions[0]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, first.turnId);
  await nextTask();
  assert.equal(settled, false);

  runtime.completions[1]?.({ status: "completed" });
  const result = await waiting;

  assert.equal(result.mode, "all");
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.pendingTurnIds, []);
  assert.deepEqual(
    result.ready.map((item) => ({ status: item.status, turnId: item.turn.turnId })),
    [
      { status: "terminal_without_message", turnId: first.turnId },
      { status: "terminal_without_message", turnId: second.turnId },
    ],
  );
});

test("MultiAgentFacade waitAny is equivalent to wait many mode any", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "ready", idempotencyKey: "wait-any-wrapper" },
    actor,
  );
  await waitForCondition(() => runtime.started.length === 1);
  runtime.completions[0]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, receipt.turnId);

  assert.deepEqual(
    await facade.waitAny({ turnIds: [receipt.turnId] }, actor),
    await facade.waitMany({ turnIds: [receipt.turnId], mode: "any" }, actor),
  );
});

test("MultiAgentFacade waitAll returns permission early and can resume to terminal", async () => {
  const runtime = new PermissionAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "permission", idempotencyKey: "wait-all-permission" },
    actor,
  );

  const interrupted = await facade.waitAll({ turnIds: [receipt.turnId], waitMs: 1_000 }, actor);
  assert.equal(interrupted.timedOut, false);
  assert.deepEqual(interrupted.pendingTurnIds, [receipt.turnId]);
  assert.equal(interrupted.ready[0]?.status, "action_required");
  const permission =
    interrupted.ready[0]?.status === "action_required"
      ? interrupted.ready[0].permission
      : undefined;
  assert.ok(permission);

  await facade.respondPermission(
    { permissionId: permission.permissionId, outcome: "allow_once" },
    actor,
  );
  const completed = await facade.waitAll(
    { turnIds: interrupted.pendingTurnIds, waitMs: 1_000 },
    actor,
  );
  const accumulated = new Map(
    [...interrupted.ready, ...completed.ready].map((item) => [item.turn.turnId, item]),
  );

  assert.deepEqual(completed.pendingTurnIds, []);
  assert.equal(completed.ready[0]?.status, "terminal_without_message");
  assert.equal(accumulated.get(receipt.turnId)?.status, "terminal_without_message");
});

test("MultiAgentFacade waitAll projects terminal after cancelling a pending permission", async () => {
  const runtime = new PermissionAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    {
      agentId: child.agentId,
      content: "permission then cancel",
      idempotencyKey: "wait-all-cancelled-permission",
    },
    actor,
  );
  const interrupted = await facade.waitAll({ turnIds: [receipt.turnId], waitMs: 1_000 }, actor);
  assert.equal(interrupted.ready[0]?.status, "action_required");

  await facade.cancel({ turnId: receipt.turnId, reason: "review-fix" }, actor);
  await waitForTerminalTurn(facade, actor, receipt.turnId);
  const completed = await facade.waitAll({ turnIds: [receipt.turnId] }, actor);

  assert.deepEqual(completed.pendingTurnIds, []);
  assert.equal(completed.ready[0]?.status, "terminal_without_message");
});

test("MultiAgentFacade waitAll can accumulate complete results after timeout", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const firstAgent = await facade.createAgent({ agent: "claude" }, actor);
  const secondAgent = await facade.createAgent({ agent: "pi" }, actor);
  const first = await facade.send(
    { agentId: firstAgent.agentId, content: "first", idempotencyKey: "wait-timeout-first" },
    actor,
  );
  const second = await facade.send(
    { agentId: secondAgent.agentId, content: "second", idempotencyKey: "wait-timeout-second" },
    actor,
  );
  await waitForCondition(() => runtime.started.length === 2);
  runtime.completions[0]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, first.turnId);

  const interrupted = await facade.waitAll(
    { turnIds: [first.turnId, second.turnId], waitMs: 0 },
    actor,
  );
  assert.equal(interrupted.timedOut, true);
  assert.deepEqual(interrupted.pendingTurnIds, [second.turnId]);
  assert.deepEqual(
    interrupted.ready.map((item) => item.turn.turnId),
    [first.turnId],
  );

  runtime.completions[1]?.({ status: "completed" });
  const completed = await facade.waitAll(
    { turnIds: interrupted.pendingTurnIds, waitMs: 1_000 },
    actor,
  );
  const accumulated = new Map(
    [...interrupted.ready, ...completed.ready].map((item) => [item.turn.turnId, item]),
  );

  assert.deepEqual([...accumulated.keys()], [first.turnId, second.turnId]);
  assert.deepEqual(completed.pendingTurnIds, []);
});

test("MultiAgentFacade wait many uses one store waiter for a batch", async () => {
  const runtime = new ControlledAgentRuntime();
  const baseStore = createInMemoryFacadeStore();
  let activeWaiters = 0;
  let peakWaiters = 0;
  let waitCalls = 0;
  const countingStore: FacadeStore = {
    read: async (reader) => await baseStore.read(reader),
    update: async (mutator) => await baseStore.update(mutator),
    waitForChange: async (afterRevision, waitMs, signal) => {
      waitCalls += 1;
      activeWaiters += 1;
      peakWaiters = Math.max(peakWaiters, activeWaiters);
      try {
        return await baseStore.waitForChange(afterRevision, waitMs, signal);
      } finally {
        activeWaiters -= 1;
      }
    },
  };
  const { facade } = createHarness(runtime, undefined, [TEST_WORKSPACE], countingStore);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const agents = await Promise.all(
    ["claude", "pi", "openclaw"].map(async (agent) => await facade.createAgent({ agent }, actor)),
  );
  const turns = await Promise.all(
    agents.map(
      async (agent, index) =>
        await facade.send(
          { agentId: agent.agentId, content: `${index}`, idempotencyKey: `single-waiter-${index}` },
          actor,
        ),
    ),
  );
  await waitForCondition(() => runtime.started.length === turns.length);

  const waiting = facade.waitAll(
    { turnIds: turns.map((turn) => turn.turnId), waitMs: 1_000 },
    actor,
  );
  await waitForCondition(() => activeWaiters === 1);
  assert.equal(waitCalls, 1);
  assert.equal(peakWaiters, 1);

  for (const complete of runtime.completions) {
    complete({ status: "completed" });
  }
  await waiting;
  assert.equal(peakWaiters, 1);
});

test("MultiAgentFacade returns permission control to an ancestor and resumes the runtime callback", async () => {
  const runtime = new PermissionAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, rootActor);
  const childActor: FacadeActor = {
    rootExecutionId: child.rootExecutionId,
    agentId: child.agentId,
  };
  const receipt = await facade.send(
    { agentId: child.agentId, content: "edit the file", idempotencyKey: "permission-1" },
    rootActor,
  );

  const waiting = await facade.waitMessage({ turnId: receipt.turnId, waitMs: 1_000 }, rootActor);
  assert.equal(waiting.status, "action_required");
  if (waiting.status !== "action_required") {
    return;
  }
  await assert.rejects(
    facade.respondPermission(
      { permissionId: waiting.permission.permissionId, outcome: "allow_once" },
      childActor,
    ),
    { code: "UNAUTHORIZED" },
  );
  const permission = await facade.respondPermission(
    { permissionId: waiting.permission.permissionId, outcome: "allow_once" },
    rootActor,
  );
  await assert.rejects(
    facade.respondPermission(
      { permissionId: waiting.permission.permissionId, outcome: "reject_once" },
      rootActor,
    ),
    { code: "PERMISSION_ALREADY_RESOLVED" },
  );
  const turn = await waitForTerminalTurn(facade, rootActor, receipt.turnId);

  assert.equal(permission.state, "resolved");
  assert.deepEqual(runtime.decision, { outcome: "allow_once" });
  assert.equal(turn.state, "completed");
});

test("MultiAgentFacade cancels a queued turn without starting it", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const first = await facade.send(
    { agentId: child.agentId, content: "first", idempotencyKey: "cancel-1" },
    actor,
  );
  const queued = await facade.send(
    { agentId: child.agentId, content: "never start", idempotencyKey: "cancel-2" },
    actor,
  );
  await nextTask();

  const cancelled = await facade.cancel({ turnId: queued.turnId }, actor);
  runtime.completions[0]?.({ status: "completed" });
  await waitForTerminalTurn(facade, actor, first.turnId);
  await nextTask();

  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(
    runtime.started.map((turn) => turn.text),
    ["first"],
  );
});

test("MultiAgentFacade propagates active turn cancellation to the ACP runtime", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "long task", idempotencyKey: "cancel-active" },
    actor,
  );
  await nextTask();
  assert.equal((await facade.getTurn({ turnId: receipt.turnId }, actor)).state, "running");

  await facade.cancel({ turnId: receipt.turnId, reason: "parent stopped" }, actor);
  const cancelled = await waitForTerminalTurn(facade, actor, receipt.turnId);

  assert.deepEqual(runtime.cancellations, [receipt.turnId]);
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await facade.status({ agentId: child.agentId }, actor)).agent.state, "idle");
});

test("MultiAgentFacade cascades parent turn cancellation to active descendant turns", async () => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, rootActor);
  const childActor: FacadeActor = {
    rootExecutionId: child.rootExecutionId,
    agentId: child.agentId,
  };
  const parent = await facade.send(
    { agentId: child.agentId, content: "delegate", idempotencyKey: "cascade-parent" },
    rootActor,
  );
  await nextTask();
  const grandchild = await facade.createAgent({ agent: "codex" }, childActor);
  const descendant = await facade.send(
    { agentId: grandchild.agentId, content: "subtask", idempotencyKey: "cascade-child" },
    childActor,
  );
  await nextTask();
  assert.equal(
    (await facade.getTurn({ turnId: descendant.turnId }, rootActor)).parentTurnId,
    parent.turnId,
  );

  await facade.cancel({ turnId: parent.turnId }, rootActor);
  const [parentTurn, descendantTurn] = await Promise.all([
    waitForTerminalTurn(facade, rootActor, parent.turnId),
    waitForTerminalTurn(facade, rootActor, descendant.turnId),
  ]);

  assert.equal(parentTurn.state, "cancelled");
  assert.equal(descendantTurn.state, "cancelled");
  assert.deepEqual(new Set(runtime.cancellations), new Set([parent.turnId, descendant.turnId]));
});

test("MultiAgentFacade requires cascade before destroying an agent with live descendants", async () => {
  const { facade, runtime } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, rootActor);
  const childActor: FacadeActor = {
    rootExecutionId: child.rootExecutionId,
    agentId: child.agentId,
  };
  const grandchild = await facade.createAgent({ agent: "codex" }, childActor);

  await assert.rejects(facade.destroyAgent({ agentId: child.agentId }, rootActor), {
    code: "AGENT_HAS_LIVE_DESCENDANTS",
  });
  const destroyed = await facade.destroyAgent({ agentId: child.agentId, cascade: true }, rootActor);

  assert.equal(destroyed.state, "destroyed");
  assert.deepEqual(new Set(runtime.destroyed), new Set([child.agentId, grandchild.agentId]));
});

test("MultiAgentFacade rejects managed agent self-destruction without changing state", async () => {
  const { facade, runtime } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, rootActor);
  const childActor: FacadeActor = {
    rootExecutionId: child.rootExecutionId,
    agentId: child.agentId,
  };

  await assert.rejects(facade.destroyAgent({ agentId: child.agentId }, childActor), {
    code: "UNAUTHORIZED",
  });

  assert.equal((await facade.status({ agentId: child.agentId }, rootActor)).agent.state, "idle");
  assert.deepEqual(runtime.destroyed, []);
});

test("MultiAgentFacade prepares a dormant persistent runtime before discarding it", async () => {
  const runtime = new FakeAgentRuntime();
  const { facade, store } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  await store.update((snapshot) => {
    const current = snapshot.agents[child.agentId];
    assert.ok(current);
    current.state = "dormant";
  });

  const destroyed = await facade.destroyAgent(
    { agentId: child.agentId, discardSession: true },
    actor,
  );

  assert.equal(destroyed.state, "destroyed");
  assert.equal(runtime.ensured.length, 2);
  assert.equal(runtime.ensured[1]?.input.requireExistingSession, true);
  assert.deepEqual(runtime.destroyed, [child.agentId]);
});

test("MCP server exposes all facade tools and returns structured create results", async (t) => {
  const { facade } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const server = createFacadeMcpServer({ facade, actor });
  const client = new Client({ name: "facade-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const instructions = client.getInstructions() ?? "";
  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const structured = created.structuredContent as { agent?: { agent: string; state: string } };

  assert.equal(tools.tools.length, 14);
  assert.match(instructions, /parallelizable/i);
  assert.match(instructions, /heterogeneous/i);
  assert.match(instructions, /do not delegate trivial or tightly coupled work/i);
  assert.match(
    instructions,
    /cs_agent_capabilities.*cs_agent_create.*send all independent turns.*cs_agent_wait_many.*cs_agent_destroy/is,
  );
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
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
    ],
  );
  const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  const descriptionSignals: Record<string, RegExp> = {
    cs_agent_capabilities: /call first when considering delegation or heterogeneous execution/i,
    cs_agent_create: /parallel work.*different agent runtime.*independent review/i,
    cs_agent_list: /before creating duplicates.*coordinating parallel work/i,
    cs_agent_status: /diagnose.*before deciding to wait.*cancel.*retry/i,
    cs_agent_events: /progress monitoring across agents or turns/i,
    cs_agent_send: /self-contained task.*deliverable.*verification/i,
    cs_agent_get_message: /already have its id.*wait_message instead/i,
    cs_agent_wait_message: /preferred blocking wait after cs_agent_send/i,
    cs_agent_wait_many: /send all independent turns first.*mode.*any.*all.*pendingTurnIds/i,
    cs_agent_get_turn: /detailed state.*error.*permission diagnostics/i,
    cs_agent_wait_turn: /state transitions matter more than reply content/i,
    cs_agent_respond_permission: /apply least privilege/i,
    cs_agent_cancel: /obsolete.*destructive control action/i,
    cs_agent_destroy: /work is complete or abandoned.*destructive/i,
  };
  for (const [toolName, signal] of Object.entries(descriptionSignals)) {
    assert.match(toolsByName.get(toolName)?.description ?? "", signal, toolName);
  }
  assert.equal(toolsByName.get("cs_agent_send")?.annotations?.idempotentHint, true);
  assert.equal(toolsByName.get("cs_agent_send")?.annotations?.destructiveHint, true);
  assert.equal(toolsByName.get("cs_agent_send")?.annotations?.openWorldHint, true);
  assert.equal(toolsByName.get("cs_agent_respond_permission")?.annotations?.openWorldHint, true);
  assert.equal(toolsByName.get("cs_agent_destroy")?.annotations?.destructiveHint, true);
  for (const tool of tools.tools) {
    const properties = (
      tool.inputSchema as { properties?: Record<string, { description?: string }> }
    ).properties;
    for (const [propertyName, property] of Object.entries(properties ?? {})) {
      assert.ok(
        property.description && property.description.trim().length > 0,
        `${tool.name}.${propertyName} must have an input description`,
      );
    }
  }
  assert.deepEqual(structured.agent, { ...structured.agent, agent: "claude", state: "idle" });
});

test("Facade exposes max-turn failures consistently through state, events, and MCP", async (t) => {
  const runtime = new MaxTurnsFailedAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const child = await facade.createAgent({ agent: "claude" }, actor);
  const receipt = await facade.send(
    { agentId: child.agentId, content: "review", idempotencyKey: "max-turn-contract" },
    actor,
  );
  const turn = await waitForTerminalTurn(facade, actor, receipt.turnId);
  const expectedError = {
    code: "MAX_TURNS_EXCEEDED",
    message: "The agent reached its configured sessionOptions.maxTurns",
    retryable: false,
    details: { runtimeCode: "RUNTIME" },
  };

  assert.equal(turn.state, "failed");
  assert.deepEqual(turn.error, expectedError);
  const status = await facade.status({ agentId: child.agentId }, actor);
  assert.deepEqual(status.agent.lastError, expectedError);
  const events = await facade.events({ afterCursor: "0", limit: 1_000 }, actor);
  const failedEvent = events.events.find(
    (event) => event.type === "turn.failed" && event.turnId === receipt.turnId,
  );
  assert.deepEqual((failedEvent?.data as { error?: unknown } | undefined)?.error, expectedError);

  const server = createFacadeMcpServer({ facade, actor });
  const client = new Client({ name: "max-turn-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const toolResult = await client.callTool({
    name: "cs_agent_get_turn",
    arguments: { turnId: receipt.turnId },
  });
  const toolContent = toolResult.structuredContent as {
    turn?: { error?: typeof expectedError };
  };
  assert.deepEqual(toolContent.turn?.error, expectedError);
});

test("MCP tools preserve facade errors, correlations, bounded waits, cursors, and lifecycle", async (t) => {
  const runtime = new ControlledAgentRuntime();
  const { facade } = createHarness(runtime);
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const actor: FacadeActor = { rootExecutionId: root.rootExecutionId, agentId: root.agentId };
  const server = createFacadeMcpServer({ facade, actor });
  const client = new Client({ name: "facade-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const invalid = await client.callTool({
    name: "cs_agent_send",
    arguments: { agentId: "not-a-uuid", content: "bad", idempotencyKey: "bad" },
  });
  assert.equal(invalid.isError, true);
  const invalidContent = invalid.content as Array<{ type?: string; text?: string }>;
  assert.match(
    invalidContent[0]?.type === "text" ? (invalidContent[0].text ?? "") : "",
    /Invalid arguments/,
  );
  const invalidWaitManyInputs = [
    { turnIds: [] },
    {
      turnIds: Array.from(
        { length: 65 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
    },
    { turnIds: ["not-a-uuid"] },
    { turnIds: ["00000000-0000-4000-8000-000000000105"], mode: "first" },
    { turnIds: ["00000000-0000-4000-8000-000000000105"], waitMs: 30_001 },
  ];
  for (const invalidArguments of invalidWaitManyInputs) {
    const invalidWaitMany = await client.callTool({
      name: "cs_agent_wait_many",
      arguments: invalidArguments,
    });
    assert.equal(invalidWaitMany.isError, true);
    const content = invalidWaitMany.content as Array<{ type?: string; text?: string }>;
    assert.match(content[0]?.type === "text" ? (content[0].text ?? "") : "", /Invalid arguments/);
  }
  const missing = await client.callTool({
    name: "cs_agent_status",
    arguments: { agentId: "00000000-0000-4000-8000-000000000001" },
  });
  const missingContent = missing.structuredContent as { error?: { code?: string } };
  assert.equal(missing.isError, true);
  assert.equal(missingContent.error?.code, "AGENT_NOT_FOUND");

  const capabilities = await client.callTool({
    name: "cs_agent_capabilities",
    arguments: {},
  });
  assert.equal(capabilities.isError, undefined);
  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "claude" },
  });
  const createdContent = created.structuredContent as { agent?: { agentId?: string } };
  assert.ok(createdContent.agent?.agentId);
  const agentId = createdContent.agent.agentId;

  const listed = await client.callTool({ name: "cs_agent_list", arguments: {} });
  const listedContent = listed.structuredContent as {
    result?: { agents?: Array<{ agentId: string }> };
  };
  assert.equal(
    listedContent.result?.agents?.some((agent) => agent.agentId === agentId),
    true,
  );
  const status = await client.callTool({ name: "cs_agent_status", arguments: { agentId } });
  const statusContent = status.structuredContent as { status?: { agent?: { state?: string } } };
  assert.equal(statusContent.status?.agent?.state, "idle");

  const sent = await client.callTool({
    name: "cs_agent_send",
    arguments: { agentId, content: "wait for cancel", idempotencyKey: "contract-send" },
  });
  const sentContent = sent.structuredContent as {
    receipt?: { messageId?: string; turnId?: string };
  };
  assert.ok(sentContent.receipt?.messageId);
  assert.ok(sentContent.receipt.turnId);
  const messageId = sentContent.receipt.messageId;
  const turnId = sentContent.receipt.turnId;
  await nextTask();

  const gotMessage = await client.callTool({
    name: "cs_agent_get_message",
    arguments: { messageId },
  });
  const gotMessageContent = gotMessage.structuredContent as {
    message?: { turnId?: string; content?: string };
  };
  assert.equal(gotMessageContent.message?.turnId, turnId);
  assert.equal(gotMessageContent.message.content, "wait for cancel");
  const gotTurn = await client.callTool({ name: "cs_agent_get_turn", arguments: { turnId } });
  const gotTurnContent = gotTurn.structuredContent as { turn?: { revision?: number } };
  assert.ok(gotTurnContent.turn?.revision);

  const turnWait = await client.callTool({
    name: "cs_agent_wait_turn",
    arguments: { turnId, afterRevision: gotTurnContent.turn.revision, waitMs: 5 },
  });
  const turnWaitContent = turnWait.structuredContent as { result?: { changed?: boolean } };
  assert.equal(turnWaitContent.result?.changed, false);
  const messageWait = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId, waitMs: 5 },
  });
  const messageWaitContent = messageWait.structuredContent as { result?: { status?: string } };
  assert.equal(messageWaitContent.result?.status, "timed_out");

  const events = await client.callTool({
    name: "cs_agent_events",
    arguments: { afterCursor: "0", limit: 1_000 },
  });
  const eventsContent = events.structuredContent as {
    page?: {
      events?: Array<{
        type?: string;
        data?: { toolName?: string; requestId?: string; outcome?: string };
      }>;
      nextCursor?: string;
    };
  };
  assert.equal((eventsContent.page?.events?.length ?? 0) > 0, true);
  const sendAudit = eventsContent.page?.events?.find(
    (event) => event.type === "audit.mutation" && event.data?.toolName === "cs_agent_send",
  );
  assert.equal(sendAudit?.data?.outcome, "accepted");
  assert.ok(sendAudit?.data?.requestId);
  assert.ok(eventsContent.page?.nextCursor);
  const emptyEvents = await client.callTool({
    name: "cs_agent_events",
    arguments: { afterCursor: eventsContent.page.nextCursor, waitMs: 5 },
  });
  const emptyEventsContent = emptyEvents.structuredContent as {
    page?: { events?: unknown[]; nextCursor?: string };
  };
  assert.deepEqual(emptyEventsContent.page?.events, []);
  assert.equal(emptyEventsContent.page?.nextCursor, eventsContent.page.nextCursor);

  const cancelled = await client.callTool({
    name: "cs_agent_cancel",
    arguments: { turnId, reason: "contract complete" },
  });
  const cancelledContent = cancelled.structuredContent as { turn?: { state?: string } };
  assert.equal(["running", "cancelled"].includes(cancelledContent.turn?.state ?? ""), true);
  const cancellationWait = await client.callTool({
    name: "cs_agent_wait_message",
    arguments: { turnId, waitMs: 1_000 },
  });
  const cancellationContent = cancellationWait.structuredContent as {
    result?: { status?: string; turn?: { state?: string } };
  };
  assert.equal(cancellationContent.result?.status, "terminal_without_message");
  assert.equal(cancellationContent.result.turn?.state, "cancelled");
  const destroyed = await client.callTool({
    name: "cs_agent_destroy",
    arguments: { agentId },
  });
  const destroyedContent = destroyed.structuredContent as { agent?: { state?: string } };
  assert.equal(destroyedContent.agent?.state, "destroyed");
});

test("loopback MCP authenticates a managed agent and supports recursive delegation", async (t) => {
  const { facade, identity, runtime } = createHarness();
  const root = await facade.bootstrapRoot({ agent: "codex", cwd: TEST_WORKSPACE });
  const rootActor: FacadeActor = {
    rootExecutionId: root.rootExecutionId,
    agentId: root.agentId,
  };
  const child = await facade.createAgent({ agent: "claude" }, rootActor);
  const sibling = await facade.createAgent({ agent: "pi" }, rootActor);
  const authorization = runtime.ensured[0]?.input.mcpServers[0];
  assert.ok(authorization && "type" in authorization && authorization.type === "http");
  const authorizationHeaderValue = authorization.headers[0]?.value;
  assert.ok(authorizationHeaderValue);
  const http = await startFacadeHttpServer({ facade, identity });
  t.after(async () => await http.close());

  const unauthorized = await fetch(http.url, { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);
  const wrongRootToken = await fetch(http.url, {
    method: "POST",
    headers: { Authorization: "Bearer unrelated-root-token" },
    body: "{}",
  });
  assert.equal(wrongRootToken.status, 401);

  const client = new Client({ name: "managed-agent", version: "1.0.0" });
  t.after(async () => await client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { Authorization: authorizationHeaderValue } },
    }),
  );
  const created = await client.callTool({
    name: "cs_agent_create",
    arguments: { agent: "codex" },
  });
  const structured = created.structuredContent as { agent?: { parentAgentId: string } };
  const selfSend = await client.callTool({
    name: "cs_agent_send",
    arguments: {
      agentId: child.agentId,
      content: "do not queue behind yourself",
      idempotencyKey: "self-send",
    },
  });
  const selfSendContent = selfSend.structuredContent as { error?: { code?: string } };
  const forbidden = await client.callTool({
    name: "cs_agent_status",
    arguments: { agentId: sibling.agentId },
  });
  const forbiddenContent = forbidden.structuredContent as { error?: { code?: string } };

  assert.equal(structured.agent?.parentAgentId, child.agentId);
  assert.equal(selfSend.isError, true);
  assert.equal(selfSendContent.error?.code, "UNAUTHORIZED");
  assert.equal(forbidden.isError, true);
  assert.equal(forbiddenContent.error?.code, "UNAUTHORIZED");
  assert.deepEqual(await identity.authenticate(authorizationHeaderValue.replace(/^Bearer /, "")), {
    rootExecutionId: child.rootExecutionId,
    agentId: child.agentId,
  });
});
