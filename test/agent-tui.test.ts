import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import terminalKit from "terminal-kit";
import type {
  AgentDiagnostics,
  AgentDiagnosticSummary,
  DiagnosticTimelineItem,
  DiagnosticWarning,
} from "../src/mcp/diagnostics/index.js";
import { runAgentsTop } from "../src/mcp/diagnostics/tui/index.js";
import {
  appendTimelineItem,
  MAX_TIMELINE_ITEMS,
  scrollAttach,
} from "../src/mcp/diagnostics/tui/model.js";
import { renderTop } from "../src/mcp/diagnostics/tui/render.js";
import { sanitizeTerminalText } from "../src/mcp/diagnostics/tui/sanitize.js";
import type {
  AgentsTopState,
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

test("appendTimelineItem keeps a bounded timeline and preserves a paused viewport", () => {
  let attach = {
    agent: diagnosticAgent("managed-1"),
    items: [] as DiagnosticTimelineItem[],
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };
  for (let index = 0; index < MAX_TIMELINE_ITEMS; index += 1) {
    attach = appendTimelineItem(attach, timelineEvent(String(index), `event-${index}`));
  }
  attach.scrollOffset = 5;
  attach = appendTimelineItem(attach, timelineEvent("next", "latest"));

  assert.equal(attach.items.length, MAX_TIMELINE_ITEMS);
  assert.equal(attach.trimmedCount, 1);
  assert.equal(attach.unreadCount, 1);
  assert.equal(attach.scrollOffset, 5);
  assert.equal(attach.items.at(-1)?.kind, "event");
});

test("scrollAttach keeps a full viewport when moving to the oldest events", () => {
  const items = Array.from({ length: 30 }, (_, index) =>
    timelineEvent(String(index), `event-${index}`),
  );
  const attach = {
    agent: diagnosticAgent("managed-1"),
    items,
    scrollOffset: 0,
    unreadCount: 0,
    trimmedCount: 0,
  };

  const oldestPage = scrollAttach(attach, items.length, false, 10);

  assert.equal(oldestPage.scrollOffset, 20);
  const state = baseState([]);
  state.mode = "attach";
  state.attach = { ...oldestPage, scrollOffset: items.length - 1 };
  const text = frameText(renderTop(state, 90, 15, new FakeTerminal()));
  assert.match(text, /event-0/);
  assert.match(text, /event-9/);
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
  const running = runAgentsTop({ diagnostics, terminal, refreshMs: 60_000 });
  await waitFor(() => frameText(terminal.lastFrame).includes("worker"));

  terminal.emit({ type: "key", name: "ENTER" });
  await waitFor(() => frameText(terminal.lastFrame).includes("MCP caller identities"));
  assert.equal(diagnostics.attachCalls, 0);

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
  for (let index = 1; index <= 8; index += 1) {
    diagnostics.feed.push(timelineEvent(String(index), `output-${index}`));
  }
  await waitFor(() => frameText(terminal.lastFrame).includes("output-8"));
  terminal.emit({ type: "key", name: "UP" });
  diagnostics.feed.push(timelineEvent("9", "new output"));
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
  } = {},
): AgentDiagnosticSummary {
  return {
    instance: {
      instanceId: options.instanceId ?? "instance-1",
      state: "running",
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
