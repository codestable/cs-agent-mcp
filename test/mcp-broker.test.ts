import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerConnectionError, ensureLocalBroker } from "../src/mcp/broker/discovery.js";
import {
  BROKER_PROTOCOL_VERSION,
  brokerPaths,
  credentialsEqual,
  readBrokerDescriptor,
  writeBrokerDescriptorAtomic,
  type BrokerDescriptor,
} from "../src/mcp/broker/protocol.js";
import { WorkspaceRegistry, type RegistryScheduler } from "../src/mcp/broker/registry.js";
import {
  buildManagedIdentityMcpServers,
  readClaudeControlPlaneMcpAliases,
} from "../src/mcp/transport/claude-user-mcp.js";
import type { FacadeMcpContext } from "../src/mcp/transport/server.js";
import { closeWorkspaceFacadeResources } from "../src/mcp/transport/workspace-facade.js";
import type { RootWorkspace } from "../src/mcp/transport/workspace.js";

class FakeScheduler implements RegistryScheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    this.now += ms;
    const ready = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.now)
      .toSorted((left, right) => left[1].at - right[1].at);
    for (const [id, task] of ready) {
      this.tasks.delete(id);
      task.callback();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function workspace(...roots: string[]): RootWorkspace {
  return {
    stateKey: roots.toSorted().join("\0"),
    allowedCwdRoots: roots.toSorted(),
    rootCwd: roots.toSorted()[0] ?? "/workspace",
    ...(roots.length === 1
      ? { defaultCreateCwd: roots[0] }
      : { requireExplicitCreateCwd: true as const }),
  };
}

test("Claude user MCP parsing finds only direct and package-exec cs-agent-mcp aliases", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-claude-config-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".claude.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        direct: { command: "cs-agent-mcp" },
        absolute: { command: "/opt/homebrew/bin/cs-agent-mcp" },
        windows: { command: "C:\\Users\\example\\bin\\cs-agent-mcp.cmd" },
        windowsPowerShell: {
          command: "C:\\Users\\example\\AppData\\Roaming\\npm\\cs-agent-mcp.ps1",
        },
        npx: { command: "npx", args: ["-y", "cs-agent-mcp@latest"] },
        npxPackage: {
          command: "npx",
          args: ["--package", "cs-agent-mcp@latest", "cs-agent-mcp"],
        },
        npm: { command: "npm", args: ["exec", "--yes", "cs-agent-mcp@0.2.5"] },
        npmPackage: {
          command: "npm",
          args: ["--yes", "exec", "--package=cs-agent-mcp@0.2.5", "--", "cs-agent-mcp"],
        },
        npmLogLevel: {
          command: "npm",
          args: ["--loglevel", "warn", "exec", "cs-agent-mcp@latest"],
        },
        pnpm: { command: "pnpm", args: ["dlx", "cs-agent-mcp@next"] },
        pnpmFlag: {
          command: "pnpm",
          args: ["--silent=false", "dlx", "cs-agent-mcp@next"],
        },
        pnpmWorkspaceRoot: {
          command: "pnpm",
          args: ["-w", "dlx", "cs-agent-mcp@latest"],
        },
        pnpmShellMode: {
          command: "pnpm",
          args: ["dlx", "-c", "cs-agent-mcp@latest"],
        },
        pnpmDirectory: {
          command: "pnpm",
          args: ["-C", "/workspace", "dlx", "cs-agent-mcp@latest"],
        },
        pnpmLongDirectory: {
          command: "pnpm",
          args: ["--dir", "/workspace", "dlx", "cs-agent-mcp@latest"],
        },
        pnpmStoreDirectory: {
          command: "pnpm",
          args: ["--store-dir", "/tmp/pnpm-store", "dlx", "cs-agent-mcp@latest"],
        },
        unrelated: { command: "codebase-memory-mcp" },
        unrelatedPackage: {
          command: "npx",
          args: ["--package", "other-mcp", "other-mcp"],
        },
        npxArgumentOnly: {
          command: "npx",
          args: ["-y", "other-mcp", "cs-agent-mcp"],
        },
        npmArgumentOnly: {
          command: "npm",
          args: ["exec", "other-mcp", "--", "cs-agent-mcp"],
        },
        npmScriptNamedExec: {
          command: "npm",
          args: ["run", "exec", "--", "cs-agent-mcp"],
        },
        npmTagBeforeTarget: {
          command: "npm",
          args: ["exec", "--tag", "cs-agent-mcp", "other-mcp"],
        },
        npmUnknownOptionValue: {
          command: "npm",
          args: ["exec", "--future-option", "cs-agent-mcp", "other-mcp"],
        },
        pnpmArgumentOnly: {
          command: "pnpm",
          args: ["--store-dir", "/tmp/store", "dlx", "other-mcp", "--target", "cs-agent-mcp"],
        },
        pnpmScriptNamedDlx: {
          command: "pnpm",
          args: ["run", "dlx", "--", "cs-agent-mcp"],
        },
        http: { type: "http", url: "http://127.0.0.1:9999/mcp" },
        wrapper: { command: "sh", args: ["-c", "cs-agent-mcp"] },
        malformedArgs: { command: "npx", args: "cs-agent-mcp" },
      },
    }),
  );

  assert.deepEqual(await readClaudeControlPlaneMcpAliases(configPath), [
    "direct",
    "absolute",
    "windows",
    "windowsPowerShell",
    "npx",
    "npxPackage",
    "npm",
    "npmPackage",
    "npmLogLevel",
    "pnpm",
    "pnpmFlag",
    "pnpmWorkspaceRoot",
    "pnpmShellMode",
    "pnpmDirectory",
    "pnpmLongDirectory",
    "pnpmStoreDirectory",
  ]);
});

test("Claude user MCP parsing fails open for missing or malformed configuration", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-claude-invalid-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".claude.json");

  assert.deepEqual(await readClaudeControlPlaneMcpAliases(configPath), []);
  await fs.writeFile(configPath, "not-json\n");
  assert.deepEqual(await readClaudeControlPlaneMcpAliases(configPath), []);
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: [] }));
  assert.deepEqual(await readClaudeControlPlaneMcpAliases(configPath), []);
});

test("managed identity MCP aliases override conflicting names without removing other servers", () => {
  const servers = buildManagedIdentityMcpServers({
    configuredServers: [
      { name: "docs", command: "docs-mcp", args: [], env: [] },
      { name: "cs-agent", command: "cs-agent-mcp", args: [], env: [] },
    ],
    aliases: ["cs-agent", "custom-control", "cs-agent-mcp", "cs-agent"],
    includeClaudeAliases: true,
    url: "http://127.0.0.1:4567/mcp",
    token: "managed-token",
  });

  assert.equal(servers[0]?.name, "docs");
  assert.equal(servers[1]?.name, "cs-agent");
  assert.deepEqual(
    servers.slice(2).map((server) => server.name),
    ["cs-agent-mcp", "cs-agent", "custom-control"],
  );
  for (const server of servers.slice(2)) {
    assert.deepEqual(server, {
      type: "http",
      name: server.name,
      url: "http://127.0.0.1:4567/mcp",
      headers: [{ name: "Authorization", value: "Bearer managed-token" }],
    });
  }

  assert.deepEqual(
    buildManagedIdentityMcpServers({
      configuredServers: [],
      aliases: ["cs-agent"],
      includeClaudeAliases: false,
      url: "http://127.0.0.1:4567/mcp",
      token: "managed-token",
    }).map((server) => server.name),
    ["cs-agent-mcp"],
  );
});

test("broker descriptor is atomically published as a private machine-level record", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-broker-protocol-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const paths = brokerPaths(home);
  assert.equal(paths.descriptorPath, path.join(home, ".cs-agent-mcp", "mcp", "broker.json"));
  assert.equal(paths.lockPath, path.join(home, ".cs-agent-mcp", "mcp", "broker.lock"));

  const descriptor: BrokerDescriptor = {
    schema: "cs-agent-mcp.broker.v1",
    protocolVersion: BROKER_PROTOCOL_VERSION,
    packageVersion: "0.2.3",
    pid: process.pid,
    endpoint: "http://127.0.0.1:12345/mcp",
    credential: "a".repeat(64),
    brokerEpoch: "11111111-1111-4111-8111-111111111111",
    readyAt: "2026-07-19T00:00:00.000Z",
  };
  await writeBrokerDescriptorAtomic(paths.descriptorPath, descriptor);

  assert.deepEqual(await readBrokerDescriptor(paths.descriptorPath), descriptor);
  assert.equal((await fs.stat(paths.descriptorPath)).mode & 0o777, 0o600);
  const entries = await fs.readdir(path.dirname(paths.descriptorPath));
  assert.deepEqual(entries, ["broker.json"]);
});

test("broker descriptor parsing and credential comparison fail closed", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-broker-invalid-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const { descriptorPath } = brokerPaths(home);
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });

  await fs.writeFile(descriptorPath, "not-json\n", { mode: 0o600 });
  assert.equal(await readBrokerDescriptor(descriptorPath), undefined);
  await fs.writeFile(
    descriptorPath,
    JSON.stringify({
      schema: "cs-agent-mcp.broker.v1",
      protocolVersion: BROKER_PROTOCOL_VERSION,
      packageVersion: "0.2.3",
      pid: process.pid,
      endpoint: "http://0.0.0.0:12345/mcp",
      credential: "short",
      brokerEpoch: "not-a-uuid",
      readyAt: "never",
    }),
  );
  assert.equal(await readBrokerDescriptor(descriptorPath), undefined);

  assert.equal(credentialsEqual("b".repeat(64), "b".repeat(64)), true);
  assert.equal(credentialsEqual("b".repeat(64), "c".repeat(64)), false);
  assert.equal(credentialsEqual("short", "short"), false);
  assert.equal(credentialsEqual(undefined, "b".repeat(64)), false);
});

test("workspace registry merges initialization and preserves the owner through grace reconnect", async () => {
  const scheduler = new FakeScheduler();
  let starts = 0;
  let closes = 0;
  const contexts: FacadeMcpContext[] = [];
  const registry = new WorkspaceRegistry({
    graceMs: 100,
    scheduler,
    loadConfig: async () => ({ marker: "config" }) as never,
    startFacade: async () => {
      starts += 1;
      const context = { marker: `context-${starts}` } as unknown as FacadeMcpContext;
      contexts.push(context);
      return {
        context,
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  const root = workspace("/workspace");
  const [a, b] = await Promise.all([
    registry.acquire(root, "connection-a"),
    registry.acquire(root, "connection-b"),
  ]);
  assert.equal(starts, 1);
  assert.equal(a.context, contexts[0]);
  assert.equal(b.context, contexts[0]);
  assert.equal(registry.workspaceCount, 1);
  assert.equal(registry.activeLeaseCount, 2);

  await a.release();
  await scheduler.advance(200);
  assert.equal(closes, 0);
  await b.release();
  await scheduler.advance(50);
  const reconnected = await registry.acquire(root, "connection-c");
  assert.equal(starts, 1);
  assert.equal(reconnected.context, contexts[0]);
  assert.equal(closes, 0);

  await scheduler.advance(200);
  assert.equal(closes, 0);
  await reconnected.release();
  await scheduler.advance(100);
  assert.equal(closes, 1);
  assert.equal(registry.workspaceCount, 0);
});

test("workspace registry isolates keys and retries a failed initialization", async () => {
  const scheduler = new FakeScheduler();
  let attempts = 0;
  const registry = new WorkspaceRegistry({
    graceMs: 0,
    scheduler,
    loadConfig: async () => ({}) as never,
    startFacade: async (_options, root) => {
      attempts += 1;
      if (root.stateKey === "/retry" && attempts === 1) {
        throw new Error("bootstrap failed");
      }
      return {
        context: { stateKey: root.stateKey } as unknown as FacadeMcpContext,
        close: async () => undefined,
      };
    },
  });

  await assert.rejects(registry.acquire(workspace("/retry"), "failed"), /bootstrap failed/);
  const retried = await registry.acquire(workspace("/retry"), "retry");
  const other = await registry.acquire(workspace("/other"), "other");
  assert.notEqual(retried.context, other.context);
  assert.equal(registry.workspaceCount, 2);
  assert.equal(attempts, 3);
  await registry.close();
});

test("workspace registry close waits for and cleans up an in-flight initialization", async () => {
  let releaseStart: () => void = () => undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startEntered = false;
  let closes = 0;
  const registry = new WorkspaceRegistry({
    graceMs: 0,
    loadConfig: async () => ({}) as never,
    startFacade: async () => {
      startEntered = true;
      await startGate;
      return {
        context: {} as FacadeMcpContext,
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  const acquiring = registry.acquire(workspace("/slow"), "connection");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(startEntered, true);

  let closeSettled = false;
  const closing = registry.close().finally(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, "close must retain Broker ownership during initialization");

  releaseStart();
  await closing;
  await assert.rejects(acquiring, /closed during initialization/);
  assert.equal(closes, 1);
  assert.equal(registry.workspaceCount, 0);
  assert.equal(registry.activeLeaseCount, 0);
});

test("an unresolved root initialization pauses an existing Workspace grace timer", async () => {
  const scheduler = new FakeScheduler();
  let closes = 0;
  const registry = new WorkspaceRegistry({
    graceMs: 100,
    scheduler,
    loadConfig: async () => ({}) as never,
    startFacade: async () => ({
      context: {} as FacadeMcpContext,
      close: async () => {
        closes += 1;
      },
    }),
  });
  const root = workspace("/grace");
  const lease = await registry.acquire(root, "first");
  await lease.release();
  await scheduler.advance(50);

  const hold = registry.holdInitialization("reconnecting");
  await scheduler.advance(500);
  assert.equal(closes, 0);
  hold.release();
  await scheduler.advance(99);
  assert.equal(closes, 0);
  await scheduler.advance(1);
  assert.equal(closes, 1);
});

test("broker discovery reports a detached spawn error immediately", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-mcp-broker-spawn-error-"));
  t.after(async () => await fs.rm(home, { recursive: true, force: true }));

  await assert.rejects(
    ensureLocalBroker({
      home,
      startBroker: async () => {
        throw new Error("spawn EACCES");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrokerConnectionError);
      assert.equal(error.code, "BROKER_START_FAILED");
      assert.match(error.message, /spawn EACCES/);
      return true;
    },
  );
});

test("Workspace resources stop HTTP before Facade shutdown and release the lock last", async () => {
  const calls: string[] = [];
  await closeWorkspaceFacadeResources({
    httpServer: {
      stopAccepting: () => calls.push("http-stop"),
      close: async () => {
        calls.push("http-close");
      },
    },
    facade: {
      shutdown: async () => {
        calls.push("facade-shutdown");
      },
    },
    processLock: {
      release: async () => {
        calls.push("lock-release");
      },
    },
  });
  assert.deepEqual(calls, ["http-stop", "http-close", "facade-shutdown", "lock-release"]);

  calls.length = 0;
  await assert.rejects(
    closeWorkspaceFacadeResources({
      httpServer: {
        stopAccepting: () => calls.push("http-stop"),
        close: async () => {
          calls.push("http-close");
        },
      },
      facade: {
        shutdown: async () => {
          calls.push("facade-shutdown");
          throw new Error("shutdown failed");
        },
      },
      processLock: {
        release: async () => {
          calls.push("lock-release");
        },
      },
    }),
    /Workspace facade resources failed to close/,
  );
  assert.deepEqual(calls, ["http-stop", "http-close", "facade-shutdown"]);
});
