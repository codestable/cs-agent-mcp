import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isClaudeAcpCommand } from "../../acp/agent-command.js";
import { splitCommandLine } from "../../acp/client-process.js";
import type { ResolvedAcpxConfig } from "../../cli/config.js";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "../../runtime.js";
import type { AcpRuntimeOptions } from "../../runtime.js";
import { MultiAgentFacade } from "../facade/facade.js";
import { createFacadeIdentityIssuer } from "../facade/identity.js";
import { createFileFacadeStore } from "../facade/store.js";
import { createAcpxRuntimeAdapter } from "../runtime-adapter.js";
import {
  buildManagedIdentityMcpServers,
  readClaudeControlPlaneMcpAliases,
} from "./claude-user-mcp.js";
import { startFacadeHttpServer } from "./http.js";
import type { FacadeHttpServer } from "./http.js";
import { acquireFacadeProcessLock, type FacadeProcessLock } from "./process-lock.js";
import type { FacadeMcpContext } from "./server.js";
import type { RootWorkspace } from "./workspace.js";

export type WorkspaceFacadeOptions = {
  config: ResolvedAcpxConfig;
};

export type RunningWorkspaceFacade = {
  context: FacadeMcpContext;
  close(): Promise<void>;
};

export function facadeFilePath(stateKey: string): string {
  const workspaceKey = createHash("sha256").update(stateKey).digest("hex").slice(0, 24);
  return path.join(os.homedir(), ".cs-agent-mcp", "mcp", "facades", `${workspaceKey}.json`);
}

export async function closeWorkspaceFacadeResources(input: {
  httpServer?: Pick<FacadeHttpServer, "stopAccepting" | "close">;
  facade?: Pick<MultiAgentFacade, "shutdown">;
  processLock: FacadeProcessLock;
}): Promise<void> {
  input.httpServer?.stopAccepting();
  const failures: unknown[] = [];
  try {
    await input.httpServer?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await input.facade?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more Workspace facade resources failed to close");
  }
  await input.processLock.release();
}

export async function startWorkspaceFacade(
  options: WorkspaceFacadeOptions,
  workspace: RootWorkspace,
): Promise<RunningWorkspaceFacade> {
  const filePath = facadeFilePath(workspace.stateKey);
  const processLock = await acquireFacadeProcessLock(`${filePath}.lock`);
  let facade: MultiAgentFacade | undefined;
  let httpServer: Awaited<ReturnType<typeof startFacadeHttpServer>> | undefined;

  const closeResources = async (): Promise<void> => {
    await closeWorkspaceFacadeResources({ httpServer, facade, processLock });
  };

  try {
    const stateDir = path.join(os.homedir(), ".cs-agent-mcp");
    const store = await createFileFacadeStore({ filePath });
    const existingRootExecutionId = await store.read(
      (snapshot) =>
        Object.values(snapshot.agents).find((agent) => agent.kind === "root")?.rootExecutionId,
    );
    const rootExecutionId = existingRootExecutionId ?? randomUUID();
    const identity = createFacadeIdentityIssuer({ store });
    const claudeControlPlaneAliases = await readClaudeControlPlaneMcpAliases();
    const registry = createAgentRegistry({ overrides: options.config.agents });
    const isClaudeManagedAgent = (agent: string): boolean => {
      const { command, args } = splitCommandLine(registry.resolve(agent));
      return isClaudeAcpCommand(command, args);
    };
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
      mcpServersForToken: (token, agent) =>
        buildManagedIdentityMcpServers({
          configuredServers: options.config.mcpServers,
          aliases: claudeControlPlaneAliases,
          includeClaudeAliases: isClaudeManagedAgent(agent),
          url: httpUrl,
          token,
        }),
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
        await closeResources();
      },
    };
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }
}
