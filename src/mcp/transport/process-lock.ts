import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

type FacadeProcessLockRecord = {
  pid: number;
  token: string;
  createdAt: string;
  processIdentity?: string;
};

const facadeProcessLockRecordSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
  createdAt: z.string().min(1),
  processIdentity: z.string().min(1).optional(),
});

const MUTATION_GUARD_TIMEOUT_MS = 10_000;
const INCOMPLETE_GUARD_STALE_MS = 5_000;

export type FacadeProcessLock = {
  release(): Promise<void>;
};

export type FacadeProcessLockProbe =
  | {
      state: "running";
      pid: number;
      token: string;
      createdAt: string;
    }
  | {
      state: "stopped";
      pid?: number;
      token?: string;
      createdAt?: string;
    }
  | {
      state: "unknown";
      reason: string;
    };

export class FacadeProcessLockError extends Error {
  readonly code = "FACADE_ALREADY_RUNNING";

  constructor(lockPath: string, pid?: number) {
    super(
      pid === undefined
        ? `Another cs-agent-mcp process owns ${lockPath}`
        : `Another cs-agent-mcp process (pid ${pid}) owns ${lockPath}`,
    );
    this.name = "FacadeProcessLockError";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function parseLockRecord(value: string): FacadeProcessLockRecord | undefined {
  try {
    return facadeProcessLockRecordSchema.parse(JSON.parse(value));
  } catch {
    // A partial or damaged lock has no valid owner and can be recovered.
  }
  return undefined;
}

async function readLockRecord(lockPath: string): Promise<FacadeProcessLockRecord | undefined> {
  try {
    return parseLockRecord(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  return await new Promise<string | undefined>((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        timeout: 1_000,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        const identity = error ? "" : stdout.trim();
        resolve(identity || undefined);
      },
    );
  });
}

async function isRecordedProcessAlive(record: FacadeProcessLockRecord): Promise<boolean> {
  if (!isProcessAlive(record.pid)) {
    return false;
  }
  if (!record.processIdentity) {
    return true;
  }
  const currentIdentity = await readProcessIdentity(record.pid);
  return currentIdentity === undefined || currentIdentity === record.processIdentity;
}

export async function probeFacadeProcessLock(lockPath: string): Promise<FacadeProcessLockProbe> {
  let content: string;
  try {
    content = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { state: "stopped" };
    }
    return {
      state: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { state: "unknown", reason: "Invalid facade process lock JSON" };
  }
  const record = facadeProcessLockRecordSchema.safeParse(parsed);
  if (!record.success) {
    return { state: "unknown", reason: "Invalid facade process lock record" };
  }
  if (await isRecordedProcessAlive(record.data)) {
    return { state: "running", ...record.data };
  }
  return { state: "stopped", ...record.data };
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

type MutationGuard = {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
};

async function removeStaleMutationGuard(
  guardPath: string,
  expectedToken: string | undefined,
): Promise<void> {
  const quarantinePath = `${guardPath}.${randomUUID()}.stale`;
  try {
    await fs.rename(guardPath, quarantinePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const movedOwner = await readLockRecord(path.join(quarantinePath, "owner.json"));
  if (movedOwner?.token === expectedToken) {
    await fs.rm(quarantinePath, { recursive: true, force: true });
    return;
  }
  try {
    await fs.rename(quarantinePath, guardPath);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    await fs.rm(quarantinePath, { recursive: true, force: true });
  }
}

async function recoverMutationGuardIfStale(guardPath: string, ownerPath: string): Promise<boolean> {
  const owner = await readLockRecord(ownerPath);
  const guardIsStale = owner
    ? !(await isRecordedProcessAlive(owner))
    : await fs
        .stat(guardPath)
        .then((stat) => Date.now() - stat.mtimeMs >= INCOMPLETE_GUARD_STALE_MS)
        .catch(() => false);
  if (!guardIsStale) {
    return false;
  }
  await removeStaleMutationGuard(guardPath, owner?.token);
  return true;
}

async function acquireMutationGuard(lockPath: string): Promise<MutationGuard> {
  const guardPath = `${lockPath}.mutation`;
  const ownerPath = path.join(guardPath, "owner.json");
  const deadline = Date.now() + MUTATION_GUARD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let created = false;
    try {
      await fs.mkdir(guardPath, { mode: 0o700 });
      created = true;
      const processIdentity = await readProcessIdentity(process.pid);
      const token = randomUUID();
      await fs.writeFile(
        ownerPath,
        JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
          ...(processIdentity ? { processIdentity } : {}),
        }),
        { mode: 0o600 },
      );
      return {
        async assertOwned(): Promise<void> {
          const current = await readLockRecord(ownerPath);
          if (current?.token !== token) {
            throw new Error(`Lost the process-lock mutation guard for ${lockPath}`);
          }
        },
        async release(): Promise<void> {
          const current = await readLockRecord(ownerPath);
          if (current?.token === token) {
            await fs.rm(guardPath, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        if (created) {
          await fs.rm(guardPath, { recursive: true, force: true });
        }
        throw error;
      }
      if (await recoverMutationGuardIfStale(guardPath, ownerPath)) {
        continue;
      }
      await delay(10);
    }
  }
  throw new FacadeProcessLockError(lockPath);
}

async function writeOwnedLock(lockPath: string, record: FacadeProcessLockRecord): Promise<void> {
  const candidatePath = `${lockPath}.${record.token}.candidate`;
  const handle = await fs.open(candidatePath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(candidatePath, lockPath);
  } finally {
    await fs.rm(candidatePath, { force: true });
  }
}

export async function acquireFacadeProcessLock(lockPath: string): Promise<FacadeProcessLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const processIdentity = await readProcessIdentity(process.pid);
  const record: FacadeProcessLockRecord = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    ...(processIdentity ? { processIdentity } : {}),
  };

  const mutation = await acquireMutationGuard(lockPath);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mutation.assertOwned();
        await writeOwnedLock(lockPath, record);
        let released = false;
        let releaseOperation: Promise<void> | undefined;
        return {
          async release(): Promise<void> {
            if (released) {
              return;
            }
            releaseOperation ??= (async () => {
              const releaseMutation = await acquireMutationGuard(lockPath);
              try {
                await releaseMutation.assertOwned();
                const current = await readLockRecord(lockPath);
                if (current?.token === record.token) {
                  await removeStaleLock(lockPath);
                }
                released = true;
              } finally {
                await releaseMutation.release();
              }
            })();
            try {
              await releaseOperation;
            } finally {
              if (!released) {
                releaseOperation = undefined;
              }
            }
          },
        };
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
        const current = await readLockRecord(lockPath);
        if (current && (await isRecordedProcessAlive(current))) {
          throw new FacadeProcessLockError(lockPath, current.pid);
        }
        await mutation.assertOwned();
        await removeStaleLock(lockPath);
      }
    }
  } finally {
    await mutation.release();
  }

  throw new FacadeProcessLockError(lockPath);
}
