import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FacadeSnapshot, FacadeStore } from "./types.js";

type StoreWaiter = {
  resolve: (changed: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export function createEmptyFacadeSnapshot(): FacadeSnapshot {
  return {
    schema: "cs-agent-mcp.facade.v1",
    revision: 0,
    nextCursor: 1,
    agents: {},
    turns: {},
    messages: {},
    permissions: {},
    events: [],
    idempotency: {},
    identities: {},
  };
}

function createFacadeStore(
  initial: FacadeSnapshot = createEmptyFacadeSnapshot(),
  persist?: (snapshot: FacadeSnapshot) => Promise<void>,
): FacadeStore {
  let snapshot = structuredClone(initial);
  let updateTail: Promise<void> = Promise.resolve();
  const waiters = new Set<StoreWaiter>();

  const settleWaiter = (waiter: StoreWaiter, changed: boolean): void => {
    if (!waiters.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(changed);
  };

  const notifyWaiters = (): void => {
    for (const waiter of waiters) {
      settleWaiter(waiter, true);
    }
  };

  return {
    async read<T>(reader: (value: FacadeSnapshot) => T): Promise<T> {
      await updateTail;
      return reader(structuredClone(snapshot));
    },

    async update<T>(mutator: (value: FacadeSnapshot) => T): Promise<T> {
      const operation = updateTail.then(async () => {
        const next = structuredClone(snapshot);
        const result = mutator(next);
        next.revision += 1;
        await persist?.(next);
        snapshot = next;
        notifyWaiters();
        return structuredClone(result);
      });
      updateTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return await operation;
    },

    async waitForChange(
      afterRevision: number,
      waitMs: number,
      signal?: AbortSignal,
    ): Promise<boolean> {
      await updateTail;
      if (snapshot.revision > afterRevision) {
        return true;
      }
      if (waitMs <= 0 || signal?.aborted) {
        return false;
      }

      return await new Promise<boolean>((resolve) => {
        const waiter: StoreWaiter = {
          resolve,
          timeout: setTimeout(() => settleWaiter(waiter, false), waitMs),
          signal,
        };
        if (signal) {
          waiter.onAbort = () => settleWaiter(waiter, false);
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiters.add(waiter);
      });
    },
  };
}

export function createInMemoryFacadeStore(
  initial: FacadeSnapshot = createEmptyFacadeSnapshot(),
): FacadeStore {
  return createFacadeStore(initial);
}

function parseFacadeSnapshot(value: unknown): FacadeSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid cs-agent-mcp facade store snapshot");
  }
  const record = value as Record<string, unknown>;
  const objectKeys = ["agents", "turns", "messages", "permissions", "idempotency", "identities"];
  const hasInvalidObject = objectKeys.some(
    (key) => typeof record[key] !== "object" || record[key] === null || Array.isArray(record[key]),
  );
  if (
    record.schema !== "cs-agent-mcp.facade.v1" ||
    typeof record.revision !== "number" ||
    typeof record.nextCursor !== "number" ||
    !Array.isArray(record.events) ||
    hasInvalidObject
  ) {
    throw new Error("Invalid cs-agent-mcp facade store snapshot");
  }
  return value as FacadeSnapshot;
}

async function readFacadeSnapshot(filePath: string): Promise<FacadeSnapshot> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(content);
    return parseFacadeSnapshot(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyFacadeSnapshot();
    }
    throw error;
  }
}

async function writeFacadeSnapshot(filePath: string, snapshot: FacadeSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function createFileFacadeStore(options: { filePath: string }): Promise<FacadeStore> {
  const filePath = path.resolve(options.filePath);
  const initial = await readFacadeSnapshot(filePath);
  return createFacadeStore(
    initial,
    async (snapshot) => await writeFacadeSnapshot(filePath, snapshot),
  );
}
