import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeHandle,
} from "../runtime.js";
import { FacadeError } from "./facade/errors.js";
import type {
  AgentRuntimeAdapter,
  EnsureRuntimeAgentInput,
  RuntimeAgentHooks,
  RuntimeTurn,
  StartRuntimeTurnInput,
} from "./facade/types.js";

type RuntimeClient = Pick<AcpRuntime, "ensureSession" | "startTurn" | "close"> & {
  getStatus(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<{
    summary?: string;
    details?: Record<string, unknown>;
  }>;
};

type RuntimeEntry = {
  runtime: RuntimeClient;
  handle: AcpRuntimeHandle;
  input: EnsureRuntimeAgentInput;
  hooksRef: { current: RuntimeAgentHooks };
};

type PendingRuntimeEntry = {
  input: EnsureRuntimeAgentInput;
  hooksRef: { current: RuntimeAgentHooks };
  initialization: Promise<RuntimeEntry>;
};

type DestroyOperation = {
  discardSession: boolean;
  promise: Promise<void>;
};

type AcpxRuntimeAdapterOptions = {
  agents: string[];
  createRuntime: (input: {
    cwd: string;
    onPermissionRequest: (
      request: AcpPermissionRequest,
      context: { signal: AbortSignal },
    ) => Promise<AcpPermissionDecision | undefined>;
  }) => RuntimeClient;
  probeAgent?: (agent: string) => Promise<{ available: boolean; reason?: string }>;
};

export function createAcpxRuntimeAdapter(options: AcpxRuntimeAdapterOptions): AgentRuntimeAdapter {
  const knownAgents = [...options.agents];
  const entries = new Map<string, RuntimeEntry>();
  const pendingEntries = new Map<string, PendingRuntimeEntry>();
  const destroyOperations = new Map<string, DestroyOperation>();

  const validateStableInput = (
    current: EnsureRuntimeAgentInput,
    requested: EnsureRuntimeAgentInput,
  ): void => {
    if (current.agent !== requested.agent || current.cwd !== requested.cwd) {
      throw new FacadeError(
        "SESSION_RESUME_REQUIRED",
        "A managed agent cannot change its backend or working directory during resume",
      );
    }
  };

  return {
    listAgents(): string[] {
      return [...knownAgents];
    },

    async probeAgent(
      agent: string,
      probeOptions?: { live?: boolean },
    ): Promise<{ available: boolean; reason?: string }> {
      if (!knownAgents.includes(agent)) {
        return { available: false, reason: `Unknown local agent: ${agent}` };
      }
      if (!probeOptions?.live) {
        return { available: true };
      }
      return (await options.probeAgent?.(agent)) ?? { available: true };
    },

    async ensureAgent(input: EnsureRuntimeAgentInput, hooks: RuntimeAgentHooks): Promise<void> {
      if (destroyOperations.has(input.agentId)) {
        throw new FacadeError(
          "SESSION_RESUME_REQUIRED",
          `Managed agent ${input.agentId} is being destroyed`,
          { retryable: true },
        );
      }

      const pending = pendingEntries.get(input.agentId);
      if (pending) {
        validateStableInput(pending.input, input);
        pending.hooksRef.current = hooks;
        await pending.initialization;
        return;
      }

      let entry = entries.get(input.agentId);
      if (!entry) {
        const hooksRef: { current: RuntimeAgentHooks } = { current: hooks };
        const runtime = options.createRuntime({
          cwd: input.cwd,
          onPermissionRequest: async (request, context) =>
            await hooksRef.current.onPermissionRequest(request, context),
        });
        const initialization = (async (): Promise<RuntimeEntry> => {
          const handle = await runtime.ensureSession({
            sessionKey: input.sessionKey,
            agent: input.agent,
            cwd: input.cwd,
            mode: input.mode,
            requireExistingSession: input.requireExistingSession,
            mcpServers: input.mcpServers,
            sessionOptions: input.sessionOptions,
          });
          const initialized = { runtime, handle, input, hooksRef };
          entries.set(input.agentId, initialized);
          return initialized;
        })();
        const pendingEntry = { input, hooksRef, initialization };
        pendingEntries.set(input.agentId, pendingEntry);
        try {
          await initialization;
        } finally {
          if (pendingEntries.get(input.agentId) === pendingEntry) {
            pendingEntries.delete(input.agentId);
          }
        }
        return;
      }

      validateStableInput(entry.input, input);
      entry.hooksRef.current = hooks;
      entry.handle = await entry.runtime.ensureSession({
        sessionKey: input.sessionKey,
        agent: input.agent,
        cwd: input.cwd,
        mode: input.mode,
        requireExistingSession: input.requireExistingSession,
        mcpServers: input.mcpServers,
        sessionOptions: input.sessionOptions,
      });
      entry.input = input;
    },

    startTurn(input: StartRuntimeTurnInput): RuntimeTurn {
      const entry = entries.get(input.agentId);
      if (!entry) {
        throw new FacadeError(
          "SESSION_RESUME_REQUIRED",
          `Managed agent ${input.agentId} is not active`,
          { retryable: true },
        );
      }
      const turn = entry.runtime.startTurn({
        handle: entry.handle,
        text: input.text,
        attachments: input.attachments,
        mode: "prompt",
        requestId: input.requestId,
        timeoutMs: input.timeoutMs,
      });
      return {
        events: turn.events,
        result: turn.result,
        cancel: async (cancelInput) => await turn.cancel(cancelInput),
      };
    },

    async getStatus(agentId: string) {
      const entry = entries.get(agentId);
      if (!entry) {
        throw new FacadeError("SESSION_RESUME_REQUIRED", `Managed agent ${agentId} is not active`, {
          retryable: true,
        });
      }
      return await entry.runtime.getStatus({ handle: entry.handle });
    },

    async destroyAgent(agentId: string, destroyOptions): Promise<void> {
      const existing = destroyOperations.get(agentId);
      if (existing) {
        existing.discardSession ||= destroyOptions?.discardSession ?? false;
        await existing.promise;
        return;
      }

      const operation: DestroyOperation = {
        discardSession: destroyOptions?.discardSession ?? false,
        promise: Promise.resolve(),
      };
      operation.promise = (async (): Promise<void> => {
        const pending = pendingEntries.get(agentId);
        if (pending) {
          try {
            await pending.initialization;
          } catch {
            return;
          }
        }
        const entry = entries.get(agentId);
        if (!entry) {
          return;
        }
        while (true) {
          const discardPersistentState = operation.discardSession;
          await entry.runtime.close({
            handle: entry.handle,
            reason: "MCP facade agent destroyed",
            discardPersistentState,
          });
          if (!operation.discardSession || discardPersistentState) {
            break;
          }
        }
        if (entries.get(agentId) === entry) {
          entries.delete(agentId);
        }
      })();
      destroyOperations.set(agentId, operation);
      try {
        await operation.promise;
      } finally {
        if (destroyOperations.get(agentId) === operation) {
          destroyOperations.delete(agentId);
        }
      }
    },
  };
}
