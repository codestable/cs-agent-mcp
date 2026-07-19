import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireFacadeProcessLock } from "../src/mcp/transport/process-lock.js";

function spawnLockContender(lockPath: string, timezone: string): ChildProcessWithoutNullStreams {
  const moduleUrl = new URL("../src/mcp/transport/process-lock.js", import.meta.url).href;
  const script = `
    import { acquireFacadeProcessLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lease = await acquireFacadeProcessLock(${JSON.stringify(lockPath)});
      process.stdout.write("acquired\\n");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("end", resolve));
      await lease.release();
    } catch (error) {
      process.stdout.write("error:" + String(error?.code ?? error?.message ?? error) + "\\n");
      process.exitCode = 2;
    }
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, TZ: timezone },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readContenderResult(child: ChildProcessWithoutNullStreams): Promise<string> {
  child.stdout.setEncoding("utf8");
  let output = "";
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for lock contender")),
      5_000,
    );
    child.once("error", reject);
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(output.slice(0, newline));
      }
    });
  });
}

async function waitForContenderExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

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
  const competingAcquire = acquireFacadeProcessLock(lockPath);
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  releaseWrite();

  const winningLease = await delayedAcquire;
  await assert.rejects(competingAcquire, { code: "FACADE_ALREADY_RUNNING" });
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

test("facade process lock recovers when a live pid belongs to a different process generation", async (t) => {
  if (process.platform === "win32") {
    t.skip("process generation identity is not available on Windows");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-reused-pid-lock-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "facade.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      token: "previous-process-generation",
      createdAt: "2026-07-19T00:00:00.000Z",
      processIdentity: "Mon Jan  1 00:00:00 2001",
    }),
  );

  const lease = await acquireFacadeProcessLock(lockPath);
  const replacement = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: string };
  assert.notEqual(replacement.token, "previous-process-generation");
  await lease.release();
});

test("facade process lock identity is stable across contender timezones", async (t) => {
  if (process.platform === "win32") {
    t.skip("process generation identity is not available on Windows");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-timezone-lock-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "facade.lock");
  const first = spawnLockContender(lockPath, "UTC");
  t.after(() => first.kill("SIGKILL"));
  assert.equal(await readContenderResult(first), "acquired");

  const second = spawnLockContender(lockPath, "Asia/Shanghai");
  assert.equal(await readContenderResult(second), "error:FACADE_ALREADY_RUNNING");
  assert.equal(await waitForContenderExit(second), 2);
  first.stdin.end();
  assert.equal(await waitForContenderExit(first), 0);
});

test("facade process lock serializes two contenders recovering the same stale owner", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-stale-race-lock-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "facade.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 2_147_483_647, token: "stale-race", createdAt: "2000-01-01" }),
  );

  const contenders = [
    spawnLockContender(lockPath, "UTC"),
    spawnLockContender(lockPath, "Asia/Shanghai"),
  ];
  t.after(() => contenders.forEach((child) => child.kill("SIGKILL")));
  const results = await Promise.all(contenders.map(readContenderResult));
  assert.deepEqual(results.toSorted(), ["acquired", "error:FACADE_ALREADY_RUNNING"]);
  const winner = contenders[results.indexOf("acquired")];
  const loser = contenders[results.indexOf("error:FACADE_ALREADY_RUNNING")];
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(await waitForContenderExit(loser), 2);
  winner.stdin.end();
  assert.equal(await waitForContenderExit(winner), 0);
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
});
