import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadResolvedConfig } from "../../cli/config.js";
import { getAcpxVersion } from "../../version.js";
import { FacadeError } from "../facade/errors.js";
import { acquireFacadeProcessLock } from "../transport/process-lock.js";
import { createFacadeMcpServer } from "../transport/server.js";
import { resolveRootWorkspace } from "../transport/workspace.js";
import { canonicalizeWorkspacePath } from "../workspace-path.js";
import {
  BROKER_DESCRIPTOR_SCHEMA,
  BROKER_PROTOCOL_VERSION,
  brokerPaths,
  createBrokerCredential,
  credentialsEqual,
  readBrokerDescriptor,
  writeBrokerDescriptorAtomic,
  type BrokerDescriptor,
} from "./protocol.js";
import {
  WorkspaceRegistry,
  type WorkspaceInitializationHold,
  type WorkspaceLease,
} from "./registry.js";

const REVERSE_CHANNEL_TIMEOUT_MS = 5_000;
const WORKSPACE_GRACE_MS = 750;
const LEASE_TIMEOUT_MS = 6_000;
const BROKER_IDLE_MS = 1_000;
const INITIAL_IDLE_MS = 8_000;

type ReverseGate = {
  connected: boolean;
  ready: Promise<void>;
  disconnected: Promise<Error>;
  markConnected(): void;
  markDisconnected(error?: Error): void;
};

type RootSession = {
  connectionId: string;
  fallbackCwd: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  reverse: ReverseGate;
  expiryTimer?: NodeJS.Timeout;
  lease?: WorkspaceLease;
  sessionId?: string;
  initialization?: Promise<void>;
  initializationHold: WorkspaceInitializationHold;
  closing: boolean;
};

class BrokerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function reverseChannelError(message: string, cause?: unknown): FacadeError {
  return new FacadeError("BROKER_REVERSE_CHANNEL_UNAVAILABLE", message, {
    retryable: true,
    cause,
  });
}

function createReverseGate(): ReverseGate {
  let resolveReady: () => void = () => undefined;
  let resolveDisconnected: (error: Error) => void = () => undefined;
  const gate: ReverseGate = {
    connected: false,
    ready: new Promise<void>((resolve) => {
      resolveReady = resolve;
    }),
    disconnected: new Promise<Error>((resolve) => {
      resolveDisconnected = resolve;
    }),
    markConnected() {
      if (!gate.connected) {
        gate.connected = true;
        resolveReady();
      }
    },
    markDisconnected(error = reverseChannelError("Broker reverse SSE channel disconnected")) {
      gate.connected = false;
      resolveDisconnected(error);
    },
  };
  return gate;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(status === 204 ? undefined : `${JSON.stringify(value)}\n`);
}

function bearerCredential(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : undefined;
}

function requestSessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function requireFallbackCwd(request: IncomingMessage): string {
  const encoded = request.headers["x-cs-agent-mcp-cwd"];
  if (typeof encoded !== "string" || encoded.length > 16_384) {
    throw new BrokerHttpError(400, "Broker fallback cwd header is required");
  }
  try {
    return canonicalizeWorkspacePath(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    throw new BrokerHttpError(
      400,
      `Broker fallback cwd is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve Broker loopback address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function waitForReverseChannel(session: RootSession): Promise<void> {
  const timeout = delay(REVERSE_CHANNEL_TIMEOUT_MS).then(() => {
    throw reverseChannelError(
      `Broker reverse SSE channel was not ready within ${REVERSE_CHANNEL_TIMEOUT_MS}ms`,
    );
  });
  await Promise.race([
    session.reverse.ready,
    session.reverse.disconnected.then((error) => {
      throw error;
    }),
    timeout,
  ]);
  if (!session.reverse.connected) {
    throw reverseChannelError("Broker reverse SSE channel is unavailable");
  }
}

async function initializeRootSession(
  session: RootSession,
  registry: WorkspaceRegistry,
): Promise<void> {
  const workspace = session.mcpServer.server.getClientCapabilities()?.roots
    ? await (async () => {
        await waitForReverseChannel(session);
        return await Promise.race([
          resolveRootWorkspace(session.mcpServer.server, session.fallbackCwd),
          session.reverse.disconnected.then((error) => {
            throw error;
          }),
        ]);
      })()
    : await resolveRootWorkspace(session.mcpServer.server, session.fallbackCwd);
  session.lease = await registry.acquire(workspace, session.connectionId);
}

async function markReverseReadyAfterHeaders(
  response: ServerResponse,
  handling: Promise<void>,
  gate: ReverseGate,
): Promise<void> {
  let handlingError: unknown;
  let handlingSettled = false;
  const observedHandling = handling.then(
    () => {
      handlingSettled = true;
    },
    (error: unknown) => {
      handlingError = error;
      handlingSettled = true;
    },
  );
  await waitForResponseHeaders(response, () => handlingSettled);
  if (handlingError) {
    gate.markDisconnected(
      reverseChannelError("Broker reverse SSE channel request failed", handlingError),
    );
  } else if (response.headersSent && response.statusCode === 200 && !response.writableEnded) {
    gate.markConnected();
  } else {
    gate.markDisconnected(
      reverseChannelError(`Broker reverse SSE channel failed with HTTP ${response.statusCode}`),
    );
  }
  try {
    await observedHandling;
    if (handlingError) {
      throw handlingError;
    }
  } finally {
    gate.markDisconnected();
  }
}

async function waitForResponseHeaders(
  response: ServerResponse,
  handlingSettled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + REVERSE_CHANNEL_TIMEOUT_MS;
  while (!response.headersSent && !response.writableEnded && Date.now() < deadline) {
    if (handlingSettled()) {
      return;
    }
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

export async function runWorkspaceBroker(
  options: {
    home?: string;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const home = options.home ?? os.homedir();
  const paths = brokerPaths(home);
  const processLock = await acquireFacadeProcessLock(paths.lockPath);
  const credential = createBrokerCredential();
  const brokerEpoch = randomUUID();
  const sessions = new Map<string, RootSession>();
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let resolveStop: () => void = () => undefined;
  let rejectStop: (error: Error) => void = () => undefined;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });

  const requestStop = () => {
    if (!stopping) {
      stopping = true;
      resolveStop();
    }
  };
  const cancelIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  let registry: WorkspaceRegistry;
  const scheduleIdle = (delayMs = BROKER_IDLE_MS) => {
    cancelIdle();
    if (
      sessions.size > 0 ||
      registry.activeLeaseCount > 0 ||
      registry.pendingInitializationCount > 0 ||
      stopping
    ) {
      return;
    }
    const boundedDelay =
      registry.workspaceCount > 0
        ? Math.max(delayMs, WORKSPACE_GRACE_MS + BROKER_IDLE_MS)
        : delayMs;
    idleTimer = setTimeout(requestStop, boundedDelay);
    idleTimer.unref();
  };

  registry = new WorkspaceRegistry({
    graceMs: WORKSPACE_GRACE_MS,
    loadConfig: loadResolvedConfig,
    onEmpty: () => scheduleIdle(),
  });

  const closeSession = async (session: RootSession): Promise<void> => {
    if (session.closing) {
      return;
    }
    session.closing = true;
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
    }
    if (session.sessionId && sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
    session.reverse.markDisconnected();
    await session.initialization?.catch(() => undefined);
    session.initializationHold.release();
    await session.lease?.release();
    await session.mcpServer.close().catch(() => undefined);
    scheduleIdle();
  };

  const touchSession = (session: RootSession) => {
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
    }
    session.expiryTimer = setTimeout(() => {
      void closeSession(session);
    }, LEASE_TIMEOUT_MS);
  };

  const createSession = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method !== "POST") {
      throw new BrokerHttpError(400, "MCP session id is required");
    }
    cancelIdle();
    let resolveContext: (context: WorkspaceLease["context"]) => void = () => undefined;
    let rejectContext: (error: unknown) => void = () => undefined;
    const context = new Promise<WorkspaceLease["context"]>((resolve, reject) => {
      resolveContext = resolve;
      rejectContext = reject;
    });
    void context.catch(() => undefined);

    let session: RootSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.sessionId = sessionId;
        sessions.set(sessionId, session);
      },
      onsessionclosed: () => {
        void closeSession(session);
      },
    });
    const mcpServer = createFacadeMcpServer({ resolveContext: async () => await context });
    const connectionId = randomUUID();
    session = {
      connectionId,
      fallbackCwd: requireFallbackCwd(request),
      transport,
      mcpServer,
      reverse: createReverseGate(),
      initializationHold: registry.holdInitialization(connectionId),
      closing: false,
    };
    touchSession(session);
    mcpServer.server.oninitialized = () => {
      session.initialization ??= initializeRootSession(session, registry)
        .then(() => {
          const lease = session.lease;
          if (!lease) {
            throw new Error("Workspace initialization completed without a registry lease");
          }
          resolveContext(lease.context);
        })
        .catch((error: unknown) => rejectContext(error))
        .finally(() => session.initializationHold.release());
    };
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(request, response);
    } finally {
      if (!transport.sessionId) {
        await closeSession(session);
      }
    }
  };

  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const sessionId = requestSessionId(request);
    if (!sessionId) {
      await createSession(request, response);
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      throw new BrokerHttpError(404, "MCP session was not found");
    }
    touchSession(session);
    if (request.method === "GET") {
      response.once("close", () => session.reverse.markDisconnected());
      const handling = session.transport.handleRequest(request, response);
      await markReverseReadyAfterHeaders(response, handling, session.reverse);
      return;
    }
    await session.transport.handleRequest(request, response);
  };

  type BrokerRoute = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  const healthRoute: BrokerRoute = (_request, response) => {
    sendJson(response, 200, {
      schema: "cs-agent-mcp.broker-health.v1",
      protocolVersion: BROKER_PROTOCOL_VERSION,
      packageVersion: getAcpxVersion(),
      pid: process.pid,
      brokerEpoch,
      activeLeaseCount: registry.activeLeaseCount,
      activeSessionCount: sessions.size,
      workspaceCount: registry.workspaceCount,
    });
  };
  const shutdownRoute: BrokerRoute = (_request, response) => {
    if (sessions.size > 0 || registry.activeLeaseCount > 0) {
      throw new BrokerHttpError(409, "Broker has active root sessions");
    }
    sendJson(response, 202, { accepted: true });
    requestStop();
  };
  const leaseRoute: BrokerRoute = (request, response) => {
    const session = sessions.get(requestSessionId(request) ?? "");
    if (!session) {
      throw new BrokerHttpError(404, "MCP session was not found");
    }
    touchSession(session);
    sendJson(response, 204, undefined);
  };
  const routes = new Map<string, BrokerRoute>([
    ["GET /health", healthRoute],
    ["POST /shutdown", shutdownRoute],
    ["POST /lease", leaseRoute],
    ["GET /mcp", handleMcp],
    ["POST /mcp", handleMcp],
    ["DELETE /mcp", handleMcp],
  ]);

  const handleBrokerRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!credentialsEqual(bearerCredential(request), credential)) {
      throw new BrokerHttpError(401, "Unauthorized");
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const route = routes.get(`${request.method ?? ""} ${pathname}`);
    if (!route) {
      throw new BrokerHttpError(404, "Not found");
    }
    await route(request, response);
  };

  const nodeServer = http.createServer((request, response) => {
    void handleBrokerRequest(request, response).catch((error: unknown) => {
      const status = error instanceof BrokerHttpError ? error.status : 500;
      const message = error instanceof BrokerHttpError ? error.message : "Broker request failed";
      sendJson(response, status, { error: message });
    });
  });
  nodeServer.once("error", rejectStop);

  const onAbort = () => requestStop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let descriptor: BrokerDescriptor | undefined;
  try {
    const port = await listen(nodeServer);
    descriptor = {
      schema: BROKER_DESCRIPTOR_SCHEMA,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      packageVersion: getAcpxVersion(),
      pid: process.pid,
      endpoint: `http://127.0.0.1:${port}/mcp`,
      credential,
      brokerEpoch,
      readyAt: new Date().toISOString(),
    };
    await writeBrokerDescriptorAtomic(paths.descriptorPath, descriptor);
    scheduleIdle(INITIAL_IDLE_MS);
    await stopped;
  } finally {
    stopping = true;
    options.signal?.removeEventListener("abort", onAbort);
    cancelIdle();
    await Promise.allSettled([...sessions.values()].map(closeSession));
    await registry.close();
    await new Promise<void>((resolve) => {
      nodeServer.close(() => resolve());
      nodeServer.closeAllConnections();
    });
    const current = await readBrokerDescriptor(paths.descriptorPath);
    if (descriptor && current?.brokerEpoch === descriptor.brokerEpoch) {
      await fs.rm(paths.descriptorPath, { force: true });
    }
    await processLock.release();
  }
}
