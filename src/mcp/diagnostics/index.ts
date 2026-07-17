import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Agent,
  FacadeErrorShape,
  FacadeEvent,
  FacadeSnapshot,
  Permission,
  Turn,
} from "../facade/types.js";
import { probeFacadeProcessLock, type FacadeProcessLockProbe } from "../transport/process-lock.js";

type DiagnosticErrorShape = {
  code: string;
  message: string;
  retryable: boolean;
  runtimeCode?: string;
};

export type ObservedFacadeInstance = {
  instanceId: string;
  state: "running" | "stopped" | "unknown";
  pid?: number;
  rootCwd?: string;
  snapshotPath: string;
};

export type AgentDiagnosticSummary = {
  instance: ObservedFacadeInstance;
  agentId: string;
  kind: "root" | "managed";
  parentAgentId?: string;
  agent: string;
  name?: string;
  cwd: string;
  mode: "persistent" | "oneshot";
  depth: number;
  state: Agent["state"];
  activeTurnId?: string;
  queueDepth: number;
  createdAt: string;
  updatedAt: string;
  maxTurns?: number;
  lastError?: DiagnosticErrorShape;
};

export type DiagnosticTurn = {
  turnId: string;
  state: Turn["state"];
  revision: number;
  pendingPermissionId?: string;
  stopReason?: string;
  error?: DiagnosticErrorShape;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgentDiagnosticDetail = AgentDiagnosticSummary & {
  activeTurn?: DiagnosticTurn;
  pendingPermission?: {
    permissionId: string;
    state: Permission["state"];
    inferredKind?: string;
    requestedAt: string;
    expiresAt: string;
  };
};

export type DiagnosticEvent = {
  cursor: string;
  type: FacadeEvent["type"];
  timestamp: string;
  agentId: string;
  turnId?: string;
  summary: string;
  truncated: boolean;
  detail: Record<string, unknown>;
};

export type DiagnosticTimelineItem =
  | {
      schema: "cs-agent-mcp.diagnostics.v1";
      kind: "snapshot";
      agent: AgentDiagnosticDetail;
    }
  | {
      schema: "cs-agent-mcp.diagnostics.v1";
      kind: "event";
      event: DiagnosticEvent;
    }
  | {
      schema: "cs-agent-mcp.diagnostics.v1";
      kind: "terminal";
      reason:
        | "agent_destroyed"
        | "instance_stopped"
        | "instance_unknown"
        | "instance_replaced"
        | "interrupted";
    };

export type DiagnosticWarning = {
  instanceId?: string;
  snapshotPath: string;
  message: string;
};

export type AgentSelectorResult =
  | {
      ok: true;
      agent: AgentDiagnosticDetail;
      warnings: DiagnosticWarning[];
    }
  | {
      ok: false;
      code: "AGENT_NOT_FOUND" | "AGENT_SELECTOR_AMBIGUOUS" | "AGENT_SELECTOR_UNSAFE";
      message: string;
      candidates: AgentDiagnosticSummary[];
      warnings: DiagnosticWarning[];
    };

export type AgentDiagnostics = {
  listAgents(options?: { includeAll?: boolean }): Promise<{
    agents: AgentDiagnosticSummary[];
    warnings: DiagnosticWarning[];
  }>;
  resolveAgent(selector: string): Promise<AgentSelectorResult>;
  attachAgent(
    selector: string,
    options?: { history?: number; signal?: AbortSignal },
  ): AsyncGenerator<DiagnosticTimelineItem, number>;
};

type AgentDiagnosticsOptions = {
  facadesDir?: string;
  probeLock?: (lockPath: string) => Promise<FacadeProcessLockProbe>;
};

type ReadableInstance = {
  instance: ObservedFacadeInstance;
  snapshot: FacadeSnapshot;
  generation?: string;
};

type AgentTarget = {
  readable: ReadableInstance;
  agent: Agent;
  detail: AgentDiagnosticDetail;
};

type AgentTargetResult = { found: true; target: AgentTarget } | { found: false; message: string };

type AttachState = {
  target: AgentTarget;
  cursor: number;
  initialInstanceId: string;
  initialGeneration?: string;
};

type PreparedAttach = {
  items: DiagnosticTimelineItem[];
  state: AttachState;
  terminal?: {
    reason: Extract<DiagnosticTimelineItem, { kind: "terminal" }>["reason"];
    exitCode: number;
  };
};

const SNAPSHOT_FILE_PATTERN = /^[0-9a-f]{24}\.json$/;
const FULL_AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentDiagnostics(options: AgentDiagnosticsOptions = {}): AgentDiagnostics {
  const facadesDir =
    options.facadesDir ?? path.join(os.homedir(), ".cs-agent-mcp", "mcp", "facades");
  const probeLock = options.probeLock ?? probeFacadeProcessLock;

  async function readInstances(): Promise<{
    instances: ReadableInstance[];
    warnings: DiagnosticWarning[];
  }> {
    let entries: string[];
    try {
      entries = await fs.readdir(facadesDir);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { instances: [], warnings: [] };
      }
      throw error;
    }

    const instances: ReadableInstance[] = [];
    const warnings: DiagnosticWarning[] = [];
    for (const entry of entries.filter((name) => SNAPSHOT_FILE_PATTERN.test(name)).toSorted()) {
      const result = await readFacadeEntry(entry);
      if (result.ok) {
        instances.push(result.instance);
      } else {
        warnings.push(result.warning);
      }
    }
    return { instances, warnings };
  }

  async function readFacadeEntry(
    entry: string,
  ): Promise<{ ok: true; instance: ReadableInstance } | { ok: false; warning: DiagnosticWarning }> {
    const instanceId = entry.slice(0, -".json".length);
    const snapshotPath = path.join(facadesDir, entry);
    let snapshot: FacadeSnapshot;
    try {
      snapshot = parseDiagnosticSnapshot(await readJson(snapshotPath));
    } catch (error) {
      return {
        ok: false,
        warning: {
          instanceId,
          snapshotPath,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const lockProbe = await probeLock(`${snapshotPath}.lock`);
    return {
      ok: true,
      instance: {
        instance: {
          instanceId,
          state: lockProbe.state,
          ...(lockProbe.state === "running" ? { pid: lockProbe.pid } : {}),
          ...(rootCwd(snapshot) ? { rootCwd: rootCwd(snapshot) } : {}),
          snapshotPath,
        },
        snapshot,
        ...(lockProbe.state === "running" ? { generation: lockProbe.token } : {}),
      },
    };
  }

  function listFromInstances(
    instances: ReadableInstance[],
    includeAll: boolean,
  ): AgentDiagnosticSummary[] {
    const agents: AgentDiagnosticSummary[] = [];
    for (const readable of instances) {
      for (const agent of Object.values(readable.snapshot.agents)) {
        if (!includeAll && (readable.instance.state !== "running" || agent.state === "destroyed")) {
          continue;
        }
        agents.push(toAgentSummary(readable.instance, agent));
      }
    }
    return agents;
  }

  async function readTarget(selector: string): Promise<AgentTargetResult> {
    const { instances, warnings } = await readInstances();
    const resolved = resolveFromInstances(selector, instances, warnings);
    if (!resolved.ok) {
      return { found: false, message: resolved.message };
    }
    const readable = instances.find(
      (candidate) => candidate.instance.instanceId === resolved.agent.instance.instanceId,
    );
    const agent = readable?.snapshot.agents[resolved.agent.agentId];
    if (!readable || !agent) {
      return { found: false, message: `No agent matches selector ${selector}` };
    }
    return {
      found: true,
      target: {
        readable,
        agent,
        detail: toAgentDetail(readable.instance, readable.snapshot, agent),
      },
    };
  }

  function resolveFromInstances(
    selector: string,
    instances: ReadableInstance[],
    warnings: DiagnosticWarning[],
  ): AgentSelectorResult {
    const allAgents = listFromInstances(instances, true);
    if (!FULL_AGENT_ID_PATTERN.test(selector) && warnings.length > 0) {
      return {
        ok: false,
        code: "AGENT_SELECTOR_UNSAFE",
        message:
          "Unreadable facade snapshots are present; use a complete agent id to avoid ambiguous prefix selection.",
        candidates: [],
        warnings,
      };
    }

    const matches = allAgents.filter((agent) =>
      FULL_AGENT_ID_PATTERN.test(selector)
        ? agent.agentId === selector
        : agent.agentId.startsWith(selector),
    );
    if (matches.length === 1) {
      const match = matches[0];
      const readable = instances.find(
        (candidate) => candidate.instance.instanceId === match.instance.instanceId,
      );
      const agent = readable?.snapshot.agents[match.agentId];
      if (readable && agent) {
        return {
          ok: true,
          agent: toAgentDetail(readable.instance, readable.snapshot, agent),
          warnings,
        };
      }
    }
    return selectorFailure(selector, matches, warnings);
  }

  async function prepareAttach(selector: string, history: number): Promise<PreparedAttach> {
    const initial = await readTarget(selector);
    if (!initial.found) {
      throw new Error(initial.message);
    }
    const target = initial.target;
    const items = [
      timelineSnapshot(target.detail),
      ...historyEvents(target.readable.snapshot, target.agent.agentId, history).map(
        toTimelineEvent,
      ),
    ];
    return {
      items,
      state: {
        target,
        cursor: maxCursor(target.readable.snapshot.events),
        initialInstanceId: target.readable.instance.instanceId,
        ...(target.readable.generation ? { initialGeneration: target.readable.generation } : {}),
      },
      terminal: terminalFor(target),
    };
  }

  async function drainNextEvents(state: AttachState): Promise<{
    state: AttachState;
    events: FacadeEvent[];
    replaced: boolean;
    terminal?: {
      reason: Extract<DiagnosticTimelineItem, { kind: "terminal" }>["reason"];
      exitCode: number;
    };
  }> {
    const next = await readTarget(state.target.agent.agentId);
    if (!next.found) {
      return {
        state,
        events: [],
        replaced: false,
        terminal: { reason: "instance_unknown", exitCode: 1 },
      };
    }
    const drained = await finalDrainIfReplacing({ ...state, target: next.target });
    const events = eventsAfter(
      drained.target.readable.snapshot,
      drained.target.agent.agentId,
      state.cursor,
    );
    return {
      state: {
        ...drained,
        cursor: events.at(-1) ? Number.parseInt(events.at(-1)?.cursor ?? "0", 10) : state.cursor,
      },
      events,
      replaced: isReplacement(drained),
      terminal: isReplacement(drained)
        ? { reason: "instance_replaced", exitCode: 1 }
        : terminalFor(drained.target),
    };
  }

  async function finalDrainIfReplacing(state: AttachState): Promise<AttachState> {
    if (!isReplacement(state)) {
      return state;
    }
    let events = eventsAfter(
      state.target.readable.snapshot,
      state.target.agent.agentId,
      state.cursor,
    );
    if (events.length > 0) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    const finalDrain = await readTarget(state.target.agent.agentId);
    if (!finalDrain.found) {
      return state;
    }
    events = eventsAfter(
      finalDrain.target.readable.snapshot,
      finalDrain.target.agent.agentId,
      state.cursor,
    );
    return events.length > 0 ? { ...state, target: finalDrain.target } : state;
  }

  function isReplacement(state: AttachState): boolean {
    return (
      state.target.readable.instance.instanceId !== state.initialInstanceId ||
      (state.initialGeneration !== undefined &&
        state.target.readable.generation !== undefined &&
        state.target.readable.generation !== state.initialGeneration)
    );
  }

  async function* followPreparedAttach(
    prepared: PreparedAttach,
    signal?: AbortSignal,
  ): AsyncGenerator<DiagnosticTimelineItem, number> {
    for (const item of prepared.items) {
      yield item;
    }
    if (prepared.terminal) {
      yield terminalItem(prepared.terminal.reason);
      return prepared.terminal.exitCode;
    }
    let state = prepared.state;
    while (true) {
      await waitForFacadeChange(facadesDir, signal);
      if (signal?.aborted) {
        yield terminalItem("interrupted");
        return 0;
      }
      const next = await drainNextEvents(state);
      state = next.state;
      for (const event of next.events) {
        yield toTimelineEvent(event);
      }
      if (next.terminal) {
        yield terminalItem(next.terminal.reason);
        return next.terminal.exitCode;
      }
    }
  }

  return {
    async listAgents(options = {}) {
      const { instances, warnings } = await readInstances();
      return { agents: listFromInstances(instances, Boolean(options.includeAll)), warnings };
    },

    async resolveAgent(selector: string) {
      const { instances, warnings } = await readInstances();
      return resolveFromInstances(selector, instances, warnings);
    },

    async *attachAgent(selector: string, options = {}) {
      const history = clampHistory(options.history);
      const prepared = await prepareAttach(selector, history);
      return yield* followPreparedAttach(prepared, options.signal);
    },
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function rootCwd(snapshot: FacadeSnapshot): string | undefined {
  return Object.values(snapshot.agents).find((agent) => agent.kind === "root")?.cwd;
}

function selectorFailure(
  selector: string,
  matches: AgentDiagnosticSummary[],
  warnings: DiagnosticWarning[],
): AgentSelectorResult {
  if (matches.length === 0) {
    return {
      ok: false,
      code: "AGENT_NOT_FOUND",
      message: `No agent matches selector ${selector}`,
      candidates: [],
      warnings,
    };
  }
  return {
    ok: false,
    code: "AGENT_SELECTOR_AMBIGUOUS",
    message: `Agent selector ${selector} matched multiple agents`,
    candidates: matches,
    warnings,
  };
}

function clampHistory(history: number | undefined): number {
  if (history === undefined || !Number.isFinite(history)) {
    return 20;
  }
  return Math.min(Math.max(Math.trunc(history), 0), 1_000);
}

function historyEvents(snapshot: FacadeSnapshot, agentId: string, history: number): FacadeEvent[] {
  if (history === 0) {
    return [];
  }
  return snapshot.events
    .filter((event) => event.agentId === agentId)
    .toSorted(compareEventCursor)
    .slice(-history);
}

function eventsAfter(snapshot: FacadeSnapshot, agentId: string, cursor: number): FacadeEvent[] {
  return snapshot.events
    .filter((event) => event.agentId === agentId && Number.parseInt(event.cursor, 10) > cursor)
    .toSorted(compareEventCursor);
}

function maxCursor(events: FacadeEvent[]): number {
  return events.reduce((max, event) => Math.max(max, Number.parseInt(event.cursor, 10) || 0), 0);
}

function compareEventCursor(left: FacadeEvent, right: FacadeEvent): number {
  return Number.parseInt(left.cursor, 10) - Number.parseInt(right.cursor, 10);
}

function terminalFor(
  target: AgentTarget,
):
  | { reason: Extract<DiagnosticTimelineItem, { kind: "terminal" }>["reason"]; exitCode: number }
  | undefined {
  if (target.agent.state === "destroyed") {
    return { reason: "agent_destroyed", exitCode: 0 };
  }
  if (target.readable.instance.state === "stopped") {
    return { reason: "instance_stopped", exitCode: 1 };
  }
  if (target.readable.instance.state === "unknown") {
    return { reason: "instance_unknown", exitCode: 1 };
  }
  return undefined;
}

function timelineSnapshot(agent: AgentDiagnosticDetail): DiagnosticTimelineItem {
  return { schema: "cs-agent-mcp.diagnostics.v1", kind: "snapshot", agent };
}

function terminalItem(
  reason: Extract<DiagnosticTimelineItem, { kind: "terminal" }>["reason"],
): DiagnosticTimelineItem {
  return { schema: "cs-agent-mcp.diagnostics.v1", kind: "terminal", reason };
}

function toTimelineEvent(event: FacadeEvent): DiagnosticTimelineItem {
  const projected = projectEvent(event);
  return { schema: "cs-agent-mcp.diagnostics.v1", kind: "event", event: projected };
}

function projectEvent(event: FacadeEvent): DiagnosticEvent {
  const detail = projectEventDetail(event);
  const summary = typeof detail.summary === "string" ? detail.summary : event.type;
  const { summary: _summary, ...safeDetail } = detail;
  return {
    cursor: event.cursor,
    type: event.type,
    timestamp: event.timestamp,
    agentId: event.agentId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    summary: truncateText(summary).text,
    truncated: truncateText(summary).truncated,
    detail: safeDetail,
  };
}

function projectEventDetail(event: FacadeEvent): Record<string, unknown> & { summary?: string } {
  const data = asRecord(event.data);
  if (event.type === "turn.text_delta") {
    return projectTextDelta(data);
  }
  if (event.type === "turn.status") {
    return pickScalars(data, ["text", "tag", "used", "size"], event.type);
  }
  if (event.type === "turn.tool_call") {
    return pickScalars(data, ["toolCallId", "status", "title", "kind", "locations"], event.type);
  }
  if (
    event.type === "turn.failed" ||
    event.type === "turn.completed" ||
    event.type === "turn.cancelled"
  ) {
    return pickScalars(
      data,
      ["stopReason", "code", "message", "retryable", "runtimeCode"],
      event.type,
    );
  }
  return pickScalars(
    data,
    ["state", "permissionId", "inferredKind", "outcome", "messageId"],
    event.type,
  );
}

function projectTextDelta(
  data: Record<string, unknown>,
): Record<string, unknown> & { summary?: string } {
  const stream = typeof data.stream === "string" ? data.stream : undefined;
  const tag = typeof data.tag === "string" ? data.tag : undefined;
  if (stream === "output" && typeof data.text === "string") {
    const truncated = truncateText(data.text);
    return {
      summary: truncated.text,
      text: truncated.text,
      stream,
      ...(tag ? { tag } : {}),
      truncated: truncated.truncated,
    };
  }
  return {
    summary: "text omitted",
    ...(stream ? { stream } : {}),
    ...(tag ? { tag } : {}),
    omitted: true,
  };
}

function pickScalars(
  data: Record<string, unknown>,
  keys: string[],
  fallbackSummary: string,
): Record<string, unknown> & { summary?: string } {
  const detail: Record<string, unknown> & { summary?: string } = { summary: fallbackSummary };
  for (const key of keys) {
    const value = data[key];
    if (isScalar(value) || isScalarArray(value)) {
      detail[key] = value;
      if (key === "text" || key === "title" || key === "state" || key === "message") {
        detail.summary = String(value);
      }
    }
  }
  return detail;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isScalarArray(value: unknown): value is Array<string | number | boolean> {
  return Array.isArray(value) && value.every(isScalar);
}

function truncateText(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= 2_000) {
    return { text, truncated: false };
  }
  return { text: chars.slice(0, 2_000).join(""), truncated: true };
}

async function waitForFacadeChange(facadesDir: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const timeout = setTimeout(() => done(), 1_000);
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      watcher?.close();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    try {
      watcher = watch(facadesDir, { persistent: false }, done);
      watcher.on("error", done);
    } catch {
      // The 1s fallback remains active when fs.watch is unavailable.
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function parseDiagnosticSnapshot(value: unknown): FacadeSnapshot {
  const record = requireRecord(value, "snapshot");
  if (record.schema !== "cs-agent-mcp.facade.v1") {
    throw new Error("Invalid cs-agent-mcp facade snapshot schema");
  }
  const revision = requireNumber(record.revision, "snapshot.revision");
  const nextCursor = requireNumber(record.nextCursor, "snapshot.nextCursor");
  const agents = requireRecord(record.agents, "snapshot.agents");
  const turns = requireRecord(record.turns, "snapshot.turns");
  const messages = requireRecord(record.messages, "snapshot.messages");
  const permissions = requireRecord(record.permissions, "snapshot.permissions");
  requireArray(record.events, "snapshot.events");
  requireRecord(record.idempotency, "snapshot.idempotency");
  requireRecord(record.identities, "snapshot.identities");

  for (const [agentId, agent] of Object.entries(agents)) {
    parseAgent(agentId, agent);
  }
  for (const [turnId, turn] of Object.entries(turns)) {
    parseTurn(turnId, turn);
  }
  for (const [permissionId, permission] of Object.entries(permissions)) {
    parsePermission(permissionId, permission);
  }
  return {
    schema: "cs-agent-mcp.facade.v1",
    revision,
    nextCursor,
    agents: agents as FacadeSnapshot["agents"],
    turns: turns as FacadeSnapshot["turns"],
    messages: messages as FacadeSnapshot["messages"],
    permissions: permissions as FacadeSnapshot["permissions"],
    events: record.events as FacadeSnapshot["events"],
    idempotency: record.idempotency as FacadeSnapshot["idempotency"],
    identities: record.identities as FacadeSnapshot["identities"],
  };
}

function parseAgent(agentId: string, value: unknown): void {
  const record = requireRecord(value, `snapshot.agents.${agentId}`);
  requireString(record.agentId, `snapshot.agents.${agentId}.agentId`);
  requireString(record.rootExecutionId, `snapshot.agents.${agentId}.rootExecutionId`);
  requireOneOf(record.kind, ["root", "managed"], `snapshot.agents.${agentId}.kind`);
  requireString(record.agent, `snapshot.agents.${agentId}.agent`);
  requireString(record.cwd, `snapshot.agents.${agentId}.cwd`);
  requireOneOf(record.mode, ["persistent", "oneshot"], `snapshot.agents.${agentId}.mode`);
  requireNumber(record.depth, `snapshot.agents.${agentId}.depth`);
  requireOneOf(
    record.state,
    [
      "creating",
      "idle",
      "running",
      "waiting_permission",
      "dormant",
      "failed",
      "destroying",
      "destroyed",
    ],
    `snapshot.agents.${agentId}.state`,
  );
  requireNumber(record.queueDepth, `snapshot.agents.${agentId}.queueDepth`);
  requireString(record.createdAt, `snapshot.agents.${agentId}.createdAt`);
  requireString(record.updatedAt, `snapshot.agents.${agentId}.updatedAt`);
}

function parseTurn(turnId: string, value: unknown): void {
  const record = requireRecord(value, `snapshot.turns.${turnId}`);
  requireString(record.turnId, `snapshot.turns.${turnId}.turnId`);
  requireString(record.agentId, `snapshot.turns.${turnId}.agentId`);
  requireOneOf(
    record.state,
    ["queued", "starting", "running", "waiting_permission", "completed", "failed", "cancelled"],
    `snapshot.turns.${turnId}.state`,
  );
  requireNumber(record.revision, `snapshot.turns.${turnId}.revision`);
  requireString(record.createdAt, `snapshot.turns.${turnId}.createdAt`);
}

function parsePermission(permissionId: string, value: unknown): void {
  const record = requireRecord(value, `snapshot.permissions.${permissionId}`);
  requireString(record.permissionId, `snapshot.permissions.${permissionId}.permissionId`);
  requireString(record.agentId, `snapshot.permissions.${permissionId}.agentId`);
  requireString(record.turnId, `snapshot.permissions.${permissionId}.turnId`);
  requireOneOf(
    record.state,
    ["pending", "resolved", "expired", "cancelled"],
    `snapshot.permissions.${permissionId}.state`,
  );
  requireString(record.requestedAt, `snapshot.permissions.${permissionId}.requestedAt`);
  requireString(record.expiresAt, `snapshot.permissions.${permissionId}.expiresAt`);
}

function toAgentSummary(instance: ObservedFacadeInstance, agent: Agent): AgentDiagnosticSummary {
  return {
    instance,
    agentId: agent.agentId,
    kind: agent.kind,
    ...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
    agent: agent.agent,
    ...(agent.name ? { name: agent.name } : {}),
    cwd: agent.cwd,
    mode: agent.mode,
    depth: agent.depth,
    state: agent.state,
    ...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
    queueDepth: agent.queueDepth,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(agent.sessionOptions?.maxTurns ? { maxTurns: agent.sessionOptions.maxTurns } : {}),
    ...(agent.lastError ? { lastError: sanitizeError(agent.lastError) } : {}),
  };
}

function toAgentDetail(
  instance: ObservedFacadeInstance,
  snapshot: FacadeSnapshot,
  agent: Agent,
): AgentDiagnosticDetail {
  const summary = toAgentSummary(instance, agent);
  const activeTurn = agent.activeTurnId ? snapshot.turns[agent.activeTurnId] : undefined;
  const pendingPermission = activeTurn?.pendingPermissionId
    ? snapshot.permissions[activeTurn.pendingPermissionId]
    : undefined;
  return {
    ...summary,
    ...(activeTurn ? { activeTurn: toDiagnosticTurn(activeTurn) } : {}),
    ...(pendingPermission ? { pendingPermission: toDiagnosticPermission(pendingPermission) } : {}),
  };
}

function toDiagnosticTurn(turn: Turn): DiagnosticTurn {
  return {
    turnId: turn.turnId,
    state: turn.state,
    revision: turn.revision,
    ...(turn.pendingPermissionId ? { pendingPermissionId: turn.pendingPermissionId } : {}),
    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    ...(turn.error ? { error: sanitizeError(turn.error) } : {}),
    createdAt: turn.createdAt,
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
  };
}

function toDiagnosticPermission(
  permission: Permission,
): AgentDiagnosticDetail["pendingPermission"] {
  return {
    permissionId: permission.permissionId,
    state: permission.state,
    inferredKind: inferPermissionKind(permission.request),
    requestedAt: permission.requestedAt,
    expiresAt: permission.expiresAt,
  };
}

function sanitizeError(error: FacadeErrorShape): DiagnosticErrorShape {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...("runtimeCode" in error && typeof error.runtimeCode === "string"
      ? { runtimeCode: error.runtimeCode }
      : {}),
  };
}

function inferPermissionKind(request: Permission["request"]): string | undefined {
  if (
    request &&
    typeof request === "object" &&
    "kind" in request &&
    typeof request.kind === "string"
  ) {
    return request.kind;
  }
  return undefined;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function requireOneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Invalid ${name}`);
  }
  return value as T;
}
