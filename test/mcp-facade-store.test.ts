import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFacadeIdentityIssuer } from "../src/mcp/facade/identity.js";
import { createFileFacadeStore } from "../src/mcp/facade/store.js";

test("file facade store persists identity hashes without persisting raw bearer tokens", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-facade-store-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "facade.json");
  const firstStore = await createFileFacadeStore({ filePath });
  const firstIdentity = createFacadeIdentityIssuer({ store: firstStore });
  const actor = { rootExecutionId: "root-1", agentId: "agent-1" };

  const token = await firstIdentity.issue(actor);
  const persisted = await fs.readFile(filePath, "utf8");
  const secondStore = await createFileFacadeStore({ filePath });
  const secondIdentity = createFacadeIdentityIssuer({ store: secondStore });

  assert.equal(persisted.includes(token), false);
  assert.deepEqual(await secondIdentity.authenticate(token), actor);
  assert.equal(await secondIdentity.authenticate(`${token}x`), undefined);
});
