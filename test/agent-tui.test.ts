import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import terminalKit from "terminal-kit";
import type {
  AgentDiagnostics,
  AgentDiagnosticSummary,
  DiagnosticConversation,
  DiagnosticTimelineItem,
  DiagnosticWarning,
} from "../src/mcp/diagnostics/index.js";
import { runAgentsTop } from "../src/mcp/diagnostics/tui/index.js";
import { scrollAttach } from "../src/mcp/diagnostics/tui/model.js";
import { countAttachLines, renderTop } from "../src/mcp/diagnostics/tui/render.js";
import { sanitizeTerminalText } from "../src/mcp/diagnostics/tui/sanitize.js";
import type {
  AgentsTopState,
  AttachViewState,
  TerminalEvent,
  TopFrame,
  TopTerminal,
} from "../src/mcp/diagnostics/tui/types.js";

const TIMESTAMP = "2026-07-18T00:00:00.000Z";

test("sanitizeTerminalText removes terminal controls while preserving visible wide text", () => {
  const value =
    "safe\u001b[31mred\u001b[0m\u001b]52;c;clipboard\u0007" +
    "\u001bPpayload\u001b\\\nnext\t\u0000中文🙂\u202e";
  const sanitized = sanitizeTerminalText(value);

  assert.equal(sanitized, "safered next 中文🙂");
  assert.equal(
    Array.from(sanitized).some((character) => isControlCode(character)),
    false,
  );
  assert.equal(terminalKit.stringWidth(sanitized), 19);
});

test("scrollAttach keeps a full viewport when moving to the oldest conversation lines", () => {
  const items = conversationLines(30).items;
  const terminal = new FakeTerminal();
  const renderedLineCount = countAttachLines(items, 90, terminal);
  const attach: AttachViewState = {
    agent: diagnosticAgent("managed-1"),
    items,
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };

  const oldestPage = scrollAttach(attach, renderedLineCount, false, 10, renderedLineCount);

  assert.equal(oldestPage.scrollOffset, renderedLineCount - 10);
  const state = baseState([]);
  state.mode = "attach";
  state.attach = oldestPage;
  const text = frameText(renderTop(state, 90, 15, terminal));
  assert.match(text, /line-0/);
  assert.match(text, /line-2/);
});

test("runAgentsTop rejects redirected output without emitting terminal controls", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  const errorOutput = new PassThrough() as unknown as NodeJS.WriteStream;
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk) => {
    stdout += String(chunk);
  });
  errorOutput.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await runAgentsTop({
    diagnostics: new FakeDiagnostics(),
    input,
    output,
    errorOutput,
  });

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /requires an interactive TTY/);
  assert.equal(stderr.includes("\u001b"), false);
});

test("Agent Top handles root, mouse selection, attach follow, filter editing, and cleanup", async () => {
  const terminal = new FakeTerminal();
  terminal.height = 12;
  const diagnostics = new FakeDiagnostics();
  const root = diagnosticAgent("root-1", { kind: "root", name: "root" });
  const managed = diagnosticAgent("managed-1", { name: "worker" });
  diagnostics.enqueueList({ agents: [root, managed], warnings: [] });
  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 20 });
  await waitFor(() => frameText(terminal.lastFrame).includes("worker"));

  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => frameText(terminal.lastFrame).includes("MCP caller identities"));
  assert.equal(diagnostics.attachCalls, 0);

  diagnostics.conversation = conversationLines(8);
  const managedRow = findAgentRow(terminal.lastFrame, managed.agentId);
  terminal.emit({ type: "mouse", name: "MOUSE_LEFT_BUTTON_PRESSED", x: 2, y: managedRow });
  terminal.emit({ type: "mouse", name: "MOUSE_WHEEL_UP", x: 2, y: managedRow });
  terminal.emit({ type: "mouse", name: "MOUSE_WHEEL_DOWN", x: 2, y: managedRow });
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => diagnostics.attachCalls === 1);

  diagnostics.feed.push({
    schema: "cs-agent-mcp.diagnostics.v1",
    kind: "snapshot",
    agent: { ...managed, activeTurn: undefined },
  });
  await waitFor(() => frameText(terminal.lastFrame).includes("line-7"));
  terminal.emit({ type: "key", name: "UP" });
  diagnostics.conversation = conversationLines(9);
  await waitFor(() => frameText(terminal.lastFrame).includes("PAUSED | 1 new"));
  terminal.emit({ type: "key", name: "END" });
  await waitFor(() => frameText(terminal.lastFrame).includes("LIVE"));
  terminal.emit({ type: "key", name: "ESCAPE" });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));

  terminal.emit({ type: "key", name: "/" });
  terminal.emit({ type: "key", name: "q", text: "q" });
  await waitFor(() => frameText(terminal.lastFrame).includes("filter> q_"));
  terminal.emit({ type: "key", name: "ESCAPE" });
  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
  assert.equal(terminal.startCount, 1);
  assert.equal(terminal.stopCount, 1);
  assert.equal(diagnostics.feed.aborted, true);
});

test("Agent Top Attach renders the managed session conversation", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({
    agents: [diagnosticAgent("managed-1", { name: "worker" })],
    warnings: [],
  });
  diagnostics.conversation = {
    schema: "cs-agent-mcp.diagnostics.v1",
    updatedAt: TIMESTAMP,
    items: [
      { kind: "user", text: "Inspect the workspace and explain the failure." },
      { kind: "assistant", text: "I found the failing ownership check." },
    ],
  };

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("worker"));
  terminal.emit({ type: "key", name: "ENTER" });

  await waitFor(() => frameText(terminal.lastFrame).includes("Inspect the workspace"));
  assert.match(frameText(terminal.lastFrame), /\[USER\]\n\s+Inspect the workspace/);
  assert.match(frameText(terminal.lastFrame), /\[ASSISTANT\]\n\s+I found/);
  assert.match(frameText(terminal.lastFrame), /failing ownership check/);

  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top Attach renders thinking and tool call details", () => {
  const state = baseState([]);
  state.mode = "attach";
  state.attach = {
    agent: diagnosticAgent("managed-1"),
    items: [
      { kind: "thinking", text: "I should inspect the ownership record." },
      { kind: "tool_call", name: "Read", toolCallId: "tool-1", input: '{"path":"lock.json"}' },
      {
        kind: "tool_result",
        name: "Read",
        toolCallId: "tool-1",
        text: '{"owner":"root-1"}',
        isError: false,
      },
    ],
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };

  const text = frameText(renderTop(state, 100, 16, new FakeTerminal()));
  assert.match(text, /\[THINKING\]\n\s+I should inspect/);
  assert.match(text, /\[TOOL CALL\] Read\n\s+.*lock\.json/);
  assert.match(text, /\[TOOL RESULT\] Read\n\s+.*root-1/);
});

test("Agent Top Attach distinguishes unavailable historical conversations from loading", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({
    agents: [
      diagnosticAgent("managed-stopped", {
        instanceState: "stopped",
        lastError: {
          code: "SESSION_RESUME_REQUIRED",
          message: "Native session no longer exists",
          retryable: true,
        },
      }),
    ],
    warnings: [],
  });

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => frameText(terminal.lastFrame).includes("Conversation unavailable"));
  const text = frameText(terminal.lastFrame);

  assert.doesNotMatch(text, /Waiting for the first conversation/);
  assert.match(text, /SESSION_RESUME_REQUIRED/);
  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top Attach renders conversation read failures as unavailable", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-corrupt")], warnings: [] });
  diagnostics.conversationError = new Error("Invalid ACP session record");

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => frameText(terminal.lastFrame).includes("Invalid ACP session record"));
  const text = frameText(terminal.lastFrame);

  assert.match(text, /Conversation unavailable/);
  assert.doesNotMatch(text, /Loading conversation/);
  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top Attach transitions a running conversation from waiting to ready", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-delayed")], warnings: [] });

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 10 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() =>
    frameText(terminal.lastFrame).includes("Waiting for the first conversation message"),
  );

  diagnostics.conversation = {
    schema: "cs-agent-mcp.diagnostics.v1",
    updatedAt: TIMESTAMP,
    items: [{ kind: "assistant", text: "Delayed first reply" }],
  };
  await waitFor(() => frameText(terminal.lastFrame).includes("Delayed first reply"));
  assert.doesNotMatch(frameText(terminal.lastFrame), /Waiting for the first conversation/);

  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top Attach keeps tool content visible when the tool name is long", () => {
  const terminal = new FakeTerminal();
  const state = baseState([]);
  state.mode = "attach";
  state.attach = {
    agent: diagnosticAgent("managed-1"),
    items: [
      {
        kind: "tool_call",
        name: `tool-${"x".repeat(90)}`,
        toolCallId: "tool-1",
        input: "VISIBLE-INPUT",
      },
      {
        kind: "tool_result",
        name: `tool-${"y".repeat(90)}`,
        toolCallId: "tool-1",
        text: "VISIBLE-RESULT",
        isError: false,
      },
    ],
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };

  const frame = renderTop(state, 72, 16, terminal);
  const text = frameText(frame);
  assert.match(text, /VISIBLE-INPUT/);
  assert.match(text, /VISIBLE-RESULT/);
  assert.equal(
    frame.lines.every(
      (line) => terminal.measure(line.map((segment) => segment.text).join("")) <= 72,
    ),
    true,
  );
});

test("Agent Top Attach never renders redacted thinking payloads", () => {
  const state = baseState([]);
  state.mode = "attach";
  state.attach = {
    agent: diagnosticAgent("managed-1"),
    items: [{ kind: "thinking", redacted: true }],
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };

  const text = frameText(renderTop(state, 100, 16, new FakeTerminal()));
  assert.match(text, /\[redacted_thinking\]/);
  assert.doesNotMatch(text, /PRIVATE-REASONING-PAYLOAD/);
});

test("Agent Top Attach wraps complete multiline conversation content", () => {
  const state = baseState([]);
  state.mode = "attach";
  state.attach = {
    agent: diagnosticAgent("managed-1"),
    items: [
      {
        kind: "assistant",
        text: [
          "First paragraph explains the ownership conflict in enough detail to exceed one terminal row.",
          "Second paragraph preserves the final evidence: TAIL-MARKER.",
        ].join("\n"),
      },
    ],
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };

  const text = frameText(renderTop(state, 72, 16, new FakeTerminal()));
  assert.match(text, /First paragraph/);
  assert.match(text, /Second paragraph/);
  assert.match(text, /TAIL-MARKER/);
});

test("Agent Top Attach preserves a paused conversation while new lines arrive", async () => {
  const terminal = new FakeTerminal();
  terminal.height = 12;
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-1")], warnings: [] });
  diagnostics.conversation = conversationLines(12);

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 20 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => frameText(terminal.lastFrame).includes("line-11"));
  terminal.emit({ type: "key", name: "UP" });
  await waitFor(() => frameText(terminal.lastFrame).includes("PAUSED"));

  diagnostics.conversation = conversationLines(13);
  await waitFor(() => frameText(terminal.lastFrame).includes("PAUSED | 1 new"));
  assert.doesNotMatch(frameText(terminal.lastFrame), /line-12/);

  terminal.emit({ type: "key", name: "END" });
  await waitFor(() => frameText(terminal.lastFrame).includes("line-12"));
  assert.match(frameText(terminal.lastFrame), /LIVE/);
  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top Attach keeps facade events out of the conversation viewport", async () => {
  const terminal = new FakeTerminal();
  terminal.height = 12;
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-1")], warnings: [] });
  diagnostics.conversation = conversationLines(12);

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => frameText(terminal.lastFrame).includes("line-11"));
  terminal.emit({ type: "key", name: "UP" });
  diagnostics.feed.push(timelineEvent("99", "SHOULD-NOT-APPEAR"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.doesNotMatch(frameText(terminal.lastFrame), /SHOULD-NOT-APPEAR/);
  assert.match(frameText(terminal.lastFrame), /PAUSED \| 0 new/);
  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top Attach coalesces slow conversation refreshes", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-1")], warnings: [] });
  diagnostics.conversation = conversationLines(1);
  diagnostics.conversationDelayMs = 40;

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 10 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await new Promise((resolve) => setTimeout(resolve, 90));
  const text = frameText(terminal.lastFrame);
  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);

  assert.match(text, /line-0/);
  assert.equal(diagnostics.maxConcurrentConversationReads, 1);
});

test("Agent Top restores the terminal before a pending conversation read finishes", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  const readGate = new Deferred<void>();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-1")], warnings: [] });
  diagnostics.conversation = conversationLines(1);
  diagnostics.conversationGate = readGate;

  let completed = false;
  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 }).then((code) => {
    completed = true;
    return code;
  });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => diagnostics.concurrentConversationReads === 1);
  terminal.emit({ type: "key", name: "q" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const stopCountBeforeRead = terminal.stopCount;
  const completedBeforeRead = completed;
  readGate.resolve();
  assert.equal(stopCountBeforeRead, 1);
  assert.equal(completedBeforeRead, true);
  assert.equal(await running, 0);
});

test("Agent Top retains stale instance rows and discards outdated includeAll results", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  const stable = diagnosticAgent("stable", { instanceId: "instance-stable", name: "stable" });
  const flaky = diagnosticAgent("flaky", { instanceId: "instance-flaky", name: "flaky" });
  diagnostics.enqueueList({ agents: [stable, flaky], warnings: [] });
  diagnostics.enqueueList({
    agents: [stable],
    warnings: [warning("instance-flaky")],
  });
  const deferred = new Deferred<Awaited<ReturnType<AgentDiagnostics["listAgents"]>>>();
  diagnostics.enqueueList(deferred.promise);
  diagnostics.enqueueList({
    agents: [diagnosticAgent("all-result", { name: "all-result" })],
    warnings: [],
  });

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("flaky"));
  terminal.emit({ type: "key", name: "r" });
  await waitFor(() => frameText(terminal.lastFrame).includes("idle*"));
  terminal.emit({ type: "key", name: "r" });
  await waitFor(() => diagnostics.listCalls >= 3);
  terminal.emit({ type: "key", name: "a" });
  deferred.resolve({ agents: [diagnosticAgent("outdated", { name: "outdated" })], warnings: [] });
  await waitFor(() => frameText(terminal.lastFrame).includes("all-result"));
  assert.doesNotMatch(frameText(terminal.lastFrame), /outdated/);

  terminal.emit({ type: "key", name: "q" });
  assert.equal(await running, 0);
});

test("Agent Top quits directly from the Attach view", async () => {
  const terminal = new FakeTerminal();
  const diagnostics = new FakeDiagnostics();
  diagnostics.enqueueList({ agents: [diagnosticAgent("managed-1")], warnings: [] });

  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("managed 1"));
  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => diagnostics.attachCalls === 1);
  terminal.emit({ type: "key", name: "q" });

  assert.equal(await running, 0);
  assert.equal(diagnostics.feed.aborted, true);
  assert.equal(terminal.stopCount, 1);
});

test("renderer sanitizes DTO text and produces a non-overlapping small-terminal state", () => {
  const agent = diagnosticAgent("poison", {
    name: "bad\u001b]52;c;secret\u0007\nname",
    cwd: "/tmp/中文🙂",
  });
  const state = baseState([agent]);
  const regular = renderTop(state, 90, 20, new FakeTerminal());
  const text = frameText(regular);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("\nname"), false);
  assert.match(text, /bad name/);
  assert.match(text, /中文🙂/);

  const small = renderTop(state, 40, 5, new FakeTerminal());
  assert.match(frameText(small), /Terminal too small/);
  assert.equal(small.lines.length, 5);
});

test("Agent Top reports terminal initialization failures and still runs cleanup", async () => {
  const terminal = new FakeTerminal();
  terminal.startError = new Error("terminal init failed");
  const errorOutput = new PassThrough() as unknown as NodeJS.WriteStream;
  let stderr = "";
  errorOutput.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await runAgentsTop({
    diagnostics: new FakeDiagnostics(),
    terminal,
    errorOutput,
  });

  assert.equal(code, 1);
  assert.equal(terminal.stopCount, 1);
  assert.match(stderr, /terminal init failed/);
});

class FakeTerminal implements TopTerminal {
  width = 100;
  height = 24;
  startCount = 0;
  stopCount = 0;
  startError?: Error;
  lastFrame: TopFrame = { lines: [], rowAgentIds: new Map() };
  private handler?: (event: TerminalEvent) => void;

  start(): void {
    this.startCount += 1;
    if (this.startError) {
      throw this.startError;
    }
  }

  stop(): void {
    this.stopCount += 1;
  }

  setEventHandler(handler?: (event: TerminalEvent) => void): void {
    this.handler = handler;
  }

  draw(frame: TopFrame): void {
    this.lastFrame = frame;
  }

  emit(event: TerminalEvent): void {
    this.handler?.(event);
  }

  measure(text: string): number {
    return terminalKit.stringWidth(text);
  }

  truncate(text: string, width: number): string {
    return terminalKit.truncateString(text, width);
  }
}

class FakeDiagnostics implements AgentDiagnostics {
  readonly feed = new TimelineFeed();
  conversation?: DiagnosticConversation;
  conversationError?: Error;
  conversationDelayMs = 0;
  conversationGate?: Deferred<void>;
  concurrentConversationReads = 0;
  maxConcurrentConversationReads = 0;
  listCalls = 0;
  attachCalls = 0;
  private readonly listQueue: Array<
    | Awaited<ReturnType<AgentDiagnostics["listAgents"]>>
    | Promise<Awaited<ReturnType<AgentDiagnostics["listAgents"]>>>
  > = [];
  private lastList: Awaited<ReturnType<AgentDiagnostics["listAgents"]>> = {
    agents: [],
    warnings: [],
  };

  enqueueList(
    result:
      | Awaited<ReturnType<AgentDiagnostics["listAgents"]>>
      | Promise<Awaited<ReturnType<AgentDiagnostics["listAgents"]>>>,
  ): void {
    this.listQueue.push(result);
  }

  async listAgents(): Promise<Awaited<ReturnType<AgentDiagnostics["listAgents"]>>> {
    this.listCalls += 1;
    const next = this.listQueue.shift();
    if (next) {
      this.lastList = await next;
    }
    return this.lastList;
  }

  async resolveAgent(): Promise<never> {
    throw new Error("not used");
  }

  async readConversation(): Promise<DiagnosticConversation | undefined> {
    this.concurrentConversationReads += 1;
    this.maxConcurrentConversationReads = Math.max(
      this.maxConcurrentConversationReads,
      this.concurrentConversationReads,
    );
    try {
      if (this.conversationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.conversationDelayMs));
      }
      await this.conversationGate?.promise;
      if (this.conversationError) {
        throw this.conversationError;
      }
      return this.conversation;
    } finally {
      this.concurrentConversationReads -= 1;
    }
  }

  attachAgent(
    _selector: string,
    options?: { history?: number; signal?: AbortSignal },
  ): AsyncGenerator<DiagnosticTimelineItem, number> {
    this.attachCalls += 1;
    return this.feed.stream(options?.signal);
  }
}

class TimelineFeed {
  aborted = false;
  private readonly values: DiagnosticTimelineItem[] = [];
  private notify?: () => void;

  push(item: DiagnosticTimelineItem): void {
    this.values.push(item);
    this.notify?.();
    this.notify = undefined;
  }

  async *stream(signal?: AbortSignal): AsyncGenerator<DiagnosticTimelineItem, number> {
    while (true) {
      if (signal?.aborted) {
        break;
      }
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.notify = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    this.aborted = true;
    return 0;
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise?: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T): void {
    this.resolvePromise?.(value);
  }
}

function diagnosticAgent(
  agentId: string,
  options: {
    kind?: "root" | "managed";
    name?: string;
    cwd?: string;
    instanceId?: string;
    instanceState?: "running" | "stopped" | "unknown";
    lastError?: AgentDiagnosticSummary["lastError"];
  } = {},
): AgentDiagnosticSummary {
  return {
    instance: {
      instanceId: options.instanceId ?? "instance-1",
      state: options.instanceState ?? "running",
      pid: process.pid,
      rootCwd: "/workspace",
      snapshotPath: `/tmp/${options.instanceId ?? "instance-1"}.json`,
    },
    agentId,
    kind: options.kind ?? "managed",
    agent: "claude",
    name: options.name ?? agentId,
    cwd: options.cwd ?? "/workspace",
    mode: "persistent",
    depth: options.kind === "root" ? 0 : 1,
    state: "idle",
    queueDepth: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    lastError: options.lastError,
  };
}

function timelineEvent(cursor: string, summary: string): DiagnosticTimelineItem {
  return {
    schema: "cs-agent-mcp.diagnostics.v1",
    kind: "event",
    event: {
      cursor,
      type: "turn.text_delta",
      timestamp: TIMESTAMP,
      agentId: "managed-1",
      turnId: "turn-1",
      summary,
      truncated: false,
      detail: { stream: "output", text: summary },
    },
  };
}

function conversationLines(count: number): DiagnosticConversation {
  return {
    schema: "cs-agent-mcp.diagnostics.v1",
    updatedAt: TIMESTAMP,
    items: Array.from({ length: count }, (_, index) => ({
      kind: "assistant" as const,
      text: `line-${index}`,
    })),
  };
}

function warning(instanceId: string): DiagnosticWarning {
  return {
    instanceId,
    snapshotPath: `/tmp/${instanceId}.json`,
    message: "snapshot unreadable",
  };
}

function baseState(agents: AgentDiagnosticSummary[]): AgentsTopState {
  return {
    mode: "list",
    agents,
    staleAgentIds: new Set(),
    warnings: [],
    includeAll: false,
    filter: "",
    filterDraft: "",
    filterEditing: false,
    selectedAgentId: agents[0]?.agentId,
    loading: false,
  };
}

function frameText(frame: TopFrame): string {
  return frame.lines.map((line) => line.map((part) => part.text).join("")).join("\n");
}

function isControlCode(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function findAgentRow(frame: TopFrame, agentId: string): number {
  for (const [row, candidate] of frame.rowAgentIds) {
    if (candidate === agentId) {
      return row;
    }
  }
  throw new Error(`Agent row not found: ${agentId}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
