import type { AcpRuntimeSessionPolicy } from "../../runtime.js";
import { FacadeError } from "./errors.js";
import type {
  Agent,
  CreateAgentInput,
  FacadeActor,
  MutationAuditContext,
  SendReceipt,
  Turn,
  WaitMessageResult,
} from "./types.js";

/** A JSON Schema value accepted by the structured runner. */
export type StructuredOutputSchema = boolean | Record<string, unknown>;
export type StructuredRunIsolation = AcpRuntimeSessionPolicy;

export type StructuredRunInput<T> = {
  agent: string;
  cwd?: string;
  idempotencyKey: string;
  content: string;
  deadlineMs: number;
  outputSchema: StructuredOutputSchema;
  isolation?: StructuredRunIsolation;
  validate: (value: unknown) => T;
};

export type StructuredRunOperations = {
  createAgent(
    input: CreateAgentInput,
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Agent>;
  send(
    input: {
      agentId: string;
      content: string;
      idempotencyKey: string;
    },
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<SendReceipt>;
  waitMessage(
    input: { turnId: string; waitMs?: number },
    actor: FacadeActor,
  ): Promise<WaitMessageResult>;
  cancel(
    input: { turnId: string; reason?: string },
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Turn>;
  destroyAgent(
    input: { agentId: string; cascade?: boolean; discardSession?: boolean },
    actor: FacadeActor,
    audit?: MutationAuditContext,
  ): Promise<Agent>;
};

export type StructuredRunExecutionOptions = {
  operationId: string;
  actor: FacadeActor;
  operations: StructuredRunOperations;
  audit?: MutationAuditContext;
  now?: () => number;
  maxWaitMs?: number;
};

type RunContext = {
  operationId: string;
  actor: FacadeActor;
  operations: StructuredRunOperations;
  audit?: MutationAuditContext;
  now: () => number;
  maxWaitMs: number;
  deadline: number;
};

type TerminalWaitResult = Extract<
  WaitMessageResult,
  { status: "message" | "terminal_without_message" }
>;

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

const DEFAULT_WAIT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;

class StructuredDeadlineError extends Error {
  constructor() {
    super("Structured Agent run exceeded its deadline");
    this.name = "StructuredDeadlineError";
  }
}

function remainingMs(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now());
}

function withDeadline<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = remainingMs(deadline, now);
  if (remaining <= 0) {
    return Promise.reject(new StructuredDeadlineError());
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StructuredDeadlineError()), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function boundedCleanup<T>(
  operation: Promise<T>,
  deadline?: number,
  now: () => number = Date.now,
): Promise<T> {
  const budget =
    deadline === undefined
      ? CLEANUP_TIMEOUT_MS
      : Math.min(CLEANUP_TIMEOUT_MS, remainingMs(deadline, now));
  if (budget <= 0) {
    void operation.catch(() => undefined);
    throw new FacadeError("CLEANUP_TIMEOUT", "Structured Agent cleanup exceeded its deadline");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new FacadeError("CLEANUP_TIMEOUT", "Structured Agent cleanup timed out")),
      budget,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function captureAttempt<T>(operation: Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await operation };
  } catch (error) {
    return { ok: false, error };
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorText(error));
}

async function captureCleanup(
  operation: Promise<unknown>,
  deadline?: number,
  now: () => number = Date.now,
): Promise<Error | undefined> {
  const attempt = await captureAttempt(boundedCleanup(operation, deadline, now));
  return attempt.ok ? undefined : asError(attempt.error);
}

function parseStrictJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new FacadeError("STRUCTURED_OUTPUT_INVALID", "Agent returned empty structured output");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new FacadeError("STRUCTURED_OUTPUT_INVALID", "Agent output is not valid strict JSON", {
      cause: error,
    });
  }
}

function outputInstruction(schema: StructuredOutputSchema): string {
  return [
    "",
    "Return exactly one JSON value matching this JSON Schema.",
    "Do not use Markdown fences or add explanatory text.",
    JSON.stringify(schema),
  ].join("\n");
}

function errorFromTerminal(
  result: Extract<WaitMessageResult, { status: "terminal_without_message" }>,
): FacadeError {
  if (result.turn.error) {
    return new FacadeError(result.turn.error.code, result.turn.error.message, {
      retryable: result.turn.error.retryable,
      details: result.turn.error.details,
    });
  }
  return new FacadeError(
    result.turn.state === "cancelled" ? "CANCELLED" : "STRUCTURED_OUTPUT_EMPTY",
    result.turn.state === "cancelled"
      ? (result.turn.stopReason ?? "Structured Agent run was cancelled")
      : "Agent completed without a reply message",
  );
}

function assertJsonSerializable(value: unknown): void {
  try {
    if (JSON.stringify(value) === undefined) {
      throw new Error("JSON.stringify returned undefined");
    }
  } catch (error) {
    throw new FacadeError(
      "STRUCTURED_OUTPUT_INVALID",
      "Validated structured result is not JSON serializable",
      { cause: error },
    );
  }
}

function validateInput(input: StructuredRunInput<unknown>): void {
  if (!Number.isInteger(input.deadlineMs) || input.deadlineMs <= 0) {
    throw new FacadeError("INVALID_ARGUMENT", "deadlineMs must be a positive integer");
  }
  if (!input.idempotencyKey.trim()) {
    throw new FacadeError("IDEMPOTENCY_CONFLICT", "idempotencyKey must not be empty");
  }
  validateIsolation(input.isolation);
  try {
    if (JSON.stringify(input.outputSchema) === undefined) {
      throw new Error("JSON.stringify returned undefined");
    }
  } catch (error) {
    throw new FacadeError("INVALID_ARGUMENT", "outputSchema must be JSON serializable", {
      cause: error,
    });
  }
}

// oxlint-disable-next-line complexity -- strict validation intentionally rejects every unsupported policy shape
function validateIsolation(policy: StructuredRunIsolation | undefined): void {
  if (policy === undefined) {
    return;
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new FacadeError("INVALID_ARGUMENT", "isolation must be a JSON object");
  }
  const supported = new Set([
    "inheritMcpServers",
    "inheritEnvironment",
    "permissionMode",
    "nonInteractivePermissions",
    "permissionPolicy",
  ]);
  for (const key of Object.keys(policy)) {
    if (!supported.has(key)) {
      throw new FacadeError(
        "INVALID_ARGUMENT",
        `Unsupported isolation field: ${key}; filesystem/network isolation is unavailable`,
      );
    }
  }
  if (policy.inheritMcpServers !== undefined && typeof policy.inheritMcpServers !== "boolean") {
    throw new FacadeError("INVALID_ARGUMENT", "isolation.inheritMcpServers must be boolean");
  }
  if (policy.inheritEnvironment !== undefined && typeof policy.inheritEnvironment !== "boolean") {
    throw new FacadeError("INVALID_ARGUMENT", "isolation.inheritEnvironment must be boolean");
  }
  if (
    policy.permissionMode !== undefined &&
    !["approve-all", "approve-reads", "deny-all"].includes(policy.permissionMode)
  ) {
    throw new FacadeError("INVALID_ARGUMENT", "isolation.permissionMode is invalid");
  }
  if (
    policy.nonInteractivePermissions !== undefined &&
    !["deny", "fail"].includes(policy.nonInteractivePermissions)
  ) {
    throw new FacadeError("INVALID_ARGUMENT", "isolation.nonInteractivePermissions is invalid");
  }
  if (policy.permissionPolicy !== undefined) {
    const permissionPolicy = policy.permissionPolicy;
    if (
      typeof permissionPolicy !== "object" ||
      permissionPolicy === null ||
      Array.isArray(permissionPolicy)
    ) {
      throw new FacadeError("INVALID_ARGUMENT", "isolation.permissionPolicy must be an object");
    }
    for (const key of Object.keys(permissionPolicy)) {
      if (!["autoApprove", "autoDeny", "escalate", "defaultAction"].includes(key)) {
        throw new FacadeError("INVALID_ARGUMENT", `Unsupported permissionPolicy field: ${key}`);
      }
    }
    for (const key of ["autoApprove", "autoDeny", "escalate"] as const) {
      const rules = permissionPolicy[key];
      if (
        rules !== undefined &&
        (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string" || !rule.trim()))
      ) {
        throw new FacadeError(
          "INVALID_ARGUMENT",
          `isolation.permissionPolicy.${key} must be non-empty strings`,
        );
      }
    }
    if (
      permissionPolicy.defaultAction !== undefined &&
      !["approve", "deny", "escalate"].includes(permissionPolicy.defaultAction)
    ) {
      throw new FacadeError(
        "INVALID_ARGUMENT",
        "isolation.permissionPolicy.defaultAction is invalid",
      );
    }
  }
}

function createAgentInput(input: StructuredRunInput<unknown>): CreateAgentInput {
  return {
    agent: input.agent,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    mode: "oneshot",
    ...(input.isolation ? { runtimePolicy: input.isolation } : {}),
  };
}

function scheduleLateAgentCleanup(
  error: unknown,
  creation: Promise<Agent>,
  context: RunContext,
): void {
  if (!(error instanceof StructuredDeadlineError)) {
    return;
  }
  void creation
    .then(async (agent) => {
      await boundedCleanup(
        context.operations.destroyAgent(
          { agentId: agent.agentId, cascade: true },
          context.actor,
          context.audit,
        ),
        context.deadline,
        context.now,
      );
    })
    .catch(() => undefined);
}

async function createStructuredAgent(
  input: StructuredRunInput<unknown>,
  context: RunContext,
  deadline: number,
): Promise<Agent> {
  const creation = context.operations.createAgent(
    createAgentInput(input),
    context.actor,
    context.audit,
  );
  try {
    return await withDeadline(creation, deadline, context.now);
  } catch (error) {
    scheduleLateAgentCleanup(error, creation, context);
    throw error;
  }
}

async function sendStructuredTurn(
  input: StructuredRunInput<unknown>,
  agentId: string,
  context: RunContext,
  deadline: number,
): Promise<string> {
  const sending = Promise.resolve().then(
    async () =>
      await context.operations.send(
        {
          agentId,
          content: `${input.content}${outputInstruction(input.outputSchema)}`,
          // The Facade-level key owns retries. A failed attempt must not leave
          // a stale cs_agent_send receipt that points at a destroyed Agent.
          idempotencyKey: `structured:${context.operationId}`,
        },
        context.actor,
        context.audit,
      ),
  );
  try {
    return (await withDeadline(sending, deadline, context.now)).turnId;
  } catch (error) {
    if (error instanceof StructuredDeadlineError) {
      void sending
        .then(async (receipt) => {
          await captureCleanup(
            context.operations.cancel(
              { turnId: receipt.turnId, reason: "structured run deadline exceeded" },
              context.actor,
              context.audit,
            ),
            deadline,
            context.now,
          );
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

async function waitForTerminal(
  turnId: string,
  context: RunContext,
  deadline: number,
): Promise<TerminalWaitResult> {
  while (true) {
    const remaining = remainingMs(deadline, context.now);
    if (remaining <= 0) {
      throw new StructuredDeadlineError();
    }
    const result = await withDeadline(
      context.operations.waitMessage(
        { turnId, waitMs: Math.min(remaining, context.maxWaitMs) },
        context.actor,
      ),
      deadline,
      context.now,
    );
    if (result.status === "timed_out") {
      continue;
    }
    if (result.status === "action_required") {
      throw new FacadeError(
        "PERMISSION_REQUIRED",
        "Structured Agent requested a permission that cannot be answered atomically",
        { details: { permissionId: result.permission.permissionId, turnId } },
      );
    }
    return result;
  }
}

function validateTerminalResult<T>(result: TerminalWaitResult, validate: (value: unknown) => T): T {
  if (result.status === "terminal_without_message") {
    throw errorFromTerminal(result);
  }
  const parsed = parseStrictJson(result.message.content);
  let value: T;
  try {
    value = validate(parsed);
  } catch (error) {
    throw new FacadeError("STRUCTURED_SCHEMA_INVALID", "Agent JSON did not match outputSchema", {
      cause: error,
    });
  }
  assertJsonSerializable(value);
  return value;
}

function normalizePrimaryError(
  error: unknown,
  input: StructuredRunInput<unknown>,
  operationId: string,
): unknown {
  return error instanceof StructuredDeadlineError
    ? new FacadeError("TIMEOUT", "Structured Agent run exceeded its deadline", {
        retryable: true,
        details: { deadlineMs: input.deadlineMs, operationId },
      })
    : error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? "unknown cleanup error";
  } catch {
    return "unknown cleanup error";
  }
}

function withCleanupError(primary: unknown, cleanup: Error | undefined): unknown {
  if (cleanup === undefined || !(primary instanceof FacadeError)) {
    return primary;
  }
  const priorCleanup = primary.details?.cleanupError;
  const cleanupMessage = priorCleanup
    ? `${errorText(priorCleanup)}; ${errorText(cleanup)}`
    : errorText(cleanup);
  return new FacadeError(primary.code, primary.message, {
    retryable: primary.retryable,
    details: { ...primary.details, cleanupError: cleanupMessage },
    cause: primary,
  });
}

async function cancelStructuredTurn(
  turnId: string | undefined,
  terminal: boolean,
  primary: unknown,
  context: RunContext,
): Promise<Error | undefined> {
  if (!turnId || terminal) {
    return undefined;
  }
  return await captureCleanup(
    context.operations.cancel(
      {
        turnId,
        reason: primary instanceof Error ? primary.message : "structured run failed",
      },
      context.actor,
      context.audit,
    ),
    context.deadline,
    context.now,
  );
}

async function executeStructuredTurn<T>(
  input: StructuredRunInput<T>,
  agent: Agent,
  context: RunContext,
  deadline: number,
): Promise<T> {
  let turnId: string | undefined;
  let terminal = false;
  try {
    turnId = await sendStructuredTurn(input, agent.agentId, context, deadline);
    const result = await waitForTerminal(turnId, context, deadline);
    if (remainingMs(deadline, context.now) <= 0) {
      throw new StructuredDeadlineError();
    }
    terminal = true;
    return validateTerminalResult(result, input.validate);
  } catch (error) {
    const primary = normalizePrimaryError(error, input, context.operationId);
    const cleanup = await cancelStructuredTurn(turnId, terminal, primary, context);
    throw withCleanupError(primary, cleanup);
  }
}

function finishAttempt<T>(
  attempt: Attempt<T>,
  cleanup: Error | undefined,
  operationId: string,
  input: StructuredRunInput<unknown>,
  deadline: number,
  now: () => number,
): { operationId: string; result: T } {
  if (!attempt.ok) {
    throw withCleanupError(attempt.error, cleanup);
  }
  if (remainingMs(deadline, now) <= 0) {
    const timeout = normalizePrimaryError(new StructuredDeadlineError(), input, operationId);
    throw withCleanupError(timeout, cleanup);
  }
  if (cleanup !== undefined) {
    throw cleanup;
  }
  return { operationId, result: attempt.value };
}

/**
 * Execute one disposable Facade Agent and hide its create/send/wait/cancel/destroy lifecycle.
 * The caller owns idempotency and persistence; this function deliberately has no cache.
 */
export async function runStructuredOnce<T>(
  input: StructuredRunInput<T>,
  options: StructuredRunExecutionOptions,
): Promise<{ operationId: string; result: T }> {
  validateInput(input);
  const context: RunContext = {
    operationId: options.operationId,
    actor: options.actor,
    operations: options.operations,
    audit: options.audit,
    now: options.now ?? Date.now,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_WAIT_MS,
    deadline: 0,
  };
  const deadline = context.now() + input.deadlineMs;
  context.deadline = deadline;
  const creation = await captureAttempt(createStructuredAgent(input, context, deadline));
  if (!creation.ok) {
    throw normalizePrimaryError(creation.error, input, context.operationId);
  }
  const agent = creation.value;
  const attempt = await captureAttempt(executeStructuredTurn(input, agent, context, deadline));
  const cleanup = await captureCleanup(
    context.operations.destroyAgent(
      { agentId: agent.agentId, cascade: true },
      context.actor,
      context.audit,
    ),
    deadline,
    context.now,
  );
  return finishAttempt(attempt, cleanup, context.operationId, input, deadline, context.now);
}
