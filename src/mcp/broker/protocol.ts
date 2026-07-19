import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BROKER_PROTOCOL_VERSION = 1;
export const BROKER_DESCRIPTOR_SCHEMA = "cs-agent-mcp.broker.v1";

export type BrokerDescriptor = {
  schema: typeof BROKER_DESCRIPTOR_SCHEMA;
  protocolVersion: number;
  packageVersion: string;
  pid: number;
  endpoint: string;
  credential: string;
  brokerEpoch: string;
  readyAt: string;
};

export type BrokerPaths = {
  directory: string;
  descriptorPath: string;
  lockPath: string;
};

export function brokerPaths(home = os.homedir()): BrokerPaths {
  const directory = path.join(home, ".cs-agent-mcp", "mcp");
  return {
    directory,
    descriptorPath: path.join(directory, "broker.json"),
    lockPath: path.join(directory, "broker.lock"),
  };
}

export function createBrokerCredential(): string {
  return randomBytes(32).toString("hex");
}

export function credentialsEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== 64 || expected.length !== 64) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackMcpEndpoint(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return [
      url.protocol === "http:",
      url.hostname === "127.0.0.1",
      Boolean(url.port),
      url.pathname === "/mcp",
      !url.username,
      !url.password,
      !url.search,
      !url.hash,
    ].every(Boolean);
  } catch {
    return false;
  }
}

function isPackageVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBrokerCredential(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isBrokerEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function parseBrokerDescriptor(value: unknown): BrokerDescriptor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const readyAt = typeof value.readyAt === "string" ? value.readyAt : "";
  const valid = [
    value.schema === BROKER_DESCRIPTOR_SCHEMA,
    Number.isInteger(value.protocolVersion),
    isPackageVersion(value.packageVersion),
    isPositiveInteger(value.pid),
    isLoopbackMcpEndpoint(value.endpoint),
    isBrokerCredential(value.credential),
    isBrokerEpoch(value.brokerEpoch),
    Boolean(readyAt),
    !Number.isNaN(Date.parse(readyAt)),
  ].every(Boolean);
  if (!valid) {
    return undefined;
  }
  return {
    schema: BROKER_DESCRIPTOR_SCHEMA,
    protocolVersion: value.protocolVersion as number,
    packageVersion: value.packageVersion as string,
    pid: value.pid as number,
    endpoint: value.endpoint as string,
    credential: value.credential as string,
    brokerEpoch: value.brokerEpoch as string,
    readyAt,
  };
}

export async function readBrokerDescriptor(
  descriptorPath: string,
): Promise<BrokerDescriptor | undefined> {
  try {
    const raw = await fs.readFile(descriptorPath, "utf8");
    return parseBrokerDescriptor(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export async function writeBrokerDescriptorAtomic(
  descriptorPath: string,
  descriptor: BrokerDescriptor,
): Promise<void> {
  const parsed = parseBrokerDescriptor(descriptor);
  if (!parsed) {
    throw new Error("Refusing to publish an invalid Broker descriptor");
  }
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
  const candidate = `${descriptorPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(candidate, `${JSON.stringify(parsed)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(candidate, descriptorPath);
    await fs.chmod(descriptorPath, 0o600);
  } finally {
    await fs.rm(candidate, { force: true });
  }
}
