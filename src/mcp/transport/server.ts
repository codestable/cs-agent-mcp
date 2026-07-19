import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAcpxVersion } from "../../version.js";
import { FacadeError, normalizeFacadeError } from "../facade/errors.js";
import type { MultiAgentFacade } from "../facade/facade.js";
import type { FacadeActor } from "../facade/types.js";

export type FacadeMcpContext = {
  facade: MultiAgentFacade;
  actor: FacadeActor;
  defaultCreateCwd?: string;
  requireExplicitCreateCwd?: boolean;
};

type FacadeMcpServerOptions =
  | FacadeMcpContext
  | { resolveContext: () => Promise<FacadeMcpContext> };

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function resolveContext(options: FacadeMcpServerOptions): Promise<FacadeMcpContext> {
  return "resolveContext" in options ? await options.resolveContext() : options;
}

async function runTool(
  options: FacadeMcpServerOptions,
  operation: (context: FacadeMcpContext) => Promise<Record<string, unknown>>,
) {
  try {
    return toolResult(await operation(await resolveContext(options)));
  } catch (error) {
    const normalized = normalizeFacadeError(error);
    return {
      ...toolResult({ error: normalized }),
      isError: true,
    };
  }
}

const attachmentSchema = z.object({
  mediaType: z
    .string()
    .min(1)
    .max(128)
    .describe("IANA media type for the base64-encoded attachment data."),
  data: z
    .string()
    .min(1)
    .max(20_000_000)
    .describe("Base64-encoded attachment bytes; do not pass a filesystem path."),
});

const sessionOptionsSchema = z.object({
  model: z
    .string()
    .min(1)
    .max(256)
    .describe("Agent-specific model id; omit to use the selected agent's default model.")
    .optional(),
  systemPrompt: z
    .union([
      z.string().max(100_000),
      z.object({
        append: z
          .string()
          .max(100_000)
          .describe("Text to append to the selected agent's default system prompt."),
      }),
    ])
    .describe("Replace the agent system prompt with a string, or append text with { append }.")
    .optional(),
  allowedTools: z
    .array(z.string().min(1).max(256))
    .max(512)
    .describe("Agent-specific allowlist of tools available inside the delegated session.")
    .optional(),
  maxTurns: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .describe(
      "Maximum agentic turns for one task, not the number of Facade Turns. " +
        "Tool-heavy tasks often need 8-12; omit this field to use the agent adapter default.",
    )
    .optional(),
});

const SERVER_INSTRUCTIONS = `Use cs-agent-mcp when a task benefits from managed delegation: independent parallelizable subtasks, heterogeneous agent runtimes, specialized roles, independent implementation and review, or long-running work that the caller should coordinate. Do not delegate trivial or tightly coupled work that the caller can complete directly.

For heterogeneous work, choose different configured agent names for complementary roles rather than assuming one runtime is universally best. Give each child a self-contained objective, scope, constraints, expected deliverable, and verification criteria. Agents can recursively delegate, but each caller can only see and control its own delegation subtree.

Recommended workflow: cs_agent_capabilities -> cs_agent_create -> send all independent turns -> cs_agent_wait_many for multi-turn fan-in -> cs_agent_destroy. Use cs_agent_wait_message for one turn. When wait-many returns because of permission or timeout, accumulate ready items by turnId and continue with pendingTurnIds. Use cs_agent_status, cs_agent_wait_turn, or cs_agent_events for progress and permission handling. Use cs_agent_cancel when work is obsolete, and cs_agent_destroy when the managed agent is no longer needed.`;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const LOCAL_MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function createFacadeMcpServer(options: FacadeMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "cs-agent-mcp", version: getAcpxVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "cs_agent_capabilities",
    {
      description:
        "Call first when considering delegation or heterogeneous execution. Lists configured local agent names, optional live availability probes, facade tools, and execution limits so you can decide whether and how to delegate.",
      inputSchema: z.object({
        probeAgents: z
          .array(z.string().min(1).max(128))
          .max(32)
          .describe(
            "Configured agent names to probe live before creating children; omit to list names without launching probes.",
          )
          .optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        capabilities: await facade.capabilities(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_create",
    {
      description:
        "Create a managed child agent for a self-contained subtask that benefits from parallel work, a different agent runtime, specialization, or independent review. Call cs_agent_capabilities before choosing an agent; do not delegate trivial or tightly coupled work.",
      inputSchema: z.object({
        agent: z
          .string()
          .min(1)
          .max(128)
          .describe("Configured local agent name returned by cs_agent_capabilities."),
        name: z
          .string()
          .min(1)
          .max(256)
          .describe("Human-readable role name, such as implementer, reviewer, or researcher.")
          .optional(),
        cwd: z
          .string()
          .min(1)
          .max(4_096)
          .describe(
            "Absolute workspace directory for the child; required when roots are ambiguous.",
          )
          .optional(),
        mode: z
          .enum(["persistent", "oneshot"])
          .describe(
            "persistent keeps a resumable session for follow-up tasks; oneshot creates a disposable task session.",
          )
          .optional(),
        sessionOptions: sessionOptionsSchema
          .describe("Optional model, prompt, tool, and turn limits for this delegated session.")
          .optional(),
      }),
      annotations: LOCAL_MUTATION_ANNOTATIONS,
    },
    async (input, extra) =>
      await runTool(options, async (context) => {
        const cwd = input.cwd ?? context.defaultCreateCwd;
        if (!cwd && context.requireExplicitCreateCwd) {
          throw new FacadeError(
            "WORKSPACE_ROOT_AMBIGUOUS",
            "Multiple MCP workspace roots are available; cs_agent_create requires cwd",
          );
        }
        return {
          agent: await context.facade.createAgent(cwd ? { ...input, cwd } : input, context.actor, {
            toolName: "cs_agent_create",
            requestId: String(extra.requestId),
          }),
        };
      }),
  );

  server.registerTool(
    "cs_agent_list",
    {
      description:
        "Inspect managed agents in the caller's delegation subtree before creating duplicates or when coordinating parallel work. Supports filtering and cursor pagination; it cannot reveal sibling or ancestor subtrees.",
      inputSchema: z.object({
        parentAgentId: z
          .string()
          .uuid()
          .describe("Only return direct children of this visible parent agent id.")
          .optional(),
        agent: z
          .string()
          .min(1)
          .max(128)
          .describe("Only return children using this configured agent name.")
          .optional(),
        state: z
          .enum([
            "creating",
            "idle",
            "running",
            "waiting_permission",
            "dormant",
            "failed",
            "destroying",
            "destroyed",
          ])
          .describe("Only return agents in this lifecycle state.")
          .optional(),
        cursor: z
          .string()
          .max(128)
          .describe("Opaque pagination cursor returned by a previous cs_agent_list call.")
          .optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(1_000)
          .describe("Maximum agents to return in this page, up to 1000.")
          .optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        result: await facade.listAgents(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_status",
    {
      description:
        "Inspect one managed agent's lifecycle, queue, pending permission, last error, and runtime state. Use it to diagnose a delegated task before deciding to wait, respond to permission, cancel, or retry.",
      inputSchema: z.object({
        agentId: z.string().uuid().describe("Visible managed agent id returned by create or list."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        status: await facade.status(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_events",
    {
      description:
        "Read or briefly wait for structured delegation events after an opaque cursor. Use for progress monitoring across agents or turns when a reply-oriented cs_agent_wait_message call is not sufficient.",
      inputSchema: z.object({
        afterCursor: z
          .string()
          .max(128)
          .describe(
            "Return only events after this opaque cursor; use 0 for the visible history start.",
          )
          .optional(),
        agentId: z
          .string()
          .uuid()
          .describe("Only return events for this visible agent.")
          .optional(),
        turnId: z.string().uuid().describe("Only return events for this visible turn.").optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(1_000)
          .describe("Maximum events to return, up to 1000.")
          .optional(),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(30_000)
          .describe("Long-poll for new events for at most this many milliseconds, up to 30000.")
          .optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        page: await facade.events(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_send",
    {
      description:
        "Assign a self-contained task to a managed descendant agent. Include the objective, scope, constraints, expected deliverable, and verification criteria; the idempotency key makes retries safe. For parallel work, send all independent turns before waiting with cs_agent_wait_many.",
      inputSchema: z.object({
        agentId: z.string().uuid().describe("Target managed descendant agent id."),
        content: z
          .string()
          .min(1)
          .max(1_000_000)
          .describe(
            "Complete delegated task brief with objective, boundaries, deliverable, and checks.",
          ),
        attachments: z
          .array(attachmentSchema)
          .max(32)
          .describe("Optional inline attachments needed to complete the task, up to 32.")
          .optional(),
        idempotencyKey: z
          .string()
          .min(1)
          .max(256)
          .describe(
            "Caller-generated stable key; reuse it when retrying the same logical message.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(86_400_000)
          .describe(
            "Reserved submission-timeout hint kept for compatibility; it never limits task completion.",
          )
          .optional(),
      }),
      annotations: {
        ...LOCAL_MUTATION_ANNOTATIONS,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      await runTool(options, async ({ facade, actor }) => ({
        receipt: await facade.send(input, actor, {
          toolName: "cs_agent_send",
          requestId: String(extra.requestId),
        }),
      })),
  );

  server.registerTool(
    "cs_agent_get_message",
    {
      description:
        "Read one immutable delegated request or reply message when you already have its id. Use cs_agent_wait_message instead when waiting for an unfinished task.",
      inputSchema: z.object({
        messageId: z.string().uuid().describe("Message id returned by send, wait, or an event."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        message: await facade.getMessage(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_wait_message",
    {
      description:
        "Preferred blocking wait after cs_agent_send for one turn. For multiple turns, send all independent turns first and use cs_agent_wait_many. Returns a terminal reply, a permission request requiring cs_agent_respond_permission, a terminal turn without a reply, or a bounded timeout.",
      inputSchema: z
        .object({
          turnId: z.string().uuid().describe("Turn id returned by cs_agent_send.").optional(),
          messageId: z
            .string()
            .uuid()
            .describe("Request message id returned by cs_agent_send; resolved to its turn.")
            .optional(),
          waitMs: z
            .number()
            .int()
            .nonnegative()
            .max(30_000)
            .describe(
              "Wait for at most this many milliseconds, up to 30000; call again after timeout.",
            )
            .optional(),
        })
        .refine((input) => Boolean(input.turnId || input.messageId), {
          message: "turnId or messageId is required",
        }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => {
        const turnId =
          input.turnId ??
          (await facade.getMessage({ messageId: input.messageId ?? "" }, actor)).turnId;
        return {
          result: await facade.waitMessage({ turnId, waitMs: input.waitMs }, actor),
        };
      }),
  );

  server.registerTool(
    "cs_agent_wait_many",
    {
      description:
        "Wait for multiple turns after you send all independent turns first. Mode any returns all currently ready items; mode all waits until every turn is terminal but returns early for permissions or timeout. Accumulate ready items by turnId and continue with pendingTurnIds after an interrupted all wait.",
      inputSchema: z.object({
        turnIds: z
          .array(z.string().uuid())
          .min(1)
          .max(64)
          .describe("Turn ids returned by cs_agent_send, from 1 to 64 entries."),
        mode: z
          .enum(["any", "all"])
          .default("any")
          .describe(
            "any returns when at least one turn is ready; all waits for all terminal turns.",
          ),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(30_000)
          .describe(
            "Wait for at most this many milliseconds, up to 30000; timeout does not cancel turns.",
          )
          .optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        result: await facade.waitMany(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_get_turn",
    {
      description:
        "Read one immutable-point-in-time turn snapshot by id. Use it for detailed state, revision, error, and permission diagnostics without waiting.",
      inputSchema: z.object({
        turnId: z.string().uuid().describe("Turn id returned by send, wait, or an event."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        turn: await facade.getTurn(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_wait_turn",
    {
      description:
        "Wait for a turn revision, permission request, or terminal state. Use this instead of cs_agent_wait_message when state transitions matter more than reply content.",
      inputSchema: z.object({
        turnId: z.string().uuid().describe("Turn id to observe."),
        afterRevision: z
          .number()
          .int()
          .nonnegative()
          .describe("Only return as changed after this previously observed revision.")
          .optional(),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(30_000)
          .describe("Wait for at most this many milliseconds, up to 30000.")
          .optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        result: await facade.waitTurn(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_respond_permission",
    {
      description:
        "Resolve a pending permission request surfaced by wait or status. Apply least privilege: prefer one-time approval unless repeated access is explicitly intended; rejection or cancel can stop delegated work.",
      inputSchema: z.object({
        permissionId: z
          .string()
          .uuid()
          .describe("Pending permission id returned by wait or status."),
        outcome: z
          .enum(["allow_once", "allow_always", "reject_once", "reject_always", "cancel"])
          .describe(
            "Permission decision; persistent allow/reject outcomes affect later matching requests.",
          ),
      }),
      annotations: {
        ...LOCAL_MUTATION_ANNOTATIONS,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      await runTool(options, async ({ facade, actor }) => ({
        permission: await facade.respondPermission(input, actor, {
          toolName: "cs_agent_respond_permission",
          requestId: String(extra.requestId),
        }),
      })),
  );

  server.registerTool(
    "cs_agent_cancel",
    {
      description:
        "Cancel obsolete, unsafe, or no-longer-needed queued or active work, including unfinished descendant turns. This is a destructive control action; inspect status first when the outcome is uncertain.",
      inputSchema: z.object({
        turnId: z.string().uuid().describe("Queued or active turn id to cancel."),
        reason: z
          .string()
          .max(4_096)
          .describe("Optional audit reason explaining why the delegated work is being cancelled.")
          .optional(),
      }),
      annotations: {
        ...LOCAL_MUTATION_ANNOTATIONS,
        destructiveHint: true,
      },
    },
    async (input, extra) =>
      await runTool(options, async ({ facade, actor }) => ({
        turn: await facade.cancel(input, actor, {
          toolName: "cs_agent_cancel",
          requestId: String(extra.requestId),
        }),
      })),
  );

  server.registerTool(
    "cs_agent_destroy",
    {
      description:
        "Destroy a managed agent after its work is complete or abandoned, optionally cascading through descendants and discarding its session. This releases the managed lifecycle and is destructive.",
      inputSchema: z.object({
        agentId: z.string().uuid().describe("Managed agent id to destroy."),
        cascade: z
          .boolean()
          .describe("Also destroy all live descendants; required when descendants still exist.")
          .optional(),
        discardSession: z
          .boolean()
          .describe("Also discard the persisted ACP session instead of keeping resumable state.")
          .optional(),
      }),
      annotations: {
        ...LOCAL_MUTATION_ANNOTATIONS,
        destructiveHint: true,
      },
    },
    async (input, extra) =>
      await runTool(options, async ({ facade, actor }) => ({
        agent: await facade.destroyAgent(input, actor, {
          toolName: "cs_agent_destroy",
          requestId: String(extra.requestId),
        }),
      })),
  );

  return server;
}
