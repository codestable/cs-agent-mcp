import assert from "node:assert/strict";
import test from "node:test";
import { packageCommandSpawnOptions } from "../scripts/package-command-spawn.mjs";

test("package smoke enables a shell only for Windows command wrappers", () => {
  assert.deepEqual(packageCommandSpawnOptions("C:\\tools\\pnpm.cmd", "win32"), { shell: true });
  assert.deepEqual(packageCommandSpawnOptions("C:\\tools\\agent.bat", "win32"), { shell: true });
  assert.deepEqual(packageCommandSpawnOptions("C:\\tools\\node.exe", "win32"), { shell: false });
  assert.deepEqual(packageCommandSpawnOptions("/usr/local/bin/pnpm.cmd", "linux"), {
    shell: false,
  });
});
