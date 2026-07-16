import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

test("file session store keeps state private and rejects corrupt records", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-runtime-store-"));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const store = createFileSessionStore({ stateDir });
  const record = makeSessionRecord({ acpxRecordId: "private-session" });
  const sessionDir = path.join(stateDir, "sessions");
  const filePath = path.join(sessionDir, "private-session.json");

  await store.save(record);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(sessionDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    await fs.chmod(filePath, 0o644);
  }

  assert.equal((await store.load(record.acpxRecordId))?.acpxRecordId, record.acpxRecordId);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  }

  await fs.writeFile(filePath, "not-json\n", "utf8");
  await assert.rejects(store.load(record.acpxRecordId), /Invalid ACP session JSON/);
  await fs.writeFile(filePath, "{}\n", "utf8");
  await assert.rejects(store.load(record.acpxRecordId), /Invalid ACP session record/);
});
