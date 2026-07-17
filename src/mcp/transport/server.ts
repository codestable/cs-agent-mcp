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
  mediaType: z.string().min(1).max(128),
  data: z.string().min(1).max(20_000_000),
});

const sessionOptionsSchema = z.object({
  model: z.string().min(1).max(256).optional(),
  systemPrompt: z
    .union([z.string().max(100_000), z.object({ append: z.string().max(100_000) })])
    .optional(),
  allowedTools: z.array(z.string().min(1).max(256)).max(512).optional(),
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

export function createFacadeMcpServer(options: FacadeMcpServerOptions): McpServer {
  const server = new McpServer({ name: "cs-agent-mcp", version: getAcpxVersion() });

  server.registerTool(
    "cs_agent_capabilities",
    {
      description: "List supported local agents, facade tools, and execution limits.",
      inputSchema: z.object({
        probeAgents: z.array(z.string().min(1).max(128)).max(32).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        capabilities: await facade.capabilities(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_create",
    {
      description: "Create a managed child agent using a configured local agent name.",
      inputSchema: z.object({
        agent: z.string().min(1).max(128),
        name: z.string().min(1).max(256).optional(),
        cwd: z.string().min(1).max(4_096).optional(),
        mode: z.enum(["persistent", "oneshot"]).optional(),
        sessionOptions: sessionOptionsSchema.optional(),
      }),
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
      description: "List agents visible in the caller's delegation subtree.",
      inputSchema: z.object({
        parentAgentId: z.string().uuid().optional(),
        agent: z.string().min(1).max(128).optional(),
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
          .optional(),
        cursor: z.string().max(128).optional(),
        limit: z.number().int().positive().max(1_000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        result: await facade.listAgents(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_status",
    {
      description: "Get lifecycle, queue, permission, and runtime status for one agent.",
      inputSchema: z.object({ agentId: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        status: await facade.status(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_events",
    {
      description: "Read structured facade events after an opaque cursor.",
      inputSchema: z.object({
        afterCursor: z.string().max(128).optional(),
        agentId: z.string().uuid().optional(),
        turnId: z.string().uuid().optional(),
        limit: z.number().int().positive().max(1_000).optional(),
        waitMs: z.number().int().nonnegative().max(30_000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        page: await facade.events(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_send",
    {
      description: "Queue one idempotent message for a managed descendant agent.",
      inputSchema: z.object({
        agentId: z.string().uuid(),
        content: z.string().min(1).max(1_000_000),
        attachments: z.array(attachmentSchema).max(32).optional(),
        idempotencyKey: z.string().min(1).max(256),
        timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      }),
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
      description: "Get one immutable facade message by id.",
      inputSchema: z.object({ messageId: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        message: await facade.getMessage(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_wait_message",
    {
      description: "Wait for a terminal reply, permission request, or terminal turn state.",
      inputSchema: z
        .object({
          turnId: z.string().uuid().optional(),
          messageId: z.string().uuid().optional(),
          waitMs: z.number().int().nonnegative().max(30_000).optional(),
        })
        .refine((input) => Boolean(input.turnId || input.messageId), {
          message: "turnId or messageId is required",
        }),
      annotations: { readOnlyHint: true },
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
    "cs_agent_get_turn",
    {
      description: "Get one turn snapshot by id.",
      inputSchema: z.object({ turnId: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        turn: await facade.getTurn(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_wait_turn",
    {
      description: "Wait for a turn revision, permission request, or terminal state.",
      inputSchema: z.object({
        turnId: z.string().uuid(),
        afterRevision: z.number().int().nonnegative().optional(),
        waitMs: z.number().int().nonnegative().max(30_000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      await runTool(options, async ({ facade, actor }) => ({
        result: await facade.waitTurn(input, actor),
      })),
  );

  server.registerTool(
    "cs_agent_respond_permission",
    {
      description: "Resolve a pending permission request for a descendant agent.",
      inputSchema: z.object({
        permissionId: z.string().uuid(),
        outcome: z.enum(["allow_once", "allow_always", "reject_once", "reject_always", "cancel"]),
      }),
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
      description: "Cancel a queued or active turn and its unfinished descendant turns.",
      inputSchema: z.object({
        turnId: z.string().uuid(),
        reason: z.string().max(4_096).optional(),
      }),
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
      description: "Destroy a managed agent, optionally cascading through descendants.",
      inputSchema: z.object({
        agentId: z.string().uuid(),
        cascade: z.boolean().optional(),
        discardSession: z.boolean().optional(),
      }),
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
