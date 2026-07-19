import type { ResolvedAcpxConfig } from "../../cli/config.js";
import type { FacadeMcpContext } from "../transport/server.js";
import {
  startWorkspaceFacade,
  type RunningWorkspaceFacade,
  type WorkspaceFacadeOptions,
} from "../transport/workspace-facade.js";
import type { RootWorkspace } from "../transport/workspace.js";

export type RegistryScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type WorkspaceRegistryOptions = {
  graceMs: number;
  scheduler?: RegistryScheduler;
  loadConfig(cwd: string): Promise<ResolvedAcpxConfig>;
  startFacade?: (
    options: WorkspaceFacadeOptions,
    workspace: RootWorkspace,
  ) => Promise<RunningWorkspaceFacade>;
  onEmpty?: () => void | Promise<void>;
};

export type WorkspaceLease = {
  context: FacadeMcpContext;
  workspaceKey: string;
  release(): Promise<void>;
};

export type WorkspaceInitializationHold = {
  release(): void;
};

type WorkspaceEntry = {
  workspace: RootWorkspace;
  running: RunningWorkspaceFacade;
  leases: Set<string>;
  shutdownEpoch: number;
  shutdownTimer?: unknown;
};

const DEFAULT_SCHEDULER: RegistryScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceEntry>();
  private readonly initializations = new Map<string, Promise<WorkspaceEntry>>();
  private readonly closings = new Map<string, Promise<void>>();
  private readonly scheduler: RegistryScheduler;
  private readonly startFacade: NonNullable<WorkspaceRegistryOptions["startFacade"]>;
  private readonly initializationHolds = new Set<string>();
  private closed = false;

  constructor(private readonly options: WorkspaceRegistryOptions) {
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.startFacade = options.startFacade ?? startWorkspaceFacade;
  }

  get workspaceCount(): number {
    return this.entries.size;
  }

  get activeLeaseCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      count += entry.leases.size;
    }
    return count;
  }

  get pendingInitializationCount(): number {
    return this.initializations.size;
  }

  holdInitialization(connectionId: string): WorkspaceInitializationHold {
    if (this.closed) {
      throw new Error("Workspace registry is closed");
    }
    this.initializationHolds.add(connectionId);
    for (const entry of this.entries.values()) {
      entry.shutdownEpoch += 1;
      if (entry.shutdownTimer !== undefined) {
        this.scheduler.clearTimeout(entry.shutdownTimer);
        entry.shutdownTimer = undefined;
      }
    }
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.initializationHolds.delete(connectionId);
        if (this.initializationHolds.size === 0) {
          for (const [workspaceKey, entry] of this.entries) {
            this.scheduleShutdown(workspaceKey, entry);
          }
        }
      },
    };
  }

  async acquire(workspace: RootWorkspace, connectionId: string): Promise<WorkspaceLease> {
    if (this.closed) {
      throw new Error("Workspace registry is closed");
    }
    await this.closings.get(workspace.stateKey);
    if (this.closed) {
      throw new Error("Workspace registry is closed");
    }

    let entry = this.entries.get(workspace.stateKey);
    if (!entry) {
      let initialization = this.initializations.get(workspace.stateKey);
      if (!initialization) {
        initialization = this.createEntry(workspace);
        this.initializations.set(workspace.stateKey, initialization);
        const clearInitialization = () => {
          if (this.initializations.get(workspace.stateKey) === initialization) {
            this.initializations.delete(workspace.stateKey);
          }
        };
        void initialization.then(clearInitialization, clearInitialization);
      }
      entry = await initialization;
    }

    if (this.closed) {
      throw new Error("Workspace registry is closed");
    }

    entry.shutdownEpoch += 1;
    if (entry.shutdownTimer !== undefined) {
      this.scheduler.clearTimeout(entry.shutdownTimer);
      entry.shutdownTimer = undefined;
    }
    entry.leases.add(connectionId);

    let released = false;
    return {
      context: entry.running.context,
      workspaceKey: workspace.stateKey,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.release(workspace.stateKey, connectionId);
      },
    };
  }

  private async createEntry(workspace: RootWorkspace): Promise<WorkspaceEntry> {
    const config = await this.options.loadConfig(workspace.rootCwd);
    const running = await this.startFacade({ config }, workspace);
    const entry: WorkspaceEntry = {
      workspace,
      running,
      leases: new Set(),
      shutdownEpoch: 0,
    };
    if (this.closed) {
      await running.close();
      throw new Error("Workspace registry closed during initialization");
    }
    this.entries.set(workspace.stateKey, entry);
    return entry;
  }

  private release(workspaceKey: string, connectionId: string): void {
    const entry = this.entries.get(workspaceKey);
    if (!entry || !entry.leases.delete(connectionId) || entry.leases.size > 0) {
      return;
    }
    this.scheduleShutdown(workspaceKey, entry);
  }

  private scheduleShutdown(workspaceKey: string, entry: WorkspaceEntry): void {
    if (
      entry.leases.size > 0 ||
      entry.shutdownTimer !== undefined ||
      this.initializationHolds.size > 0
    ) {
      return;
    }
    const epoch = ++entry.shutdownEpoch;
    entry.shutdownTimer = this.scheduler.setTimeout(() => {
      void this.shutdownIfUnused(workspaceKey, entry, epoch);
    }, this.options.graceMs);
  }

  private async shutdownIfUnused(
    workspaceKey: string,
    entry: WorkspaceEntry,
    epoch: number,
  ): Promise<void> {
    if (
      this.entries.get(workspaceKey) !== entry ||
      entry.leases.size > 0 ||
      entry.shutdownEpoch !== epoch
    ) {
      return;
    }
    this.entries.delete(workspaceKey);
    entry.shutdownTimer = undefined;
    const closing = entry.running.close();
    this.closings.set(workspaceKey, closing);
    try {
      await closing;
    } finally {
      if (this.closings.get(workspaceKey) === closing) {
        this.closings.delete(workspaceKey);
      }
      if (this.entries.size === 0 && this.initializations.size === 0) {
        await this.options.onEmpty?.();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled([...this.closings.values(), ...this.initializations.values()]);
      return;
    }
    this.closed = true;
    this.initializationHolds.clear();
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      if (entry.shutdownTimer !== undefined) {
        this.scheduler.clearTimeout(entry.shutdownTimer);
      }
    }
    await Promise.allSettled([
      ...this.closings.values(),
      ...this.initializations.values(),
      ...entries.map(async (entry) => await entry.running.close()),
    ]);
  }
}
