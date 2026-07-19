import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntimeEvent,
} from "../../runtime.js";
import { canonicalizeWorkspacePath } from "../workspace-path.js";
import { FacadeError, normalizeFacadeError } from "./errors.js";
import type {
  Agent,
  AgentRuntimeAdapter,
  CreateAgentInput,
  EventsPage,
  FacadeActor,
  FacadeEvent,
  FacadeEventType,
  FacadeIdentityIssuer,
  FacadeLimits,
  FacadeSnapshot,
  FacadeStore,
  Message,
  MutationAuditContext,
  Permission,
  SendInput,
  SendReceipt,
  Turn,
  WaitMessageResult,
} from "./types.js";

const DEFAULT_LIMITS: FacadeLimits = {
  maxDelegationDepth: 4,
  maxManagedAgents: 16,
  maxQueuedTurnsPerAgent: 32,
  maxConcurrentTurns: 8,
  maxWaitMs: 30_000,
  permissionTimeoutMs: 30_000,
  identityTtlMs: 24 * 60 * 60 * 1_000,
  eventPageSize: 100,
};
const TEXT_DELTA_BATCH_COUNT = 16;
const TEXT_DELTA_BATCH_CHARACTERS = 4_096;

type RuntimeTextDelta = Extract<AcpRuntimeEvent, { type: "text_delta" }>;

class RuntimeEventBatcher {
  private pendingTextDelta?: RuntimeTextDelta;
  private pendingTextDeltaCount = 0;

  push(event: AcpRuntimeEvent): AcpRuntimeEvent[] {
    if (event.type !== "text_delta") {
      return [...this.flush(), event];
    }
    const ready = this.canAppend(event) ? [] : this.flush();
    this.append(event);
    if (this.reachedLimit()) {
      ready.push(...this.flush());
    }
    return ready;
  }

  flush(): AcpRuntimeEvent[] {
    if (!this.pendingTextDelta) {
      return [];
    }
    const event = this.pendingTextDelta;
    this.pendingTextDelta = undefined;
    this.pendingTextDeltaCount = 0;
    return [event];
  }

  private canAppend(event: RuntimeTextDelta): boolean {
    return (
      this.pendingTextDelta !== undefined &&
      this.pendingTextDelta.stream === event.stream &&
      this.pendingTextDelta.tag === event.tag
    );
  }

  private append(event: RuntimeTextDelta): void {
    if (!this.pendingTextDelta) {
      this.pendingTextDelta = { ...event };
      this.pendingTextDeltaCount = 1;
      return;
    }
    this.pendingTextDelta.text += event.text;
    this.pendingTextDeltaCount += 1;
  }

  private reachedLimit(): boolean {
    return (
      this.pendingTextDeltaCount >= TEXT_DELTA_BATCH_COUNT ||
      (this.pendingTextDelta?.text.length ?? 0) >= TEXT_DELTA_BATCH_CHARACTERS
    );
  }
}

async function forEachBatchedRuntimeEvent(
  events: AsyncIterable<AcpRuntimeEvent>,
  visit: (event: AcpRuntimeEvent) => Promise<void>,
): Promise<void> {
  const batcher = new RuntimeEventBatcher();
  try {
    for await (const event of events) {
      for (const ready of batcher.push(event)) {
        await visit(ready);
      }
    }
  } finally {
    for (const ready of batcher.flush()) {
      await visit(ready);
    }
  }
}

type MultiAgentFacadeOptions = {
  store: FacadeStore;
  identity: FacadeIdentityIssuer;
  runtime: AgentRuntimeAdapter;
  rootExecutionId: string;
  allowedCwdRoots: string[];
  mcpServersForToken: (token: string) => McpServer[];
  limits?: Partial<FacadeLimits>;
  now?: () => number;
  createId?: () => string;
};

type WaitTurnResult = {
  changed: boolean;
  turn: Turn;
  retryAfterMs?: number;
};

type EventsInput = {
  afterCursor?: string;
  turnId?: string;
  agentId?: string;
  limit?: number;
  waitMs?: number;
};

type PermissionWaiter = {
  resolve: (decision: AcpPermissionDecision | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};

function isTerminalTurn(turn: Turn): boolean {
  return turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled";
}

function activeTurnCount(snapshot: FacadeSnapshot, rootExecutionId: string): number {
  return Object.values(snapshot.agents).filter(
    (agent) => agent.rootExecutionId === rootExecutionId && agent.activeTurnId !== undefined,
  ).length;
}

function isDescendantOrSelf(
  snapshot: FacadeSnapshot,
  ancestorAgentId: string,
  targetAgentId: string,
): boolean {
  let current: Agent | undefined = snapshot.agents[targetAgentId];
  const visited = new Set<string>();
  while (current && !visited.has(current.agentId)) {
    if (current.agentId === ancestorAgentId) {
      return true;
    }
    visited.add(current.agentId);
    current = current.parentAgentId ? snapshot.agents[current.parentAgentId] : undefined;
  }
  return false;
}

function requireActor(snapshot: FacadeSnapshot, actor: FacadeActor): Agent {
  if (actor.rootExecutionId !== snapshot.agents[actor.agentId]?.rootExecutionId) {
    throw new FacadeError("UNAUTHORIZED", "Actor identity is not valid for this execution");
  }
  const agent = snapshot.agents[actor.agentId];
  if (!agent || agent.state === "destroying" || agent.state === "destroyed") {
    throw new FacadeError("UNAUTHORIZED", "Actor is not active");
  }
  return agent;
}

function requireVisibleAgent(snapshot: FacadeSnapshot, actor: FacadeActor, agentId: string): Agent {
  requireActor(snapshot, actor);
  const agent = snapshot.agents[agentId];
  if (!agent) {
    throw new FacadeError("AGENT_NOT_FOUND", `Agent ${agentId} was not found`);
  }
  if (
    agent.rootExecutionId !== actor.rootExecutionId ||
    !isDescendantOrSelf(snapshot, actor.agentId, agentId)
  ) {
    throw new FacadeError("UNAUTHORIZED", "Actor cannot access the requested agent");
  }
  return agent;
}

function appendEvent(
  snapshot: FacadeSnapshot,
  input: Omit<FacadeEvent, "cursor" | "timestamp">,
  timestamp: string,
): FacadeEvent {
  const event: FacadeEvent = {
    ...input,
    cursor: String(snapshot.nextCursor),
    timestamp,
  };
  snapshot.nextCursor += 1;
  snapshot.events.push(event);
  return event;
}

function appendMutationAudit(
  snapshot: FacadeSnapshot,
  audit: MutationAuditContext | undefined,
  actor: FacadeActor,
  target: {
    agentId?: string;
    turnId?: string;
    permissionId?: string;
    agent?: string;
    outcome: string;
  },
  timestamp: string,
): void {
  if (!audit) {
    return;
  }
  appendEvent(
    snapshot,
    {
      rootExecutionId: actor.rootExecutionId,
      type: "audit.mutation",
      actorAgentId: actor.agentId,
      agentId: target.agentId ?? actor.agentId,
      ...(target.turnId ? { turnId: target.turnId } : {}),
      data: {
        toolName: audit.toolName,
        requestId: audit.requestId,
        outcome: target.outcome,
        ...(target.permissionId ? { permissionId: target.permissionId } : {}),
        ...(target.agent ? { agent: target.agent } : {}),
      },
    },
    timestamp,
  );
}

function fingerprintSend(input: SendInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId,
        content: input.content,
        attachments: input.attachments ?? [],
        timeoutMs: input.timeoutMs,
      }),
    )
    .digest("hex");
}

function cancelRecoveredAgentTurns(
  snapshot: FacadeSnapshot,
  retiredAgentIds: Set<string>,
  timestamp: string,
): void {
  for (const turn of Object.values(snapshot.turns)) {
    if (!retiredAgentIds.has(turn.agentId) || isTerminalTurn(turn)) {
      continue;
    }
    turn.state = "cancelled";
    turn.stopReason = "agent lifecycle was interrupted by facade restart";
    turn.completedAt = timestamp;
    turn.revision += 1;
    delete turn.pendingPermissionId;
    appendEvent(
      snapshot,
      {
        rootExecutionId: turn.rootExecutionId,
        type: "turn.cancelled",
        agentId: turn.agentId,
        turnId: turn.turnId,
        data: { reason: turn.stopReason },
      },
      timestamp,
    );
  }
}

function recoverManagedAgents(snapshot: FacadeSnapshot, timestamp: string): string[] {
  const revoked: string[] = [];
  const retired = new Set<string>();
  for (const agent of Object.values(snapshot.agents)) {
    if (agent.kind !== "managed" || agent.state === "destroyed") {
      continue;
    }
    revoked.push(agent.agentId);
    if (agent.state === "creating" || agent.state === "destroying") {
      const previousState = agent.state;
      retired.add(agent.agentId);
      agent.state = "destroyed";
      delete agent.activeTurnId;
      agent.queueDepth = 0;
      agent.updatedAt = timestamp;
      appendEvent(
        snapshot,
        {
          rootExecutionId: agent.rootExecutionId,
          type: "agent.destroyed",
          agentId: agent.agentId,
          data: { recoveredAfterRestart: true, previousState },
        },
        timestamp,
      );
      continue;
    }
    agent.state = "dormant";
    delete agent.activeTurnId;
    agent.queueDepth = Object.values(snapshot.turns).filter(
      (turn) => turn.agentId === agent.agentId && turn.state === "queued",
    ).length;
    agent.updatedAt = timestamp;
  }
  cancelRecoveredAgentTurns(snapshot, retired, timestamp);
  return revoked;
}

function failInterruptedTurns(snapshot: FacadeSnapshot, timestamp: string): void {
  for (const turn of Object.values(snapshot.turns)) {
    if (turn.state === "queued" || isTerminalTurn(turn)) {
      continue;
    }
    turn.state = "failed";
    turn.error = {
      code: "RUNTIME_FAILURE",
      message: "Facade process restarted while the turn was active",
      retryable: false,
    };
    turn.revision += 1;
    turn.completedAt = timestamp;
    delete turn.pendingPermissionId;
    appendEvent(
      snapshot,
      {
        rootExecutionId: turn.rootExecutionId,
        type: "turn.failed",
        agentId: turn.agentId,
        turnId: turn.turnId,
        data: { error: turn.error },
      },
      timestamp,
    );
  }
}

function expirePendingPermissions(snapshot: FacadeSnapshot, timestamp: string): void {
  for (const permission of Object.values(snapshot.permissions)) {
    if (permission.state !== "pending") {
      continue;
    }
    permission.state = "expired";
    permission.resolvedAt = timestamp;
  }
}

function validateSendTarget(target: Agent): void {
  if (target.state === "creating") {
    throw new FacadeError("AGENT_NOT_READY", "Target agent is still being created", {
      retryable: true,
    });
  }
  if (target.kind !== "managed" || target.state === "destroying" || target.state === "destroyed") {
    throw new FacadeError("AGENT_NOT_FOUND", "Target agent is not available for messages");
  }
}

function isAgentReadyForTurn(agent: Agent): boolean {
  return agent.state === "idle" || agent.state === "failed";
}

function shouldPreparePersistentDiscard(
  discardSession: boolean | undefined,
  agent: Agent,
): boolean {
  return discardSession === true && agent.mode === "persistent";
}

function existingSendReceipt(
  snapshot: FacadeSnapshot,
  idempotencyId: string,
  fingerprint: string,
): SendReceipt | undefined {
  const existing = snapshot.idempotency[idempotencyId];
  if (!existing) {
    return undefined;
  }
  if (existing.fingerprint !== fingerprint) {
    throw new FacadeError(
      "IDEMPOTENCY_CONFLICT",
      "idempotencyKey was already used with different input",
    );
  }
  return existing.receipt;
}

function createQueuedRecords(input: {
  snapshot: FacadeSnapshot;
  target: Agent;
  send: SendInput;
  actor: FacadeActor;
  timestamp: string;
  createId: () => string;
}): { message: Message; turn: Turn; receipt: SendReceipt } {
  const messageId = input.createId();
  const turnId = input.createId();
  const queuePosition = input.target.queueDepth + (input.target.activeTurnId ? 1 : 0) + 1;
  const message: Message = {
    messageId,
    rootExecutionId: input.actor.rootExecutionId,
    direction: "inbound",
    fromAgentId: input.actor.agentId,
    toAgentId: input.target.agentId,
    turnId,
    content: input.send.content,
    createdAt: input.timestamp,
  };
  if (input.send.attachments) {
    message.attachments = input.send.attachments;
  }
  const turn: Turn = {
    turnId,
    rootExecutionId: input.actor.rootExecutionId,
    agentId: input.target.agentId,
    requestedByAgentId: input.actor.agentId,
    inputMessageId: messageId,
    state: "queued",
    revision: 1,
    createdAt: input.timestamp,
  };
  const parentTurnId = input.snapshot.agents[input.actor.agentId]?.activeTurnId;
  if (parentTurnId) {
    turn.parentTurnId = parentTurnId;
  }
  if (input.send.timeoutMs !== undefined) {
    turn.timeoutMs = input.send.timeoutMs;
  }
  return {
    message,
    turn,
    receipt: { accepted: true, messageId, turnId, queuePosition },
  };
}

function acceptSend(input: {
  snapshot: FacadeSnapshot;
  send: SendInput;
  actor: FacadeActor;
  fingerprint: string;
  idempotencyId: string;
  timestamp: string;
  maxQueueDepth: number;
  createId: () => string;
  audit?: MutationAuditContext;
}): SendReceipt {
  const target = requireVisibleAgent(input.snapshot, input.actor, input.send.agentId);
  if (target.agentId === input.actor.agentId) {
    throw new FacadeError("UNAUTHORIZED", "An agent cannot send a task to itself");
  }
  validateSendTarget(target);
  const existing = existingSendReceipt(input.snapshot, input.idempotencyId, input.fingerprint);
  if (existing) {
    appendMutationAudit(
      input.snapshot,
      input.audit,
      input.actor,
      { agentId: target.agentId, turnId: existing.turnId, outcome: "idempotent" },
      input.timestamp,
    );
    return existing;
  }
  if (target.queueDepth >= input.maxQueueDepth) {
    throw new FacadeError("TURN_QUEUE_FULL", `Agent queue cannot exceed ${input.maxQueueDepth}`, {
      retryable: true,
    });
  }
  const queued = createQueuedRecords({
    snapshot: input.snapshot,
    target,
    send: input.send,
    actor: input.actor,
    timestamp: input.timestamp,
    createId: input.createId,
  });
  input.snapshot.messages[queued.message.messageId] = queued.message;
  input.snapshot.turns[queued.turn.turnId] = queued.turn;
  input.snapshot.idempotency[input.idempotencyId] = {
    fingerprint: input.fingerprint,
    receipt: queued.receipt,
  };
  target.queueDepth += 1;
  target.updatedAt = input.timestamp;
  appendEvent(
    input.snapshot,
    {
      rootExecutionId: target.rootExecutionId,
      type: "message.accepted",
      actorAgentId: input.actor.agentId,
      agentId: target.agentId,
      turnId: queued.turn.turnId,
      data: { messageId: queued.message.messageId },
    },
    input.timestamp,
  );
  appendEvent(
    input.snapshot,
    {
      rootExecutionId: target.rootExecutionId,
      type: "turn.queued",
      actorAgentId: input.actor.agentId,
      agentId: target.agentId,
      turnId: queued.turn.turnId,
      data: { queuePosition: queued.receipt.queuePosition },
    },
    input.timestamp,
  );
  appendMutationAudit(
    input.snapshot,
    input.audit,
    input.actor,
    { agentId: target.agentId, turnId: queued.turn.turnId, outcome: "accepted" },
    input.timestamp,
  );
  return queued.receipt;
}

function requireResolvablePermission(
  snapshot: FacadeSnapshot,
  input: { permissionId: string; outcome: AcpPermissionDecision["outcome"] },
  actor: FacadeActor,
): Permission {
  const permission = snapshot.permissions[input.permissionId];
  if (!permission) {
    throw new FacadeError("PERMISSION_NOT_FOUND", `Permission ${input.permissionId} was not found`);
  }
  requireVisibleAgent(snapshot, actor, permission.agentId);
  if (actor.agentId === permission.agentId) {
    throw new FacadeError("UNAUTHORIZED", "An agent cannot resolve its own permission");
  }
  if (permission.state === "resolved" && permission.outcome === input.outcome) {
    return permission;
  }
  if (permission.state === "expired") {
    throw new FacadeError("PERMISSION_EXPIRED", "Permission has expired");
  }
  if (permission.state !== "pending") {
    throw new FacadeError(
      "PERMISSION_ALREADY_RESOLVED",
      `Permission is already ${permission.state}`,
    );
  }
  return permission;
}

function resolvePermissionInSnapshot(
  snapshot: FacadeSnapshot,
  input: { permissionId: string; outcome: AcpPermissionDecision["outcome"] },
  actor: FacadeActor,
  timestamp: string,
): Permission {
  const permission = requireResolvablePermission(snapshot, input, actor);
  if (permission.state === "resolved") {
    return permission;
  }
  permission.state = "resolved";
  permission.outcome = input.outcome;
  permission.resolvedAt = timestamp;
  permission.resolvedByAgentId = actor.agentId;
  const turn = snapshot.turns[permission.turnId];
  if (turn && !isTerminalTurn(turn)) {
    turn.state = "running";
    delete turn.pendingPermissionId;
    turn.revision += 1;
  }
  const agent = snapshot.agents[permission.agentId];
  if (agent?.state === "waiting_permission") {
    agent.state = "running";
    agent.updatedAt = timestamp;
  }
  appendEvent(
    snapshot,
    {
      rootExecutionId: permission.rootExecutionId,
      type: "permission.resolved",
      actorAgentId: actor.agentId,
      agentId: permission.agentId,
      turnId: permission.turnId,
      data: { permissionId: permission.permissionId, outcome: permission.outcome },
    },
    timestamp,
  );
  return permission;
}

function collectDescendantTurnIds(snapshot: FacadeSnapshot, rootTurnId: string): Set<string> {
  const turnIds = new Set([rootTurnId]);
  let added = true;
  while (added) {
    added = false;
    for (const turn of Object.values(snapshot.turns)) {
      if (turn.parentTurnId && turnIds.has(turn.parentTurnId) && !turnIds.has(turn.turnId)) {
        turnIds.add(turn.turnId);
        added = true;
      }
    }
  }
  return turnIds;
}

function cancelQueuedTurn(
  snapshot: FacadeSnapshot,
  turn: Turn,
  actor: FacadeActor,
  reason: string,
  timestamp: string,
): void {
  turn.state = "cancelled";
  turn.stopReason = reason;
  turn.completedAt = timestamp;
  turn.revision += 1;
  const agent = snapshot.agents[turn.agentId];
  if (agent) {
    agent.queueDepth = Math.max(0, agent.queueDepth - 1);
    agent.updatedAt = timestamp;
  }
  appendEvent(
    snapshot,
    {
      rootExecutionId: turn.rootExecutionId,
      type: "turn.cancelled",
      actorAgentId: actor.agentId,
      agentId: turn.agentId,
      turnId: turn.turnId,
      data: { reason },
    },
    timestamp,
  );
}

function markActiveTurnCancellation(
  snapshot: FacadeSnapshot,
  turn: Turn,
  activeTurnIds: string[],
  cancelledPermissionIds: string[],
  timestamp: string,
): void {
  activeTurnIds.push(turn.turnId);
  const permission = turn.pendingPermissionId
    ? snapshot.permissions[turn.pendingPermissionId]
    : undefined;
  if (permission?.state === "pending") {
    permission.state = "cancelled";
    permission.resolvedAt = timestamp;
    cancelledPermissionIds.push(permission.permissionId);
  }
}

function cancelTurnsInSnapshot(input: {
  snapshot: FacadeSnapshot;
  turnId: string;
  reason: string;
  actor: FacadeActor;
  timestamp: string;
  activeTurnIds: string[];
  cancelledPermissionIds: string[];
}): Turn {
  const requested = input.snapshot.turns[input.turnId];
  if (!requested) {
    throw new FacadeError("TURN_NOT_FOUND", `Turn ${input.turnId} was not found`);
  }
  requireVisibleAgent(input.snapshot, input.actor, requested.agentId);
  if (isTerminalTurn(requested)) {
    return requested;
  }
  const turnIds = collectDescendantTurnIds(input.snapshot, requested.turnId);
  for (const turnId of turnIds) {
    const turn = input.snapshot.turns[turnId];
    if (!turn || isTerminalTurn(turn)) {
      continue;
    }
    if (turn.state === "queued") {
      cancelQueuedTurn(input.snapshot, turn, input.actor, input.reason, input.timestamp);
      continue;
    }
    markActiveTurnCancellation(
      input.snapshot,
      turn,
      input.activeTurnIds,
      input.cancelledPermissionIds,
      input.timestamp,
    );
  }
  return input.snapshot.turns[input.turnId] ?? requested;
}

function eventVisible(
  snapshot: FacadeSnapshot,
  event: FacadeEvent,
  actor: FacadeActor,
  input: EventsInput,
  afterCursor: number,
): boolean {
  return (
    Number.parseInt(event.cursor, 10) > afterCursor &&
    isDescendantOrSelf(snapshot, actor.agentId, event.agentId) &&
    (!input.agentId || event.agentId === input.agentId) &&
    (!input.turnId || event.turnId === input.turnId)
  );
}

function validateEventScope(
  snapshot: FacadeSnapshot,
  input: EventsInput,
  actor: FacadeActor,
): void {
  requireActor(snapshot, actor);
  if (input.agentId) {
    requireVisibleAgent(snapshot, actor, input.agentId);
  }
  if (!input.turnId) {
    return;
  }
  const turn = snapshot.turns[input.turnId];
  if (!turn) {
    throw new FacadeError("TURN_NOT_FOUND", `Turn ${input.turnId} was not found`);
  }
  requireVisibleAgent(snapshot, actor, turn.agentId);
}

function readEventsPage(
  snapshot: FacadeSnapshot,
  input: EventsInput,
  actor: FacadeActor,
  defaultLimit: number,
): EventsPage {
  validateEventScope(snapshot, input, actor);
  const parsedCursor = Number.parseInt(input.afterCursor ?? "0", 10);
  const afterCursor = Number.isFinite(parsedCursor) ? parsedCursor : 0;
  const limit = Math.min(Math.max(input.limit ?? defaultLimit, 1), 1_000);
  const visible = snapshot.events.filter((event) =>
    eventVisible(snapshot, event, actor, input, afterCursor),
  );
  const events = visible.slice(0, limit);
  return {
    events,
    nextCursor: events.at(-1)?.cursor ?? input.afterCursor ?? "0",
    hasMore: visible.length > events.length,
  };
}

type RuntimeTurnResult = Awaited<ReturnType<AgentRuntimeAdapter["startTurn"]>["result"]>;

function createResultMessage(input: {
  snapshot: FacadeSnapshot;
  turn: Turn;
  output: string;
  timestamp: string;
  messageId: string;
}): void {
  input.snapshot.messages[input.messageId] = {
    messageId: input.messageId,
    rootExecutionId: input.turn.rootExecutionId,
    direction: "outbound",
    fromAgentId: input.turn.agentId,
    toAgentId: input.turn.requestedByAgentId,
    turnId: input.turn.turnId,
    inReplyTo: input.turn.inputMessageId,
    content: input.output,
    createdAt: input.timestamp,
  };
  input.turn.resultMessageId = input.messageId;
  appendEvent(
    input.snapshot,
    {
      rootExecutionId: input.turn.rootExecutionId,
      type: "message.completed",
      agentId: input.turn.agentId,
      turnId: input.turn.turnId,
      data: { messageId: input.messageId, inReplyTo: input.turn.inputMessageId },
    },
    input.timestamp,
  );
}

function applyRuntimeTurnResult(input: {
  snapshot: FacadeSnapshot;
  turn: Turn;
  result: RuntimeTurnResult;
  output: string;
  timestamp: string;
  createId: () => string;
}): void {
  if (input.result.status === "completed") {
    input.turn.state = "completed";
    input.turn.stopReason = input.result.stopReason;
    if (input.output) {
      createResultMessage({ ...input, messageId: input.createId() });
    }
    return;
  }
  if (input.result.status === "cancelled") {
    input.turn.state = "cancelled";
    input.turn.stopReason = input.result.stopReason;
    return;
  }
  input.turn.state = "failed";
  const runtimeCode = input.result.error.code ?? "RUNTIME_FAILURE";
  input.turn.error = {
    code: input.result.error.detailCode ?? runtimeCode,
    message: input.result.error.message,
    retryable: input.result.error.retryable ?? false,
  };
  if (input.result.error.detailCode) {
    input.turn.error.details = { runtimeCode };
  }
}

function finalizeAgentAfterTurn(agent: Agent | undefined, turn: Turn, timestamp: string): void {
  if (!agent || agent.state === "destroying" || agent.state === "destroyed") {
    return;
  }
  delete agent.activeTurnId;
  agent.state = turn.state === "failed" ? "failed" : "idle";
  agent.updatedAt = timestamp;
  if (turn.error) {
    agent.lastError = turn.error;
  }
}

function recordDestroyFailure(
  snapshot: FacadeSnapshot,
  targets: Agent[],
  actor: FacadeActor,
  error: unknown,
  timestamp: string,
): void {
  const normalized = normalizeFacadeError(error);
  for (const target of targets) {
    const agent = snapshot.agents[target.agentId];
    if (!agent || agent.state !== "destroying") {
      continue;
    }
    agent.state = "failed";
    agent.lastError = normalized;
    agent.updatedAt = timestamp;
    appendEvent(
      snapshot,
      {
        rootExecutionId: agent.rootExecutionId,
        type: "agent.state_changed",
        actorAgentId: actor.agentId,
        agentId: agent.agentId,
        data: { state: agent.state, error: normalized },
      },
      timestamp,
    );
  }
}

function prepareAgentsForShutdown(snapshot: FacadeSnapshot, timestamp: string): string[] {
  const agentIds: string[] = [];
  for (const agent of Object.values(snapshot.agents)) {
    if (agent.kind !== "managed" || agent.state === "destroyed") {
      continue;
    }
    agentIds.push(agent.agentId);
    agent.state = "destroying";
    agent.updatedAt = timestamp;
  }
  return agentIds;
}

function cancelTurnsForShutdown(snapshot: FacadeSnapshot, timestamp: string): void {
  for (const turn of Object.values(snapshot.turns)) {
    if (isTerminalTurn(turn)) {
      continue;
    }
    turn.state = "cancelled";
    turn.stopReason = "facade shutdown";
    turn.completedAt = timestamp;
    turn.revision += 1;
    delete turn.pendingPermissionId;
    appendEvent(
      snapshot,
      {
        rootExecutionId: turn.rootExecutionId,
        type: "turn.cancelled",
        agentId: turn.agentId,
        turnId: turn.turnId,
        data: { reason: turn.stopReason },
      },
      timestamp,
    );
  }
}

function cancelPermissionsForShutdown(snapshot: FacadeSnapshot, timestamp: string): void {
  for (const permission of Object.values(snapshot.permissions)) {
    if (permission.state !== "pending") {
      continue;
    }
    permission.state = "cancelled";
    permission.resolvedAt = timestamp;
  }
}

function terminalEventType(turn: Turn): FacadeEventType {
  if (turn.state === "completed") {
    return "turn.completed";
  }
  if (turn.state === "cancelled") {
    return "turn.cancelled";
  }
  return "turn.failed";
}

export class MultiAgentFacade {
  private readonly options: MultiAgentFacadeOptions;
  private readonly limits: FacadeLimits;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly allowedCwdRoots: string[];
  private readonly drainingAgents = new Set<string>();
  private readonly activatingAgents = new Map<string, Promise<void>>();
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  private readonly activeRuntimeTurns = new Map<
    string,
    ReturnType<AgentRuntimeAdapter["startTurn"]>
  >();
  private closed = false;
  private shutdownOperation?: Promise<void>;

  constructor(options: MultiAgentFacadeOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.allowedCwdRoots = options.allowedCwdRoots.map((root) => canonicalizeWorkspacePath(root));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new FacadeError("SESSION_RESUME_REQUIRED", "The MCP facade is shutting down", {
        retryable: true,
      });
    }
  }

  async bootstrapRoot(input: { agent: string; cwd: string; name?: string }): Promise<Agent> {
    this.assertOpen();
    const cwd = this.resolveCwd(input.cwd);
    const existing = await this.options.store.read((snapshot) =>
      Object.values(snapshot.agents).find(
        (agent) => agent.rootExecutionId === this.options.rootExecutionId && agent.kind === "root",
      ),
    );
    if (existing) {
      return existing;
    }

    const timestamp = this.timestamp();
    return await this.options.store.update((snapshot) => {
      const agent: Agent = {
        agentId: this.createId(),
        rootExecutionId: this.options.rootExecutionId,
        kind: "root",
        agent: input.agent,
        ...(input.name ? { name: input.name } : {}),
        cwd,
        mode: "persistent",
        depth: 0,
        state: "idle",
        queueDepth: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot.agents[agent.agentId] = agent;
      appendEvent(
        snapshot,
        {
          rootExecutionId: agent.rootExecutionId,
          type: "agent.created",
          agentId: agent.agentId,
          data: { kind: agent.kind, agent: agent.agent },
        },
        timestamp,
      );
      return agent;
    });
  }

  async recoverAfterRestart(): Promise<void> {
    this.assertOpen();
    const revokedAgentIds = await this.options.store.update((snapshot) => {
      const timestamp = this.timestamp();
      const revoked = recoverManagedAgents(snapshot, timestamp);
      failInterruptedTurns(snapshot, timestamp);
      expirePendingPermissions(snapshot, timestamp);
      return revoked;
    });
    await Promise.all(
      revokedAgentIds.map(async (agentId) => await this.options.identity.revokeAgent(agentId)),
    );
  }

  shutdown(): Promise<void> {
    this.closed = true;
    this.shutdownOperation ??= this.performShutdown();
    return this.shutdownOperation;
  }

  private async performShutdown(): Promise<void> {
    const failures: unknown[] = [];
    let agentIds: string[] = [];
    try {
      agentIds = await this.options.store.update((snapshot) => {
        const timestamp = this.timestamp();
        const ids = prepareAgentsForShutdown(snapshot, timestamp);
        cancelTurnsForShutdown(snapshot, timestamp);
        cancelPermissionsForShutdown(snapshot, timestamp);
        return ids;
      });
    } catch (error) {
      failures.push(error);
    }

    for (const waiter of this.permissionWaiters.values()) {
      waiter.resolve({ outcome: "cancel" });
      clearTimeout(waiter.timeout);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    this.permissionWaiters.clear();

    const cancelledTurns = await Promise.allSettled(
      [...this.activeRuntimeTurns.values()].map(async (turn) =>
        turn.cancel({ reason: "facade shutdown" }),
      ),
    );
    failures.push(
      ...cancelledTurns
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result): unknown => result.reason),
    );

    const revoked = await Promise.allSettled(
      agentIds.map(async (agentId) => await this.options.identity.revokeAgent(agentId)),
    );
    failures.push(
      ...revoked
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result): unknown => result.reason),
    );

    if (this.options.runtime.shutdown) {
      try {
        await this.options.runtime.shutdown();
      } catch (error) {
        failures.push(error);
      }
    } else {
      const destroyed = await Promise.allSettled(
        agentIds.map(async (agentId) =>
          this.options.runtime.destroyAgent(agentId, { discardSession: false }),
        ),
      );
      failures.push(
        ...destroyed
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result): unknown => result.reason),
      );
    }

    if (agentIds.length > 0) {
      try {
        await this.options.store.update((snapshot) => {
          const timestamp = this.timestamp();
          for (const agentId of agentIds) {
            const agent = snapshot.agents[agentId];
            if (!agent || agent.state === "destroyed") {
              continue;
            }
            agent.state = "dormant";
            delete agent.activeTurnId;
            agent.queueDepth = 0;
            agent.updatedAt = timestamp;
          }
        });
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more MCP facade resources failed to shut down");
    }
  }

  async capabilities(
    input: { probeAgents?: string[] } = {},
    actor: FacadeActor,
  ): Promise<{
    tools: string[];
    limits: FacadeLimits;
    agents: Array<{
      agent: string;
      availability: "available" | "unavailable" | "unknown";
      reason?: string;
    }>;
  }> {
    this.assertOpen();
    await this.options.store.read((snapshot) => requireActor(snapshot, actor));
    const requested = new Set(input.probeAgents ?? []);
    const agents = await Promise.all(
      this.options.runtime.listAgents().map(async (agent) => {
        if (!requested.has(agent)) {
          return { agent, availability: "unknown" as const };
        }
        const probe = await this.options.runtime.probeAgent(agent, { live: true });
        if (probe.available) {
          return { agent, availability: "available" as const };
        }
        const unavailable: {
          agent: string;
          availability: "unavailable";
          reason?: string;
        } = { agent, availability: "unavailable" };
        if (probe.reason) {
          unavailable.reason = probe.reason;
        }
        return unavailable;
      }),
    );
    return {
      tools: [
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
      ],
      limits: { ...this.limits },
      agents,
    };
  }

  async listAgents(
    input: {
      parentAgentId?: string;
      agent?: string;
      state?: Agent["state"];
      cursor?: string;
      limit?: number;
    },
    actor: FacadeActor,
  ): Promise<{ agents: Agent[]; nextCursor?: string; hasMore: boolean }> {
    this.assertOpen();
    return await this.options.store.read((snapshot) => {
      requireActor(snapshot, actor);
      if (input.parentAgentId) {
        requireVisibleAgent(snapshot, actor, input.parentAgentId);
      }
      const offset = Math.max(Number.parseInt(input.cursor ?? "0", 10) || 0, 0);
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000);
      const visible = Object.values(snapshot.agents)
        .filter(
          (agent) =>
            isDescendantOrSelf(snapshot, actor.agentId, agent.agentId) &&
            (!input.parentAgentId || agent.parentAgentId === input.parentAgentId) &&
            (!input.agent || agent.agent === input.agent) &&
            (!input.state || agent.state === input.state),
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
      const agents = visible.slice(offset, offset + limit);
      const nextOffset = offset + agents.length;
      return {
        agents,
        ...(nextOffset < visible.length ? { nextCursor: String(nextOffset) } : {}),
        hasMore: nextOffset < visible.length,
      };
    });
  }

  async status(
    input: { agentId: string },
    actor: FacadeActor,
  ): Promise<{
    agent: Agent;
    childCount: number;
    pendingPermission?: Permission;
    runtime?: Awaited<ReturnType<AgentRuntimeAdapter["getStatus"]>>;
  }> {
    this.assertOpen();
    const snapshot = await this.options.store.read((value) => {
      const agent = requireVisibleAgent(value, actor, input.agentId);
      const pendingPermission = Object.values(value.permissions).find(
        (permission) => permission.agentId === agent.agentId && permission.state === "pending",
      );
      return {
        agent,
        childCount: Object.values(value.agents).filter(
          (candidate) =>
            candidate.parentAgentId === agent.agentId && candidate.state !== "destroyed",
        ).length,
        ...(pendingPermission ? { pendingPermission } : {}),
      };
    });
    if (
      snapshot.agent.kind === "root" ||
      snapshot.agent.state === "dormant" ||
      snapshot.agent.state === "failed" ||
      snapshot.agent.state === "destroyed"
    ) {
      return snapshot;
    }
    const runtime = await this.options.runtime.getStatus(snapshot.agent.agentId);
    return { ...snapshot, runtime };
  }

  async createAgent(
    input: CreateAgentInput,
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Agent> {
    this.assertOpen();
    const parent = await this.options.store.read((snapshot) => requireActor(snapshot, actor));
    if (parent.depth >= this.limits.maxDelegationDepth) {
      throw new FacadeError(
        "DELEGATION_DEPTH_EXCEEDED",
        `Delegation depth cannot exceed ${this.limits.maxDelegationDepth}`,
      );
    }

    const availability = await this.options.runtime.probeAgent(input.agent);
    if (!availability.available) {
      throw new FacadeError(
        "AGENT_UNAVAILABLE",
        availability.reason ?? `Agent ${input.agent} is unavailable`,
      );
    }

    const cwd = this.resolveCwd(input.cwd ?? parent.cwd);
    const timestamp = this.timestamp();
    const agent = await this.options.store.update((snapshot) => {
      requireActor(snapshot, actor);
      const managedCount = Object.values(snapshot.agents).filter(
        (candidate) =>
          candidate.rootExecutionId === actor.rootExecutionId &&
          candidate.kind === "managed" &&
          candidate.state !== "destroyed",
      ).length;
      if (managedCount >= this.limits.maxManagedAgents) {
        throw new FacadeError(
          "AGENT_LIMIT_REACHED",
          `Managed agent count cannot exceed ${this.limits.maxManagedAgents}`,
        );
      }

      const currentParent = snapshot.agents[parent.agentId];
      const child: Agent = {
        agentId: this.createId(),
        rootExecutionId: actor.rootExecutionId,
        kind: "managed",
        parentAgentId: parent.agentId,
        ...(currentParent?.activeTurnId ? { createdByTurnId: currentParent.activeTurnId } : {}),
        agent: input.agent,
        ...(input.name ? { name: input.name } : {}),
        cwd,
        mode: input.mode ?? "persistent",
        depth: parent.depth + 1,
        state: "creating",
        queueDepth: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.sessionOptions ? { sessionOptions: input.sessionOptions } : {}),
      };
      snapshot.agents[child.agentId] = child;
      appendEvent(
        snapshot,
        {
          rootExecutionId: child.rootExecutionId,
          type: "agent.created",
          actorAgentId: actor.agentId,
          agentId: child.agentId,
          data: { kind: child.kind, agent: child.agent, parentAgentId: child.parentAgentId },
        },
        timestamp,
      );
      appendMutationAudit(
        snapshot,
        audit,
        actor,
        { agentId: child.agentId, agent: child.agent, outcome: "accepted" },
        timestamp,
      );
      return child;
    });

    const childActor = { rootExecutionId: agent.rootExecutionId, agentId: agent.agentId };
    const token = await this.options.identity.issue(childActor);
    try {
      const runtimeCwd = this.resolveStableAgentCwd(agent);
      await this.options.runtime.ensureAgent(
        {
          agentId: agent.agentId,
          rootExecutionId: agent.rootExecutionId,
          sessionKey: `mcp-${agent.rootExecutionId}-${agent.agentId}`,
          agent: agent.agent,
          cwd: runtimeCwd,
          mode: agent.mode,
          mcpServers: this.options.mcpServersForToken(token),
          ...(agent.sessionOptions ? { sessionOptions: agent.sessionOptions } : {}),
        },
        {
          onPermissionRequest: async (request, context) =>
            await this.requestPermission(agent.agentId, request, context.signal),
        },
      );
    } catch (error) {
      const unavailable = new FacadeError("AGENT_UNAVAILABLE", `Could not create ${agent.agent}`, {
        cause: error,
        details: { agentId: agent.agentId },
      });
      await this.options.identity.revokeAgent(agent.agentId);
      await this.failAgentCreation(agent.agentId, unavailable);
      throw unavailable;
    }

    const activation = await this.options.store.update((snapshot) => {
      const created = snapshot.agents[agent.agentId];
      if (!created) {
        throw new FacadeError("AGENT_NOT_FOUND", `Agent ${agent.agentId} was not found`);
      }
      if (created.state !== "creating") {
        return { activated: false, agent: created };
      }
      created.state = "idle";
      created.updatedAt = this.timestamp();
      appendEvent(
        snapshot,
        {
          rootExecutionId: created.rootExecutionId,
          type: "agent.state_changed",
          actorAgentId: actor.agentId,
          agentId: created.agentId,
          data: { state: created.state },
        },
        created.updatedAt,
      );
      return { activated: true, agent: created };
    });
    if (!activation.activated) {
      await Promise.allSettled([
        this.options.identity.revokeAgent(agent.agentId),
        this.options.runtime.destroyAgent(agent.agentId, { discardSession: false }),
      ]);
      throw new FacadeError(
        "AGENT_NOT_FOUND",
        `Agent ${agent.agentId} is no longer being created`,
        { details: { agentId: agent.agentId, state: activation.agent.state } },
      );
    }
    return activation.agent;
  }

  async send(
    input: SendInput,
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<SendReceipt> {
    this.assertOpen();
    if (!input.idempotencyKey.trim()) {
      throw new FacadeError("IDEMPOTENCY_CONFLICT", "idempotencyKey must not be empty");
    }
    const targetState = await this.options.store.read(
      (snapshot) => requireVisibleAgent(snapshot, actor, input.agentId).state,
    );
    if (targetState === "dormant") {
      await this.activateDormantAgent(input.agentId);
    }
    const fingerprint = fingerprintSend(input);
    const idempotencyId = `${actor.agentId}:${input.idempotencyKey}`;
    const timestamp = this.timestamp();
    const receipt = await this.options.store.update((snapshot) =>
      acceptSend({
        snapshot,
        send: input,
        actor,
        fingerprint,
        idempotencyId,
        timestamp,
        maxQueueDepth: this.limits.maxQueuedTurnsPerAgent,
        createId: this.createId,
        audit,
      }),
    );

    this.scheduleDrain(input.agentId);
    return receipt;
  }

  async getTurn(input: { turnId: string }, actor: FacadeActor): Promise<Turn> {
    this.assertOpen();
    return await this.options.store.read((snapshot) => {
      const turn = snapshot.turns[input.turnId];
      if (!turn) {
        throw new FacadeError("TURN_NOT_FOUND", `Turn ${input.turnId} was not found`);
      }
      requireVisibleAgent(snapshot, actor, turn.agentId);
      return turn;
    });
  }

  async waitTurn(
    input: { turnId: string; afterRevision?: number; waitMs?: number },
    actor: FacadeActor,
  ): Promise<WaitTurnResult> {
    this.assertOpen();
    const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), this.limits.maxWaitMs);
    const deadline = this.now() + waitMs;
    const afterRevision = input.afterRevision ?? -1;
    while (true) {
      const current = await this.options.store.read((snapshot) => {
        const turn = snapshot.turns[input.turnId];
        if (!turn) {
          throw new FacadeError("TURN_NOT_FOUND", `Turn ${input.turnId} was not found`);
        }
        requireVisibleAgent(snapshot, actor, turn.agentId);
        return { turn, storeRevision: snapshot.revision };
      });
      if (
        current.turn.revision > afterRevision ||
        current.turn.state === "waiting_permission" ||
        isTerminalTurn(current.turn)
      ) {
        return { changed: current.turn.revision > afterRevision, turn: current.turn };
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return { changed: false, turn: current.turn, retryAfterMs: Math.min(1_000, waitMs) };
      }
      await this.options.store.waitForChange(current.storeRevision, remaining);
    }
  }

  async getMessage(input: { messageId: string }, actor: FacadeActor): Promise<Message> {
    this.assertOpen();
    return await this.options.store.read((snapshot) => {
      const message = snapshot.messages[input.messageId];
      if (!message) {
        throw new FacadeError("MESSAGE_NOT_FOUND", `Message ${input.messageId} was not found`);
      }
      requireVisibleAgent(snapshot, actor, message.toAgentId);
      return message;
    });
  }

  async respondPermission(
    input: { permissionId: string; outcome: AcpPermissionDecision["outcome"] },
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Permission> {
    this.assertOpen();
    const timestamp = this.timestamp();
    const permission = await this.options.store.update((snapshot) => {
      const wasResolved = snapshot.permissions[input.permissionId]?.state === "resolved";
      const resolved = resolvePermissionInSnapshot(snapshot, input, actor, timestamp);
      appendMutationAudit(
        snapshot,
        audit,
        actor,
        {
          agentId: resolved.agentId,
          turnId: resolved.turnId,
          permissionId: resolved.permissionId,
          outcome: wasResolved ? "idempotent" : input.outcome,
        },
        timestamp,
      );
      return resolved;
    });

    this.resolvePermissionWaiter(input.permissionId, { outcome: input.outcome });
    return permission;
  }

  async cancel(
    input: { turnId: string; reason?: string },
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Turn> {
    this.assertOpen();
    const activeTurnIds: string[] = [];
    const cancelledPermissionIds: string[] = [];
    const timestamp = this.timestamp();
    const target = await this.options.store.update((snapshot) => {
      const existing = snapshot.turns[input.turnId];
      const wasTerminal = existing ? isTerminalTurn(existing) : false;
      const cancelled = cancelTurnsInSnapshot({
        snapshot,
        turnId: input.turnId,
        reason: input.reason ?? "cancelled",
        actor,
        timestamp,
        activeTurnIds,
        cancelledPermissionIds,
      });
      appendMutationAudit(
        snapshot,
        audit,
        actor,
        {
          agentId: cancelled.agentId,
          turnId: cancelled.turnId,
          outcome: wasTerminal ? "idempotent" : "accepted",
        },
        timestamp,
      );
      return cancelled;
    });

    for (const permissionId of cancelledPermissionIds) {
      this.resolvePermissionWaiter(permissionId, { outcome: "cancel" });
    }
    await Promise.all(
      activeTurnIds.map(async (turnId) => {
        await this.activeRuntimeTurns.get(turnId)?.cancel({ reason: input.reason });
      }),
    );
    return target;
  }

  async destroyAgent(
    input: { agentId: string; cascade?: boolean; discardSession?: boolean },
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Agent> {
    this.assertOpen();
    const selection = await this.options.store.update((snapshot) => {
      const target = requireVisibleAgent(snapshot, actor, input.agentId);
      if (target.kind !== "managed") {
        throw new FacadeError("UNAUTHORIZED", "The root agent cannot be destroyed");
      }
      if (target.agentId === actor.agentId) {
        throw new FacadeError("UNAUTHORIZED", "A managed agent cannot destroy itself");
      }
      if (target.state === "destroyed") {
        appendMutationAudit(
          snapshot,
          audit,
          actor,
          { agentId: target.agentId, outcome: "idempotent" },
          this.timestamp(),
        );
        return { targets: [target], alreadyDestroyed: true };
      }
      const descendants = Object.values(snapshot.agents).filter(
        (candidate) =>
          candidate.agentId !== target.agentId &&
          candidate.state !== "destroyed" &&
          isDescendantOrSelf(snapshot, target.agentId, candidate.agentId),
      );
      if (descendants.length > 0 && !input.cascade) {
        throw new FacadeError(
          "AGENT_HAS_LIVE_DESCENDANTS",
          "Agent has live descendants; set cascade=true to destroy the subtree",
          { details: { descendantCount: descendants.length } },
        );
      }
      const selected = [target, ...descendants].toSorted((left, right) => right.depth - left.depth);
      const timestamp = this.timestamp();
      for (const agent of selected) {
        agent.state = "destroying";
        agent.updatedAt = timestamp;
        appendEvent(
          snapshot,
          {
            rootExecutionId: agent.rootExecutionId,
            type: "agent.state_changed",
            actorAgentId: actor.agentId,
            agentId: agent.agentId,
            data: { state: agent.state },
          },
          timestamp,
        );
      }
      appendMutationAudit(
        snapshot,
        audit,
        actor,
        { agentId: target.agentId, outcome: "accepted" },
        timestamp,
      );
      return { targets: selected, alreadyDestroyed: false };
    });

    const primaryTarget = selection.targets[0];
    if (!primaryTarget) {
      throw new FacadeError("AGENT_NOT_FOUND", `Agent ${input.agentId} was not found`);
    }
    if (selection.alreadyDestroyed) {
      return primaryTarget;
    }
    const targets = selection.targets;

    const targetIds = new Set(targets.map((target) => target.agentId));
    const turnIds = await this.options.store.read((snapshot) =>
      Object.values(snapshot.turns)
        .filter((turn) => targetIds.has(turn.agentId) && !isTerminalTurn(turn))
        .map((turn) => turn.turnId),
    );
    for (const turnId of turnIds) {
      await this.cancel({ turnId, reason: "agent destroyed" }, actor);
    }
    try {
      for (const target of targets) {
        if (shouldPreparePersistentDiscard(input.discardSession, target)) {
          await this.ensurePersistentRuntimeForDiscard(target);
        }
        await this.options.runtime.destroyAgent(target.agentId, {
          discardSession: input.discardSession ?? false,
        });
        await this.options.identity.revokeAgent(target.agentId);
      }
    } catch (error) {
      const timestamp = this.timestamp();
      await this.options.store.update((snapshot) => {
        recordDestroyFailure(snapshot, targets, actor, error, timestamp);
        appendMutationAudit(
          snapshot,
          audit,
          actor,
          { agentId: input.agentId, outcome: "failed" },
          timestamp,
        );
      });
      throw error;
    }

    return await this.options.store.update((snapshot) => {
      const timestamp = this.timestamp();
      for (const turn of Object.values(snapshot.turns)) {
        if (!targetIds.has(turn.agentId) || isTerminalTurn(turn)) {
          continue;
        }
        turn.state = "cancelled";
        turn.stopReason = "agent destroyed";
        turn.completedAt = timestamp;
        turn.revision += 1;
        delete turn.pendingPermissionId;
        appendEvent(
          snapshot,
          {
            rootExecutionId: turn.rootExecutionId,
            type: "turn.cancelled",
            actorAgentId: actor.agentId,
            agentId: turn.agentId,
            turnId: turn.turnId,
            data: { reason: turn.stopReason },
          },
          timestamp,
        );
      }
      for (const target of targets) {
        const agent = snapshot.agents[target.agentId];
        if (!agent) {
          continue;
        }
        agent.state = "destroyed";
        delete agent.activeTurnId;
        agent.queueDepth = 0;
        agent.updatedAt = timestamp;
        appendEvent(
          snapshot,
          {
            rootExecutionId: agent.rootExecutionId,
            type: "agent.destroyed",
            actorAgentId: actor.agentId,
            agentId: agent.agentId,
            data: { discardSession: input.discardSession ?? false },
          },
          timestamp,
        );
      }
      const destroyed = snapshot.agents[input.agentId];
      if (!destroyed) {
        throw new FacadeError("AGENT_NOT_FOUND", `Agent ${input.agentId} was not found`);
      }
      return destroyed;
    });
  }

  async waitMessage(
    input: { turnId: string; waitMs?: number },
    actor: FacadeActor,
  ): Promise<WaitMessageResult> {
    this.assertOpen();
    const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), this.limits.maxWaitMs);
    const deadline = this.now() + waitMs;
    let turn = await this.getTurn({ turnId: input.turnId }, actor);
    while (true) {
      if (turn.resultMessageId) {
        const message = await this.getMessage({ messageId: turn.resultMessageId }, actor);
        return { status: "message", message, turn };
      }
      if (turn.pendingPermissionId) {
        const permission = await this.getPermission(turn.pendingPermissionId, actor);
        return { status: "action_required", turn, permission };
      }
      if (isTerminalTurn(turn)) {
        return { status: "terminal_without_message", turn };
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return { status: "timed_out", turn, retryAfterMs: Math.min(1_000, waitMs) };
      }
      const waited = await this.waitTurn(
        { turnId: turn.turnId, afterRevision: turn.revision, waitMs: remaining },
        actor,
      );
      turn = waited.turn;
    }
  }

  async events(input: EventsInput, actor: FacadeActor): Promise<EventsPage> {
    this.assertOpen();
    const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), this.limits.maxWaitMs);
    const deadline = this.now() + waitMs;
    while (true) {
      const current = await this.options.store.read((snapshot) => ({
        page: readEventsPage(snapshot, input, actor, this.limits.eventPageSize),
        revision: snapshot.revision,
      }));
      if (current.page.events.length > 0) {
        return current.page;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return current.page;
      }
      await this.options.store.waitForChange(current.revision, remaining);
    }
  }

  private async getPermission(permissionId: string, actor: FacadeActor): Promise<Permission> {
    return await this.options.store.read((snapshot) => {
      const permission = snapshot.permissions[permissionId];
      if (!permission) {
        throw new FacadeError("PERMISSION_NOT_FOUND", `Permission ${permissionId} was not found`);
      }
      requireVisibleAgent(snapshot, actor, permission.agentId);
      return permission;
    });
  }

  private async requestPermission(
    agentId: string,
    request: AcpPermissionRequest,
    signal: AbortSignal,
  ): Promise<AcpPermissionDecision | undefined> {
    if (signal.aborted || this.closed) {
      return { outcome: "cancel" };
    }
    const permission = await this.options.store.update((snapshot) => {
      const agent = snapshot.agents[agentId];
      const turn = agent?.activeTurnId ? snapshot.turns[agent.activeTurnId] : undefined;
      if (!agent || !turn || isTerminalTurn(turn)) {
        throw new FacadeError("TURN_TERMINAL", "Permission request has no active turn");
      }
      const requestedAt = this.timestamp();
      const permissionId = this.createId();
      const current: Permission = {
        permissionId,
        rootExecutionId: agent.rootExecutionId,
        agentId,
        turnId: turn.turnId,
        state: "pending",
        request,
        requestedAt,
        expiresAt: new Date(this.now() + this.limits.permissionTimeoutMs).toISOString(),
      };
      snapshot.permissions[permissionId] = current;
      turn.state = "waiting_permission";
      turn.pendingPermissionId = permissionId;
      turn.revision += 1;
      agent.state = "waiting_permission";
      agent.updatedAt = requestedAt;
      appendEvent(
        snapshot,
        {
          rootExecutionId: agent.rootExecutionId,
          type: "permission.requested",
          agentId,
          turnId: turn.turnId,
          data: { permissionId, inferredKind: request.inferredKind },
        },
        requestedAt,
      );
      return current;
    });

    return await new Promise<AcpPermissionDecision | undefined>((resolve) => {
      const onAbort = () => {
        void this.expirePermission(permission.permissionId, "cancelled");
      };
      const timeout = setTimeout(() => {
        void this.expirePermission(permission.permissionId, "expired");
      }, this.limits.permissionTimeoutMs);
      this.permissionWaiters.set(permission.permissionId, { resolve, timeout, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async expirePermission(
    permissionId: string,
    state: "expired" | "cancelled",
  ): Promise<void> {
    await this.options.store.update((snapshot) => {
      const permission = snapshot.permissions[permissionId];
      if (!permission || permission.state !== "pending") {
        return;
      }
      permission.state = state;
      permission.resolvedAt = this.timestamp();
      const turn = snapshot.turns[permission.turnId];
      if (turn && !isTerminalTurn(turn)) {
        turn.state = "running";
        delete turn.pendingPermissionId;
        turn.revision += 1;
      }
      const agent = snapshot.agents[permission.agentId];
      if (agent && agent.state === "waiting_permission") {
        agent.state = "running";
        agent.updatedAt = permission.resolvedAt;
      }
      appendEvent(
        snapshot,
        {
          rootExecutionId: permission.rootExecutionId,
          type: "permission.resolved",
          agentId: permission.agentId,
          turnId: permission.turnId,
          data: { permissionId, state },
        },
        permission.resolvedAt,
      );
    });
    this.resolvePermissionWaiter(permissionId, {
      outcome: state === "cancelled" ? "cancel" : "reject_once",
    });
  }

  private resolvePermissionWaiter(permissionId: string, decision: AcpPermissionDecision): void {
    const waiter = this.permissionWaiters.get(permissionId);
    if (!waiter) {
      return;
    }
    this.permissionWaiters.delete(permissionId);
    clearTimeout(waiter.timeout);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(decision);
  }

  private scheduleDrain(agentId: string): void {
    if (this.closed) {
      return;
    }
    if (this.drainingAgents.has(agentId)) {
      return;
    }
    this.drainingAgents.add(agentId);
    void this.drainAgent(agentId).finally(() => {
      this.drainingAgents.delete(agentId);
      void this.rescheduleAgentIfReady(agentId);
    });
  }

  private async rescheduleAgentIfReady(agentId: string): Promise<void> {
    const ready = await this.options.store.read((snapshot) => {
      const agent = snapshot.agents[agentId];
      const hasQueuedTurn = Object.values(snapshot.turns).some(
        (turn) => turn.agentId === agentId && turn.state === "queued",
      );
      return (
        agent !== undefined &&
        isAgentReadyForTurn(agent) &&
        hasQueuedTurn &&
        activeTurnCount(snapshot, agent.rootExecutionId) < this.limits.maxConcurrentTurns
      );
    });
    if (ready) {
      this.scheduleDrain(agentId);
    }
  }

  private async activateDormantAgent(agentId: string): Promise<void> {
    const existing = this.activatingAgents.get(agentId);
    if (existing) {
      await existing;
      return;
    }
    const activation = this.resumeDormantAgent(agentId);
    this.activatingAgents.set(agentId, activation);
    try {
      await activation;
    } finally {
      if (this.activatingAgents.get(agentId) === activation) {
        this.activatingAgents.delete(agentId);
      }
    }
  }

  private async resumeDormantAgent(agentId: string): Promise<void> {
    const agent = await this.options.store.read((snapshot) => snapshot.agents[agentId]);
    if (!agent || agent.state !== "dormant") {
      return;
    }
    try {
      const runtimeCwd = this.resolveStableAgentCwd(agent);
      const token = await this.options.identity.issue({
        rootExecutionId: agent.rootExecutionId,
        agentId: agent.agentId,
      });
      await this.options.runtime.ensureAgent(
        {
          agentId: agent.agentId,
          rootExecutionId: agent.rootExecutionId,
          sessionKey: `mcp-${agent.rootExecutionId}-${agent.agentId}`,
          agent: agent.agent,
          cwd: runtimeCwd,
          mode: agent.mode,
          mcpServers: this.options.mcpServersForToken(token),
          requireExistingSession: agent.mode === "persistent",
          ...(agent.sessionOptions ? { sessionOptions: agent.sessionOptions } : {}),
        },
        {
          onPermissionRequest: async (request, context) =>
            await this.requestPermission(agent.agentId, request, context.signal),
        },
      );
      const activated = await this.options.store.update((snapshot) => {
        const current = snapshot.agents[agentId];
        if (!current || current.state !== "dormant") {
          return false;
        }
        current.state = "idle";
        current.updatedAt = this.timestamp();
        appendEvent(
          snapshot,
          {
            rootExecutionId: current.rootExecutionId,
            type: "agent.state_changed",
            agentId,
            data: { state: current.state, resumed: true },
          },
          current.updatedAt,
        );
        return true;
      });
      if (!activated) {
        await this.options.runtime.destroyAgent(agentId, { discardSession: false });
        throw new FacadeError("AGENT_NOT_FOUND", `Agent ${agentId} is no longer dormant`, {
          details: { agentId },
        });
      }
      this.scheduleDrain(agentId);
    } catch (error) {
      await this.options.identity.revokeAgent(agentId);
      await this.failAgentCreation(agentId, error);
      if (error instanceof FacadeError && error.code === "AGENT_NOT_FOUND") {
        throw error;
      }
      throw new FacadeError("SESSION_RESUME_REQUIRED", `Could not resume ${agent.agent}`, {
        cause: error,
        details: { agentId },
      });
    }
  }

  private async ensurePersistentRuntimeForDiscard(agent: Agent): Promise<void> {
    const runtimeCwd = this.resolveStableAgentCwd(agent);
    const token = await this.options.identity.issue({
      rootExecutionId: agent.rootExecutionId,
      agentId: agent.agentId,
    });
    try {
      await this.options.runtime.ensureAgent(
        {
          agentId: agent.agentId,
          rootExecutionId: agent.rootExecutionId,
          sessionKey: `mcp-${agent.rootExecutionId}-${agent.agentId}`,
          agent: agent.agent,
          cwd: runtimeCwd,
          mode: agent.mode,
          mcpServers: this.options.mcpServersForToken(token),
          requireExistingSession: true,
          ...(agent.sessionOptions ? { sessionOptions: agent.sessionOptions } : {}),
        },
        {
          onPermissionRequest: async (request, context) =>
            await this.requestPermission(agent.agentId, request, context.signal),
        },
      );
    } catch (error) {
      await this.options.identity.revokeAgent(agent.agentId);
      throw error;
    }
  }

  private async drainAgent(agentId: string): Promise<void> {
    if (this.closed) {
      return;
    }
    while (true) {
      const work = await this.claimQueuedTurn(agentId);
      if (!work) {
        return;
      }
      await this.executeTurn(work.turn, work.message);
    }
  }

  private async claimQueuedTurn(
    agentId: string,
  ): Promise<{ turn: Turn; message: Message } | undefined> {
    return await this.options.store.update((snapshot) => {
      const agent = snapshot.agents[agentId];
      if (!agent || agent.activeTurnId || !isAgentReadyForTurn(agent)) {
        return undefined;
      }
      if (activeTurnCount(snapshot, agent.rootExecutionId) >= this.limits.maxConcurrentTurns) {
        return undefined;
      }
      const turn = Object.values(snapshot.turns)
        .filter((candidate) => candidate.agentId === agentId && candidate.state === "queued")
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!turn) {
        return undefined;
      }
      const message = snapshot.messages[turn.inputMessageId];
      if (!message) {
        throw new FacadeError("MESSAGE_NOT_FOUND", `Message ${turn.inputMessageId} was not found`);
      }
      const timestamp = this.timestamp();
      turn.state = "running";
      turn.revision += 1;
      turn.startedAt = timestamp;
      agent.state = "running";
      agent.activeTurnId = turn.turnId;
      agent.queueDepth = Math.max(0, agent.queueDepth - 1);
      agent.updatedAt = timestamp;
      appendEvent(
        snapshot,
        {
          rootExecutionId: turn.rootExecutionId,
          type: "turn.started",
          actorAgentId: turn.requestedByAgentId,
          agentId,
          turnId: turn.turnId,
          data: {},
        },
        timestamp,
      );
      return { turn, message };
    });
  }

  private async executeTurn(turn: Turn, message: Message): Promise<void> {
    let output = "";
    try {
      const runtimeTurn = this.options.runtime.startTurn({
        agentId: turn.agentId,
        text: message.content,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        requestId: turn.turnId,
        ...(turn.timeoutMs === undefined ? {} : { timeoutMs: turn.timeoutMs }),
      });
      this.activeRuntimeTurns.set(turn.turnId, runtimeTurn);
      const consumeEvents = async (): Promise<void> => {
        await forEachBatchedRuntimeEvent(runtimeTurn.events, async (event) => {
          if (event.type === "text_delta" && event.stream !== "thought") {
            output += event.text;
          }
          const mappedType = this.mapRuntimeEventType(event.type);
          if (mappedType) {
            await this.recordRuntimeEvent(turn, mappedType, event);
          }
        });
      };
      const [, result] = await Promise.all([consumeEvents(), runtimeTurn.result]);
      await this.completeTurn(turn.turnId, result, output);
    } catch (error) {
      await this.failTurn(turn.turnId, error);
    } finally {
      this.activeRuntimeTurns.delete(turn.turnId);
      await this.scheduleQueuedAgents(turn.rootExecutionId);
    }
  }

  private async scheduleQueuedAgents(rootExecutionId: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const agentIds = await this.options.store.read((snapshot) => {
      const queuedAgentIds = new Set(
        Object.values(snapshot.turns)
          .filter((turn) => turn.rootExecutionId === rootExecutionId && turn.state === "queued")
          .map((turn) => turn.agentId),
      );
      return Object.values(snapshot.agents)
        .filter((agent) => queuedAgentIds.has(agent.agentId))
        .map((agent) => agent.agentId);
    });
    for (const agentId of agentIds) {
      this.scheduleDrain(agentId);
    }
  }

  private mapRuntimeEventType(
    type: "text_delta" | "status" | "tool_call" | "done" | "error",
  ): FacadeEventType | undefined {
    if (type === "text_delta") {
      return "turn.text_delta";
    }
    if (type === "status") {
      return "turn.status";
    }
    if (type === "tool_call") {
      return "turn.tool_call";
    }
    return undefined;
  }

  private async recordRuntimeEvent(
    turn: Turn,
    type: FacadeEventType,
    data: unknown,
  ): Promise<void> {
    await this.options.store.update((snapshot) => {
      const current = snapshot.turns[turn.turnId];
      if (!current || isTerminalTurn(current)) {
        return;
      }
      current.revision += 1;
      appendEvent(
        snapshot,
        {
          rootExecutionId: turn.rootExecutionId,
          type,
          agentId: turn.agentId,
          turnId: turn.turnId,
          data,
        },
        this.timestamp(),
      );
    });
  }

  private async completeTurn(
    turnId: string,
    result: RuntimeTurnResult,
    output: string,
  ): Promise<void> {
    await this.options.store.update((snapshot) => {
      const turn = snapshot.turns[turnId];
      if (!turn || isTerminalTurn(turn)) {
        return;
      }
      const agent = snapshot.agents[turn.agentId];
      const timestamp = this.timestamp();
      turn.revision += 1;
      turn.completedAt = timestamp;
      applyRuntimeTurnResult({
        snapshot,
        turn,
        result,
        output,
        timestamp,
        createId: this.createId,
      });
      finalizeAgentAfterTurn(agent, turn, timestamp);
      appendEvent(
        snapshot,
        {
          rootExecutionId: turn.rootExecutionId,
          type: terminalEventType(turn),
          agentId: turn.agentId,
          turnId,
          data: { stopReason: turn.stopReason, error: turn.error },
        },
        timestamp,
      );
    });
  }

  private async failTurn(turnId: string, error: unknown): Promise<void> {
    await this.options.store.update((snapshot) => {
      const turn = snapshot.turns[turnId];
      if (!turn || isTerminalTurn(turn)) {
        return;
      }
      const timestamp = this.timestamp();
      turn.state = "failed";
      turn.error = normalizeFacadeError(error);
      turn.revision += 1;
      turn.completedAt = timestamp;
      const agent = snapshot.agents[turn.agentId];
      if (agent && agent.state !== "destroying" && agent.state !== "destroyed") {
        delete agent.activeTurnId;
        agent.state = "failed";
        agent.updatedAt = timestamp;
        agent.lastError = turn.error;
      }
      appendEvent(
        snapshot,
        {
          rootExecutionId: turn.rootExecutionId,
          type: "turn.failed",
          agentId: turn.agentId,
          turnId,
          data: { error: turn.error },
        },
        timestamp,
      );
    });
  }

  private async failAgentCreation(agentId: string, error: unknown): Promise<void> {
    await this.options.store.update((snapshot) => {
      const agent = snapshot.agents[agentId];
      if (!agent || (agent.state !== "creating" && agent.state !== "dormant")) {
        return;
      }
      agent.state = "failed";
      agent.updatedAt = this.timestamp();
      agent.lastError = normalizeFacadeError(error);
      appendEvent(
        snapshot,
        {
          rootExecutionId: agent.rootExecutionId,
          type: "agent.state_changed",
          agentId,
          data: { state: agent.state, error: agent.lastError },
        },
        agent.updatedAt,
      );
    });
  }

  private resolveCwd(value: string): string {
    let resolved: string;
    let roots: string[];
    try {
      resolved = canonicalizeWorkspacePath(value);
      roots = this.allowedCwdRoots.map((root) => {
        const current = canonicalizeWorkspacePath(root);
        if (current !== root) {
          throw new Error(`Workspace root changed after initialization: ${root}`);
        }
        return current;
      });
    } catch (error) {
      throw new FacadeError("UNAUTHORIZED", `Working directory cannot be resolved: ${value}`, {
        cause: error,
      });
    }
    const allowed = roots.some((root) => {
      const relative = path.relative(root, resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!allowed) {
      throw new FacadeError(
        "UNAUTHORIZED",
        `Working directory is outside allowed roots: ${resolved}`,
      );
    }
    return resolved;
  }

  private resolveStableAgentCwd(agent: Agent): string {
    const resolved = this.resolveCwd(agent.cwd);
    if (resolved !== agent.cwd) {
      throw new FacadeError(
        "SESSION_RESUME_REQUIRED",
        `Managed agent working directory changed: ${agent.cwd}`,
        { details: { agentId: agent.agentId, cwd: agent.cwd, resolvedCwd: resolved } },
      );
    }
    return resolved;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}
