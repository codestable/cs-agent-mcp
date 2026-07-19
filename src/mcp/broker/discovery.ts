import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  BROKER_PROTOCOL_VERSION,
  brokerPaths,
  readBrokerDescriptor,
  type BrokerDescriptor,
} from "./protocol.js";

type BrokerHealth = {
  schema: "cs-agent-mcp.broker-health.v1";
  protocolVersion: number;
  packageVersion: string;
  pid: number;
  brokerEpoch: string;
  activeLeaseCount: number;
  activeSessionCount: number;
  workspaceCount: number;
};

type EnsureLocalBrokerOptions = {
  home?: string;
  startBroker?: () => Promise<void>;
};

export class BrokerConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "BrokerConnectionError";
  }
}

function endpointUrl(descriptor: BrokerDescriptor, pathname: string): URL {
  const url = new URL(descriptor.endpoint);
  url.pathname = pathname;
  return url;
}

async function probeBroker(descriptor: BrokerDescriptor): Promise<BrokerHealth | undefined> {
  try {
    const response = await fetch(endpointUrl(descriptor, "/health"), {
      headers: { Authorization: `Bearer ${descriptor.credential}` },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const value = (await response.json()) as Partial<BrokerHealth>;
    const valid = [
      value.schema === "cs-agent-mcp.broker-health.v1",
      Number.isInteger(value.protocolVersion),
      typeof value.packageVersion === "string",
      value.pid === descriptor.pid,
      value.brokerEpoch === descriptor.brokerEpoch,
      Number.isInteger(value.activeLeaseCount),
      Number.isInteger(value.activeSessionCount),
      Number.isInteger(value.workspaceCount),
    ].every(Boolean);
    if (!valid) {
      return undefined;
    }
    return value as BrokerHealth;
  } catch {
    return undefined;
  }
}

async function requestInactiveBrokerShutdown(descriptor: BrokerDescriptor): Promise<void> {
  try {
    const response = await fetch(endpointUrl(descriptor, "/shutdown"), {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.credential}` },
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
  } catch {
    // The discovery loop determines whether the old owner actually stopped.
  }
}

function spawnBroker(): Promise<void> {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new BrokerConnectionError(
      "BROKER_START_FAILED",
      "Cannot locate the cs-agent-mcp executable for Broker startup",
    );
  }
  return new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [...process.execArgv, scriptPath, "--internal-broker"], {
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new BrokerConnectionError("BROKER_START_FAILED", "Could not start the Broker process", {
          cause: error,
        }),
      );
      return;
    }
    child.once("error", (error) => {
      reject(
        new BrokerConnectionError(
          "BROKER_START_FAILED",
          `Could not start the Broker process: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

type BrokerProbeResult =
  | { kind: "ready"; descriptor: BrokerDescriptor }
  | { kind: "wait"; shutdownRequestedForEpoch: string }
  | { kind: "spawn" };

async function inspectBroker(
  descriptor: BrokerDescriptor | undefined,
  shutdownRequestedForEpoch: string | undefined,
): Promise<BrokerProbeResult> {
  if (!descriptor) {
    return { kind: "spawn" };
  }
  const health = await probeBroker(descriptor);
  if (!health) {
    return { kind: "spawn" };
  }
  if (health.protocolVersion === BROKER_PROTOCOL_VERSION) {
    return { kind: "ready", descriptor };
  }
  if (health.activeLeaseCount > 0 || health.activeSessionCount > 0) {
    throw new BrokerConnectionError(
      "BROKER_PROTOCOL_VERSION_MISMATCH",
      `Broker protocol ${health.protocolVersion} is incompatible with ${BROKER_PROTOCOL_VERSION}; ` +
        `the active Broker pid ${health.pid} was left running`,
    );
  }
  if (shutdownRequestedForEpoch !== descriptor.brokerEpoch) {
    await requestInactiveBrokerShutdown(descriptor);
  }
  return { kind: "wait", shutdownRequestedForEpoch: descriptor.brokerEpoch };
}

async function startBrokerOrThrow(startBroker: () => Promise<void>): Promise<void> {
  try {
    await startBroker();
  } catch (error) {
    if (error instanceof BrokerConnectionError) {
      throw error;
    }
    throw new BrokerConnectionError(
      "BROKER_START_FAILED",
      `Could not start the Broker process: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function ensureLocalBroker(
  options: EnsureLocalBrokerOptions = {},
): Promise<BrokerDescriptor> {
  const { descriptorPath } = brokerPaths(options.home);
  const deadline = Date.now() + 8_000;
  const startBroker = options.startBroker ?? spawnBroker;
  let lastSpawnAt = 0;
  let shutdownRequestedForEpoch: string | undefined;

  while (Date.now() < deadline) {
    const descriptor = await readBrokerDescriptor(descriptorPath);
    const inspected = await inspectBroker(descriptor, shutdownRequestedForEpoch);
    if (inspected.kind === "ready") {
      return inspected.descriptor;
    }
    if (inspected.kind === "wait") {
      shutdownRequestedForEpoch = inspected.shutdownRequestedForEpoch;
      await delay(40);
      continue;
    }

    if (Date.now() - lastSpawnAt >= 250) {
      await startBrokerOrThrow(startBroker);
      lastSpawnAt = Date.now();
    }
    await delay(40);
  }

  throw new BrokerConnectionError(
    "BROKER_UNAVAILABLE",
    "Could not connect to a compatible cs-agent-mcp Broker within 8000ms",
  );
}
