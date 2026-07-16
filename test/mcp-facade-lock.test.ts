import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireFacadeProcessLock } from "../src/mcp/transport/process-lock.js";

test("facade process lock enforces one owner and releases cleanly", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-lock-"));
  const lockPath = path.join(directory, "facade.lock");
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  const first = await acquireFacadeProcessLock(lockPath);
  await assert.rejects(acquireFacadeProcessLock(lockPath), {
    code: "FACADE_ALREADY_RUNNING",
  });
  await first.release();

  const replacement = await acquireFacadeProcessLock(lockPath);
  await replacement.release();
});

test("facade process lock recovers a stale owner", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-stale-lock-"));
  const lockPath = path.join(directory, "facade.lock");
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 2_147_483_647, token: "stale", createdAt: "2000-01-01T00:00:00.000Z" }),
  );

  const lease = await acquireFacadeProcessLock(lockPath);
  await lease.release();
});

test("facade process lock never publishes a partially written owner record", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-atomic-lock-"));
  const lockPath = path.join(directory, "facade.lock");
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  const originalOpen = fs.open;
  let releaseWrite = (): void => undefined;
  let signalWriteStarted = (): void => undefined;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let delayNextWrite = true;
  fs.open = async (file, flags, mode) => {
    const handle = await originalOpen(file, flags, mode);
    if (!delayNextWrite) {
      return handle;
    }
    delayNextWrite = false;
    const originalWriteFile = handle.writeFile.bind(handle);
    handle.writeFile = async (data, options) => {
      signalWriteStarted();
      await writeReleased;
      await originalWriteFile(data, options);
    };
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
    releaseWrite();
  });

  const delayedAcquire = acquireFacadeProcessLock(lockPath);
  await writeStarted;
  const winningLease = await acquireFacadeProcessLock(lockPath);
  releaseWrite();

  await assert.rejects(delayedAcquire, { code: "FACADE_ALREADY_RUNNING" });
  await winningLease.release();
});

test("facade process lock removes its candidate after a write failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-failed-lock-"));
  const lockPath = path.join(directory, "facade.lock");
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  const originalOpen = fs.open;
  let failNextWrite = true;
  fs.open = async (file, flags, mode) => {
    const handle = await originalOpen(file, flags, mode);
    if (!failNextWrite) {
      return handle;
    }
    failNextWrite = false;
    handle.writeFile = async () => {
      throw Object.assign(new Error("simulated lock write failure"), { code: "EIO" });
    };
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await assert.rejects(acquireFacadeProcessLock(lockPath), { code: "EIO" });
  assert.deepEqual(await fs.readdir(directory), []);

  fs.open = originalOpen;
  const recoveredLease = await acquireFacadeProcessLock(lockPath);
  await recoveredLease.release();
});

test("facade process lock release can retry after a transient filesystem failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-release-retry-"));
  const lockPath = path.join(directory, "facade.lock");
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  const lease = await acquireFacadeProcessLock(lockPath);
  const ownedRecord = await fs.readFile(lockPath, "utf8");
  await fs.rm(lockPath);
  await fs.mkdir(lockPath);
  await assert.rejects(lease.release());

  await fs.rm(lockPath, { recursive: true });
  await fs.writeFile(lockPath, ownedRecord);
  await lease.release();

  const replacement = await acquireFacadeProcessLock(lockPath);
  await replacement.release();
});
