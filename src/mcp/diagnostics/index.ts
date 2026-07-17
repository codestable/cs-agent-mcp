import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agent, FacadeErrorShape, FacadeSnapshot, Permission, Turn } from "../facade/types.js";
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
};

type AgentDiagnosticsOptions = {
  facadesDir?: string;
  probeLock?: (lockPath: string) => Promise<FacadeProcessLockProbe>;
};

type ReadableInstance = {
  instance: ObservedFacadeInstance;
  snapshot: FacadeSnapshot;
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
      const instanceId = entry.slice(0, -".json".length);
      const snapshotPath = path.join(facadesDir, entry);
      let snapshot: FacadeSnapshot;
      try {
        snapshot = parseDiagnosticSnapshot(await readJson(snapshotPath));
      } catch (error) {
        warnings.push({
          instanceId,
          snapshotPath,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const lockProbe = await probeLock(`${snapshotPath}.lock`);
      instances.push({
        instance: {
          instanceId,
          state: lockProbe.state,
          ...(lockProbe.state === "running" ? { pid: lockProbe.pid } : {}),
          ...(rootCwd(snapshot) ? { rootCwd: rootCwd(snapshot) } : {}),
          snapshotPath,
        },
        snapshot,
      });
    }
    return { instances, warnings };
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

  return {
    async listAgents(options = {}) {
      const { instances, warnings } = await readInstances();
      return { agents: listFromInstances(instances, Boolean(options.includeAll)), warnings };
    },

    async resolveAgent(selector: string) {
      const { instances, warnings } = await readInstances();
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
      if (matches.length === 0) {
        return {
          ok: false,
          code: "AGENT_NOT_FOUND",
          message: `No agent matches selector ${selector}`,
          candidates: [],
          warnings,
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          code: "AGENT_SELECTOR_AMBIGUOUS",
          message: `Agent selector ${selector} matched multiple agents`,
          candidates: matches,
          warnings,
        };
      }

      const match = matches[0];
      const readable = instances.find(
        (candidate) => candidate.instance.instanceId === match.instance.instanceId,
      );
      const agent = readable?.snapshot.agents[match.agentId];
      if (!readable || !agent) {
        return {
          ok: false,
          code: "AGENT_NOT_FOUND",
          message: `No agent matches selector ${selector}`,
          candidates: [],
          warnings,
        };
      }
      return {
        ok: true,
        agent: toAgentDetail(readable.instance, readable.snapshot, agent),
        warnings,
      };
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
