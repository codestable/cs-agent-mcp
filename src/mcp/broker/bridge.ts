import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { BrokerDescriptor } from "./protocol.js";

const HEARTBEAT_INTERVAL_MS = 1_500;
const HEARTBEAT_FAILURE_LIMIT = 3;

function isInitializeResult(message: JSONRPCMessage): message is JSONRPCMessage & {
  result: { protocolVersion: string };
} {
  return (
    "result" in message &&
    typeof message.result === "object" &&
    message.result !== null &&
    "protocolVersion" in message.result &&
    typeof message.result.protocolVersion === "string"
  );
}

function isInitializeRequest(message: JSONRPCMessage): boolean {
  return "method" in message && message.method === "initialize" && "id" in message;
}

function heartbeatUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  url.pathname = "/lease";
  return url;
}

export async function runBrokerTransportBridge(input: {
  cwd: string;
  descriptor: BrokerDescriptor;
}): Promise<void> {
  const stdio = new StdioServerTransport();
  const broker = new StreamableHTTPClientTransport(new URL(input.descriptor.endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${input.descriptor.credential}`,
        "x-cs-agent-mcp-cwd": Buffer.from(input.cwd, "utf8").toString("base64url"),
      },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 500,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 0,
    },
  });

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let fatalError: Error | undefined;
  let closing = false;
  let initializeSend: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let heartbeatFailures = 0;

  const fail = (error: unknown) => {
    if (closing) {
      return;
    }
    fatalError ??= error instanceof Error ? error : new Error(String(error));
    resolveClosed();
  };

  const sendHeartbeat = async (): Promise<void> => {
    if (!broker.sessionId || closing) {
      return;
    }
    const response = await fetch(heartbeatUrl(input.descriptor.endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.descriptor.credential}`,
        "mcp-session-id": broker.sessionId,
      },
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`Broker lease heartbeat failed with HTTP ${response.status}`);
    }
    heartbeatFailures = 0;
  };

  const ensureHeartbeat = () => {
    if (!broker.sessionId || heartbeat) {
      return;
    }
    heartbeat = setInterval(() => {
      void sendHeartbeat().catch((error: unknown) => {
        heartbeatFailures += 1;
        if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) {
          fail(error);
        }
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  };

  const forwardToBroker = async (message: JSONRPCMessage): Promise<void> => {
    if (isInitializeRequest(message)) {
      initializeSend = broker.send(message);
      await initializeSend;
    } else {
      await initializeSend;
      await broker.send(message);
    }
    ensureHeartbeat();
  };

  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  stdio.onmessage = (message) => {
    void forwardToBroker(message).catch(fail);
  };
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  broker.onmessage = (message) => {
    if (isInitializeResult(message)) {
      broker.setProtocolVersion(message.result.protocolVersion);
    }
    void stdio.send(message).catch(fail);
  };
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  stdio.onerror = fail;
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  broker.onerror = fail;
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  const beginClose = () => {
    closing = true;
    resolveClosed();
  };
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  stdio.onclose = beginClose;
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callback properties.
  broker.onclose = () => fail(new Error("Broker transport closed"));

  const onStdinClose = () => beginClose();
  process.stdin.once("end", onStdinClose);
  process.stdin.once("close", onStdinClose);
  if (process.stdin.readableEnded || process.stdin.destroyed) {
    beginClose();
  }

  try {
    await Promise.all([stdio.start(), broker.start()]);
    await closed;
  } finally {
    closing = true;
    process.stdin.off("end", onStdinClose);
    process.stdin.off("close", onStdinClose);
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    await broker.terminateSession().catch(() => undefined);
    await Promise.allSettled([broker.close(), stdio.close()]);
  }
  if (fatalError) {
    throw fatalError;
  }
}
