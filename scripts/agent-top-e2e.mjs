import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-top-e2e-"));
const packDir = path.join(tempRoot, "pack");
const installPrefix = path.join(tempRoot, "install");
const home = path.join(tempRoot, "home");
const workspace = path.join(home, "workspace");
const facadesDir = path.join(home, ".cs-agent-mcp", "mcp", "facades");
const rawLog = path.join(tempRoot, "terminal.log");
const expectScript = path.join(tempRoot, "agent-top.exp");
const npmCache = process.env.NPM_CONFIG_CACHE ?? path.join(tempRoot, "npm-cache");

try {
  await Promise.all([
    fs.mkdir(packDir, { recursive: true }),
    fs.mkdir(installPrefix, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(facadesDir, { recursive: true }),
  ]);

  const packed = await run("npm", ["pack", "--pack-destination", packDir], {
    cwd: repoRoot,
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });
  const tarballName = packed.stdout
    .trim()
    .split("\n")
    .findLast((line) => line.endsWith(".tgz"));
  assert.ok(tarballName, `npm pack did not report a tarball:\n${packed.stdout}`);
  const tarball = path.join(packDir, tarballName);

  await run("npm", ["install", "--global", "--prefix", installPrefix, tarball], {
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });
  const binary = path.join(installPrefix, "bin", "cs-agent-mcp");
  await fs.access(binary);

  const instanceId = "eeeeeeeeeeeeeeeeeeeeeeee";
  const managedAgentId = "22222222-2222-4222-8222-222222222222";
  const timestamp = "2026-07-18T00:00:00.000Z";
  const snapshotPath = path.join(facadesDir, `${instanceId}.json`);
  const baseAgent = {
    rootExecutionId: "root-e2e",
    agent: "claude",
    cwd: workspace,
    mode: "persistent",
    queueDepth: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const snapshot = {
    schema: "cs-agent-mcp.facade.v1",
    revision: 1,
    nextCursor: 3,
    agents: {
      "11111111-1111-4111-8111-111111111111": {
        ...baseAgent,
        agentId: "11111111-1111-4111-8111-111111111111",
        kind: "root",
        name: "aaa-root",
        depth: 0,
        state: "idle",
      },
      [managedAgentId]: {
        ...baseAgent,
        agentId: managedAgentId,
        kind: "managed",
        name: "zzz-worker",
        depth: 1,
        state: "idle",
      },
    },
    turns: {},
    messages: {},
    permissions: {},
    events: [
      {
        cursor: "1",
        timestamp,
        type: "agent.created",
        agentId: managedAgentId,
        rootExecutionId: "root-e2e",
        data: { kind: "managed" },
      },
      {
        cursor: "2",
        timestamp,
        type: "turn.status",
        agentId: managedAgentId,
        rootExecutionId: "root-e2e",
        data: { text: "e2e output" },
      },
    ],
    idempotency: {},
    identities: {},
  };
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  await fs.writeFile(
    `${snapshotPath}.lock`,
    `${JSON.stringify({ pid: process.pid, token: "agent-top-e2e", createdAt: timestamp })}\n`,
    "utf8",
  );

  await fs.writeFile(expectScript, buildExpectScript({ binary, home, rawLog, tempRoot }), "utf8");
  try {
    await run("/usr/bin/expect", [expectScript], { env: process.env, timeoutMs: 180_000 });
  } catch (error) {
    const transcript = await fs.readFile(rawLog, "utf8").catch(() => "<no PTY transcript>");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPTY transcript tail:\n${JSON.stringify(
        transcript.slice(-8_000),
      )}`,
    );
  }

  const terminalOutput = await fs.readFile(rawLog);
  assertBufferIncludes(terminalOutput, "__TTY_RESTORED__:0:0", "cooked terminal state");
  assertBufferIncludes(terminalOutput, "zzz-worker | claude | idle", "managed Attach view");
  assertBufferIncludes(terminalOutput, "e2e output", "Attach event history");
  assertBufferIncludes(terminalOutput, "Terminal too small", "resize state");
  assertBufferIncludes(terminalOutput, "\u001b[?1049h", "alternate screen enable");
  assertBufferIncludes(terminalOutput, "\u001b[?1049l", "alternate screen disable");
  assertBufferIncludes(terminalOutput, "\u001b[?25l", "cursor hide");
  assertBufferIncludes(terminalOutput, "\u001b[?25h", "cursor restore");
  assertBufferIncludes(terminalOutput, "\u001b[?1000h", "mouse enable");
  assertBufferIncludes(terminalOutput, "\u001b[?1000l", "mouse disable");
  assertBufferIncludes(terminalOutput, "\u001b[?1006h", "SGR mouse enable");
  assertBufferIncludes(terminalOutput, "\u001b[?1006l", "SGR mouse disable");

  process.stdout.write(
    `${JSON.stringify({
      tarball: path.basename(tarball),
      top: "ok",
      ps: "ok",
      keyboard: "ok",
      sgrMouse: "ok",
      resize: "ok",
      attach: "ok",
      terminalRestore: "ok",
    })}\n`,
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function buildExpectScript({ binary, home, rawLog, tempRoot }) {
  return `set timeout 20
log_user 1
log_file -noappend ${tclValue(rawLog)}
set env(HOME) ${tclValue(home)}
set env(TERM) xterm-256color
set env(ZDOTDIR) ${tclValue(tempRoot)}
set binary ${tclValue(binary)}
proc wait_for {pattern label} {
  expect {
    -exact $pattern { return }
    timeout { puts stderr "timeout waiting for $label"; exit 2 }
    eof { puts stderr "eof waiting for $label"; exit 3 }
  }
}
spawn -noecho /bin/zsh -df
send -- "PS1='__CS_AGENT_TOP_PROMPT__ '; print -r -- __SHELL_READY__\\r"
wait_for "__SHELL_READY__" "interactive shell"
exec stty -f $spawn_out(slave,name) rows 24 columns 100
send -- "before=\\$(stty -g); \\"$binary\\" agents top; top_code=\\$?; middle=\\$(stty -g); \\"$binary\\" agents ps; ps_code=\\$?; after=\\$(stty -g); if test \\"\\$before\\" = \\"\\$middle\\" && test \\"\\$before\\" = \\"\\$after\\"; then print -r -- __TTY_RESTORED__:\\$top_code:\\$ps_code; else print -r -- __TTY_BROKEN__:\\$top_code:\\$ps_code; fi\\r"
wait_for "managed 1" "initial Agent list"
send -- "\\033\\[<64;2;5M"
send -- "\\033\\[<0;2;5M"
send -- "\\033\\[<0;2;5m"
send -- "\\r"
wait_for "zzz-worker | claude | idle" "managed Attach view"
wait_for "e2e output" "Attach history"
send -- "\\033"
wait_for "managed 1" "list after Esc"
exec stty -f $spawn_out(slave,name) rows 8 columns 40
exec kill -WINCH [exp_pid]
wait_for "Terminal too small" "small terminal resize"
exec stty -f $spawn_out(slave,name) rows 24 columns 100
exec kill -WINCH [exp_pid]
wait_for "managed 1" "restored terminal size"
send -- "q"
wait_for "cs-agent-mcp agents top" "ps alias startup"
send -- "q"
wait_for "__TTY_RESTORED__:0:0" "terminal restoration marker"
send -- "exit\\r"
expect {
  eof {}
  timeout { puts stderr "timeout waiting for shell exit"; exit 2 }
}
`;
}

function tclValue(value) {
  return `{${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")}}`;
}

function assertBufferIncludes(buffer, expected, label) {
  const needle = Buffer.from(expected);
  assert.notEqual(
    buffer.indexOf(needle),
    -1,
    `${label} marker was missing from the PTY transcript`,
  );
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, `${command} ${args.join(" ")} failed:\n${stderr}\n${stdout}`);
    return { stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}
