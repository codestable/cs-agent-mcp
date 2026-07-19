import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MultiAgentFacade } from "../facade/facade.js";
import type { FacadeIdentityIssuer } from "../facade/types.js";
import { createFacadeMcpServer } from "./server.js";

type FacadeHttpServerOptions = {
  facade: MultiAgentFacade;
  identity: FacadeIdentityIssuer;
};

type HttpSession = {
  actorAgentId: string;
  rootExecutionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FacadeHttpServer = {
  url: string;
  stopAccepting(): void;
  close(): Promise<void>;
};

function sendResponse(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify({ error: body })}\n`);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = value.slice("Bearer ".length).trim();
  return token || undefined;
}

function sessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function validateRequest(request: IncomingMessage): void {
  if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
    throw new HttpRequestError(404, "Not found");
  }
  const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
    throw new HttpRequestError(413, "Request body is too large");
  }
}

async function authenticateRequest(request: IncomingMessage, identity: FacadeIdentityIssuer) {
  const token = bearerToken(request);
  const actor = token ? await identity.authenticate(token) : undefined;
  if (!actor) {
    throw new HttpRequestError(401, "Unauthorized");
  }
  return actor;
}

async function handleExistingSession(input: {
  request: IncomingMessage;
  response: ServerResponse;
  actor: { agentId: string; rootExecutionId: string };
  session: HttpSession | undefined;
}): Promise<void> {
  if (!input.session) {
    throw new HttpRequestError(404, "MCP session was not found");
  }
  if (
    input.session.actorAgentId !== input.actor.agentId ||
    input.session.rootExecutionId !== input.actor.rootExecutionId
  ) {
    throw new HttpRequestError(403, "MCP session belongs to another actor");
  }
  await input.session.transport.handleRequest(input.request, input.response);
}

async function createHttpSession(input: {
  request: IncomingMessage;
  response: ServerResponse;
  actor: { agentId: string; rootExecutionId: string };
  facade: MultiAgentFacade;
  sessions: Map<string, HttpSession>;
}): Promise<void> {
  if (input.request.method !== "POST") {
    throw new HttpRequestError(400, "MCP session id is required");
  }
  let entry: HttpSession | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (initializedSessionId) => {
      if (entry) {
        input.sessions.set(initializedSessionId, entry);
      }
    },
    onsessionclosed: (closedSessionId) => {
      input.sessions.delete(closedSessionId);
    },
  });
  const mcpServer = createFacadeMcpServer({ facade: input.facade, actor: input.actor });
  entry = {
    actorAgentId: input.actor.agentId,
    rootExecutionId: input.actor.rootExecutionId,
    transport,
    server: mcpServer,
  };
  await mcpServer.connect(transport);
  try {
    await transport.handleRequest(input.request, input.response);
  } finally {
    if (!transport.sessionId) {
      await mcpServer.close();
    }
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve loopback MCP listener address"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startFacadeHttpServer(
  options: FacadeHttpServerOptions,
): Promise<FacadeHttpServer> {
  const sessions = new Map<string, HttpSession>();
  let stopping = false;
  let serverClose: Promise<void> | undefined;
  const nodeServer = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      if (stopping) {
        throw new HttpRequestError(503, "MCP facade is shutting down");
      }
      validateRequest(request);
      const actor = await authenticateRequest(request, options.identity);
      if (stopping) {
        throw new HttpRequestError(503, "MCP facade is shutting down");
      }
      const requestedSessionId = sessionId(request);
      if (requestedSessionId) {
        await handleExistingSession({
          request,
          response,
          actor,
          session: sessions.get(requestedSessionId),
        });
        return;
      }
      await createHttpSession({ request, response, actor, facade: options.facade, sessions });
    } catch (error) {
      const status = error instanceof HttpRequestError ? error.status : 500;
      const message = error instanceof HttpRequestError ? error.message : "MCP request failed";
      sendResponse(response, status, message);
    }
  };

  const port = await listen(nodeServer);
  const stopAccepting = () => {
    if (serverClose) {
      return;
    }
    stopping = true;
    serverClose = new Promise<void>((resolve, reject) => {
      nodeServer.close((error) => (error ? reject(error) : resolve()));
    });
  };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stopAccepting,
    async close(): Promise<void> {
      stopAccepting();
      const activeSessions = [...sessions.values()];
      sessions.clear();
      const sessionResults = await Promise.allSettled(
        activeSessions.map(async (session) => await session.server.close()),
      );
      nodeServer.closeAllConnections();
      const listenerResult = await Promise.allSettled([serverClose]);
      const failures = [...sessionResults, ...listenerResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result): unknown => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more managed MCP HTTP resources failed to close",
        );
      }
    },
  };
}
