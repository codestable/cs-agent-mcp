import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

type FacadeProcessLockRecord = {
  pid: number;
  token: string;
  createdAt: string;
};

const facadeProcessLockRecordSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
  createdAt: z.string().min(1),
});

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
  if (isProcessAlive(record.data.pid)) {
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
  const record: FacadeProcessLockRecord = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeOwnedLock(lockPath, record);
      let released = false;
      return {
        async release(): Promise<void> {
          if (released) {
            return;
          }
          const current = await readLockRecord(lockPath);
          if (current?.token === record.token) {
            await removeStaleLock(lockPath);
          }
          released = true;
        },
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const current = await readLockRecord(lockPath);
      if (current && isProcessAlive(current.pid)) {
        throw new FacadeProcessLockError(lockPath, current.pid);
      }
      await removeStaleLock(lockPath);
    }
  }

  throw new FacadeProcessLockError(lockPath);
}
