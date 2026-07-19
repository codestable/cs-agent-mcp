import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnResult,
  AcpRuntimeSessionMode,
  SessionAgentOptions,
} from "../../runtime.js";

export type AgentState =
  | "creating"
  | "idle"
  | "running"
  | "waiting_permission"
  | "dormant"
  | "failed"
  | "destroying"
  | "destroyed";

export type TurnState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled";

export type PermissionOutcome = AcpPermissionDecision["outcome"];
export type PermissionState = "pending" | "resolved" | "expired" | "cancelled";

export type FacadeErrorShape = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type FacadeActor = {
  rootExecutionId: string;
  agentId: string;
};

export type Agent = {
  agentId: string;
  rootExecutionId: string;
  kind: "root" | "managed";
  parentAgentId?: string;
  createdByTurnId?: string;
  agent: string;
  name?: string;
  cwd: string;
  mode: AcpRuntimeSessionMode;
  depth: number;
  state: AgentState;
  activeTurnId?: string;
  queueDepth: number;
  createdAt: string;
  updatedAt: string;
  lastError?: FacadeErrorShape;
  sessionOptions?: SessionAgentOptions;
};

export type Turn = {
  turnId: string;
  rootExecutionId: string;
  agentId: string;
  requestedByAgentId: string;
  parentTurnId?: string;
  inputMessageId: string;
  resultMessageId?: string;
  state: TurnState;
  revision: number;
  pendingPermissionId?: string;
  stopReason?: string;
  error?: FacadeErrorShape;
  timeoutMs?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type Message = {
  messageId: string;
  rootExecutionId: string;
  direction: "inbound" | "outbound";
  fromAgentId: string;
  toAgentId: string;
  turnId: string;
  inReplyTo?: string;
  content: string;
  attachments?: AcpRuntimeTurnAttachment[];
  createdAt: string;
};

export type FacadeEventType =
  | "audit.mutation"
  | "agent.created"
  | "agent.state_changed"
  | "message.accepted"
  | "message.completed"
  | "turn.queued"
  | "turn.started"
  | "turn.text_delta"
  | "turn.status"
  | "turn.tool_call"
  | "permission.requested"
  | "permission.resolved"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "agent.destroyed";

export type FacadeEvent = {
  cursor: string;
  rootExecutionId: string;
  type: FacadeEventType;
  actorAgentId?: string;
  agentId: string;
  turnId?: string;
  timestamp: string;
  data: unknown;
};

export type MutationAuditContext = {
  toolName: string;
  requestId: string;
};

export type Permission = {
  permissionId: string;
  rootExecutionId: string;
  agentId: string;
  turnId: string;
  state: PermissionState;
  request: AcpPermissionRequest;
  outcome?: PermissionOutcome;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedByAgentId?: string;
};

export type SendReceipt = {
  accepted: true;
  messageId: string;
  turnId: string;
  queuePosition: number;
};

export type IdempotencyReceipt = {
  fingerprint: string;
  receipt: SendReceipt;
};

export type IdentityRecord = {
  tokenHash: string;
  actor: FacadeActor;
  revoked: boolean;
  createdAt: string;
  expiresAt: string;
};

export type FacadeSnapshot = {
  schema: "cs-agent-mcp.facade.v1";
  revision: number;
  nextCursor: number;
  agents: Record<string, Agent>;
  turns: Record<string, Turn>;
  messages: Record<string, Message>;
  permissions: Record<string, Permission>;
  events: FacadeEvent[];
  idempotency: Record<string, IdempotencyReceipt>;
  identities: Record<string, IdentityRecord>;
};

export type FacadeStore = {
  read<T>(reader: (snapshot: FacadeSnapshot) => T): Promise<T>;
  update<T>(mutator: (snapshot: FacadeSnapshot) => T): Promise<T>;
  waitForChange(afterRevision: number, waitMs: number, signal?: AbortSignal): Promise<boolean>;
};

export type FacadeIdentityIssuer = {
  issue(actor: FacadeActor): Promise<string>;
  authenticate(token: string): Promise<FacadeActor | undefined>;
  revokeAgent(agentId: string): Promise<void>;
};

export type EnsureRuntimeAgentInput = {
  agentId: string;
  rootExecutionId: string;
  sessionKey: string;
  agent: string;
  cwd: string;
  mode: AcpRuntimeSessionMode;
  mcpServers: McpServer[];
  requireExistingSession?: boolean;
  sessionOptions?: SessionAgentOptions;
};

export type RuntimeAgentHooks = {
  onPermissionRequest: (
    request: AcpPermissionRequest,
    context: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision | undefined>;
};

export type StartRuntimeTurnInput = {
  agentId: string;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  requestId: string;
  timeoutMs?: number;
};

export type RuntimeTurn = {
  events: AsyncIterable<AcpRuntimeEvent>;
  result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
};

export type AgentRuntimeAdapter = {
  listAgents(): string[];
  probeAgent(
    agent: string,
    options?: { live?: boolean },
  ): Promise<{ available: boolean; reason?: string }>;
  ensureAgent(input: EnsureRuntimeAgentInput, hooks: RuntimeAgentHooks): Promise<void>;
  startTurn(input: StartRuntimeTurnInput): RuntimeTurn;
  getStatus(agentId: string): Promise<AcpRuntimeStatus>;
  destroyAgent(agentId: string, options?: { discardSession?: boolean }): Promise<void>;
  shutdown?(): Promise<void>;
};

export type CreateAgentInput = {
  agent: string;
  name?: string;
  cwd?: string;
  mode?: AcpRuntimeSessionMode;
  sessionOptions?: SessionAgentOptions;
};

export type SendInput = {
  agentId: string;
  content: string;
  attachments?: AcpRuntimeTurnAttachment[];
  idempotencyKey: string;
  timeoutMs?: number;
};

export type FacadeLimits = {
  maxDelegationDepth: number;
  maxManagedAgents: number;
  maxQueuedTurnsPerAgent: number;
  maxConcurrentTurns: number;
  maxWaitMs: number;
  permissionTimeoutMs: number;
  identityTtlMs: number;
  eventPageSize: number;
};

export type WaitMessageResult =
  | { status: "message"; message: Message; turn: Turn }
  | { status: "action_required"; turn: Turn; permission: Permission }
  | { status: "terminal_without_message"; turn: Turn }
  | { status: "timed_out"; turn: Turn; retryAfterMs: number };

export type WaitManyMode = "any" | "all";

export type WaitManyReadyItem =
  | { status: "message"; message: Message; turn: Turn }
  | { status: "action_required"; turn: Turn; permission: Permission }
  | { status: "terminal_without_message"; turn: Turn };

export type WaitManyResult = {
  mode: WaitManyMode;
  ready: WaitManyReadyItem[];
  pendingTurnIds: string[];
  timedOut: boolean;
  retryAfterMs?: number;
};

export type EventsPage = {
  events: FacadeEvent[];
  nextCursor: string;
  hasMore: boolean;
};
