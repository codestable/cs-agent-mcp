import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ResolvedAcpxConfig } from "../../cli/config.js";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "../../runtime.js";
import type { AcpRuntimeOptions } from "../../runtime.js";
import { FacadeError } from "../facade/errors.js";
import { MultiAgentFacade } from "../facade/facade.js";
import { createFacadeIdentityIssuer } from "../facade/identity.js";
import { createFileFacadeStore } from "../facade/store.js";
import { createAcpxRuntimeAdapter } from "../runtime-adapter.js";
import { canonicalizeWorkspacePath } from "../workspace-path.js";
import { startFacadeHttpServer } from "./http.js";
import { acquireFacadeProcessLock } from "./process-lock.js";
import { createFacadeMcpServer } from "./server.js";
import type { FacadeMcpContext } from "./server.js";

type RunMcpServerOptions = {
  cwd: string;
  config: ResolvedAcpxConfig;
};

type RootListingServer = {
  getClientCapabilities(): { roots?: object } | undefined;
  listRoots(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{ roots: Array<{ uri: string }> }>;
};

export type RootWorkspace = {
  stateKey: string;
  allowedCwdRoots: string[];
  rootCwd: string;
  defaultCreateCwd?: string;
  requireExplicitCreateCwd?: true;
};

type RunningFacade = {
  context: FacadeMcpContext;
  close(): Promise<void>;
};

const ROOTS_REQUEST_TIMEOUT_MS = 5_000;

function facadeFilePath(stateKey: string): string {
  const workspaceKey = createHash("sha256").update(stateKey).digest("hex").slice(0, 24);
  return path.join(os.homedir(), ".cs-agent-mcp", "mcp", "facades", `${workspaceKey}.json`);
}

function fallbackWorkspace(cwd: string): RootWorkspace {
  const canonicalCwd = canonicalizeWorkspacePath(cwd);
  return {
    stateKey: canonicalCwd,
    allowedCwdRoots: [canonicalCwd],
    rootCwd: canonicalCwd,
    defaultCreateCwd: canonicalCwd,
  };
}

function localRootPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      throw new FacadeError(
        "WORKSPACE_ROOT_INVALID",
        `MCP workspace root must use a file URI: ${uri}`,
      );
    }
    return canonicalizeWorkspacePath(fileURLToPath(url));
  } catch (error) {
    if (error instanceof FacadeError) {
      throw error;
    }
    throw new FacadeError("WORKSPACE_ROOT_INVALID", `Invalid MCP workspace root URI: ${uri}`, {
      cause: error,
    });
  }
}

export async function resolveRootWorkspace(
  server: RootListingServer,
  processCwd: string,
): Promise<RootWorkspace> {
  const cwd = path.resolve(processCwd);
  if (!server.getClientCapabilities()?.roots) {
    return fallbackWorkspace(cwd);
  }

  let result: Awaited<ReturnType<RootListingServer["listRoots"]>>;
  try {
    result = await server.listRoots(undefined, { timeout: ROOTS_REQUEST_TIMEOUT_MS });
  } catch (error) {
    throw new FacadeError("WORKSPACE_ROOT_INVALID", "MCP client returned invalid workspace roots", {
      cause: error,
    });
  }
  const roots = [...new Set(result.roots.map((root) => localRootPath(root.uri)))].toSorted();
  if (roots.length === 0) {
    throw new FacadeError(
      "WORKSPACE_ROOT_INVALID",
      "MCP client declared roots support but returned no workspace roots",
    );
  }
  if (roots.length === 1) {
    const root = roots[0] ?? cwd;
    return {
      stateKey: root,
      allowedCwdRoots: [root],
      rootCwd: root,
      defaultCreateCwd: root,
    };
  }
  return {
    stateKey: roots.join("\0"),
    allowedCwdRoots: roots,
    rootCwd: roots[0] ?? cwd,
    requireExplicitCreateCwd: true,
  };
}

async function startFacade(
  options: RunMcpServerOptions,
  workspace: RootWorkspace,
): Promise<RunningFacade> {
  const filePath = facadeFilePath(workspace.stateKey);
  const processLock = await acquireFacadeProcessLock(`${filePath}.lock`);
  let facade: MultiAgentFacade | undefined;
  let httpServer: Awaited<ReturnType<typeof startFacadeHttpServer>> | undefined;

  try {
    const stateDir = path.join(os.homedir(), ".cs-agent-mcp");
    const store = await createFileFacadeStore({ filePath });
    const existingRootExecutionId = await store.read(
      (snapshot) =>
        Object.values(snapshot.agents).find((agent) => agent.kind === "root")?.rootExecutionId,
    );
    const rootExecutionId = existingRootExecutionId ?? randomUUID();
    const identity = createFacadeIdentityIssuer({ store });
    const registry = createAgentRegistry({ overrides: options.config.agents });
    const sessionStore = createRuntimeStore({ stateDir });
    const createConfiguredRuntime = (
      agentCwd: string,
      overrides: Partial<Pick<AcpRuntimeOptions, "onPermissionRequest" | "probeAgent">> = {},
    ) =>
      createAcpRuntime({
        cwd: agentCwd,
        sessionStore,
        agentRegistry: registry,
        permissionMode: options.config.defaultPermissions,
        nonInteractivePermissions: options.config.nonInteractivePermissions,
        authCredentials: options.config.auth,
        authPolicy: options.config.authPolicy,
        timeoutMs: options.config.timeoutMs,
        isolateClaudeUserSettings: false,
        ...overrides,
      });
    const runtime = createAcpxRuntimeAdapter({
      agents: registry.list(),
      createRuntime: ({ cwd: agentCwd, onPermissionRequest }) =>
        createConfiguredRuntime(agentCwd, { onPermissionRequest }),
      probeAgent: async (agent) => {
        try {
          const report = await createConfiguredRuntime(workspace.rootCwd, {
            probeAgent: agent,
          }).doctor();
          return report.ok ? { available: true } : { available: false, reason: report.message };
        } catch (error) {
          return {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });

    let httpUrl = "";
    facade = new MultiAgentFacade({
      store,
      identity,
      runtime,
      rootExecutionId,
      allowedCwdRoots: workspace.allowedCwdRoots,
      mcpServersForToken: (token) => [
        ...options.config.mcpServers,
        {
          type: "http",
          name: "cs-agent-mcp",
          url: httpUrl,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
      ],
    });
    httpServer = await startFacadeHttpServer({ facade, identity });
    httpUrl = httpServer.url;
    await facade.recoverAfterRestart();
    const root = await facade.bootstrapRoot({
      agent: options.config.defaultAgent,
      cwd: workspace.rootCwd,
    });
    const context: FacadeMcpContext = {
      facade,
      actor: { rootExecutionId: root.rootExecutionId, agentId: root.agentId },
      ...(workspace.defaultCreateCwd ? { defaultCreateCwd: workspace.defaultCreateCwd } : {}),
      ...(workspace.requireExplicitCreateCwd ? { requireExplicitCreateCwd: true } : {}),
    };

    return {
      context,
      async close(): Promise<void> {
        try {
          await httpServer?.close();
        } finally {
          try {
            await facade?.shutdown();
          } finally {
            await processLock.release();
          }
        }
      },
    };
  } catch (error) {
    try {
      await httpServer?.close();
    } finally {
      try {
        await facade?.shutdown();
      } finally {
        await processLock.release();
      }
    }
    throw error;
  }
}

export async function runMcpServer(options: RunMcpServerOptions): Promise<void> {
  const processCwd = path.resolve(options.cwd);
  let resolveContext: (context: FacadeMcpContext) => void = () => undefined;
  let rejectContext: (error: unknown) => void = () => undefined;
  const contextPromise = new Promise<FacadeMcpContext>((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });
  void contextPromise.catch(() => undefined);

  const rootMcpServer = createFacadeMcpServer({ resolveContext: async () => await contextPromise });
  let running: RunningFacade | undefined;
  let initialization: Promise<void> | undefined;
  rootMcpServer.server.oninitialized = () => {
    initialization ??= (async () => {
      const workspace = await resolveRootWorkspace(rootMcpServer.server, processCwd);
      running = await startFacade(options, workspace);
      resolveContext(running.context);
    })().catch((error: unknown) => {
      rejectContext(error);
    });
  };

  const closed = new Promise<void>((resolve) => {
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Protocol exposes only this callback property.
    rootMcpServer.server.onclose = resolve;
  });
  const stdio = new StdioServerTransport();

  try {
    await rootMcpServer.connect(stdio);
    await closed;
  } finally {
    await initialization;
    try {
      await running?.close();
    } finally {
      await rootMcpServer.close();
    }
  }
}
