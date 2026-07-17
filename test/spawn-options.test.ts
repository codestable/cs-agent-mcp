import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeExecutable, resolveCodexExecutable } from "../src/acp/agent-command.js";
import { resolveAgentSessionCwd } from "../src/acp/client-process.js";
import { AcpClient, buildAgentSpawnOptions, buildSpawnCommandOptions } from "../src/acp/client.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { buildQueueOwnerSpawnOptions } from "../src/cli/session/queue-owner-process.js";
import {
  buildTerminalShellSpawnCommand,
  buildTerminalSpawnCommand,
  resolveWindowsExecutablePath,
} from "../src/spawn-command-options.js";

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

type TestAgentLaunchPlan = {
  spawnCommand: string;
  copilotAcp: boolean;
  claudeAcp: boolean;
  codexAcp: boolean;
  spawnOptions: ReturnType<typeof buildAgentSpawnOptions>;
};

type AcpClientLaunchInternals = {
  resolveAgentLaunchPlan: () => Promise<TestAgentLaunchPlan>;
  ensureLaunchSupport: (plan: TestAgentLaunchPlan) => Promise<void>;
};

function asLaunchInternals(client: AcpClient): AcpClientLaunchInternals {
  return client as unknown as AcpClientLaunchInternals;
}

test("buildAgentSpawnOptions merges session env into the agent child environment", () => {
  const previous = process.env.ACPX_TEST_SESSION_ENV_PARENT;
  process.env.ACPX_TEST_SESSION_ENV_PARENT = "parent-value";
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      ACPX_TEST_SESSION_ENV_INJECTED: "injected-value",
      ACPX_TEST_SESSION_ENV_PARENT: "overridden-by-session",
    });

    assert.equal(options.env.ACPX_TEST_SESSION_ENV_INJECTED, "injected-value");
    assert.equal(
      options.env.ACPX_TEST_SESSION_ENV_PARENT,
      "overridden-by-session",
      "session env must override the parent process env for colliding keys",
    );
  } finally {
    if (previous == null) {
      delete process.env.ACPX_TEST_SESSION_ENV_PARENT;
    } else {
      process.env.ACPX_TEST_SESSION_ENV_PARENT = previous;
    }
  }
});

test("buildAgentSpawnOptions leaves the agent env untouched when no session env is configured", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, undefined);
  assert.equal(options.env.ACPX_TEST_SESSION_ENV_INJECTED, undefined);
});

test("spawned agent child process receives session env with parent-override precedence", async () => {
  const script =
    "process.stdout.write(JSON.stringify({injected:process.env.ACPX_TEST_E2E_INJECTED,parent:process.env.ACPX_TEST_E2E_PARENT}))";
  const options = buildAgentSpawnOptions(os.tmpdir(), undefined, {
    ACPX_TEST_E2E_INJECTED: "e2e-injected",
    ACPX_TEST_E2E_PARENT: "e2e-overridden",
  });

  const result = await new Promise<{ injected?: string; parent?: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`failed to parse child stdout: ${stdout} (${stderr})`));
      }
    });
  });

  assert.equal(
    result.injected,
    "e2e-injected",
    "real child process must receive the injected session env var",
  );
  assert.equal(
    result.parent,
    "e2e-overridden",
    "real child process must see session env override the parent value",
  );
});

test("buildAgentSpawnOptions hides Windows console windows and preserves auth env", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", {
    ACPX_AUTH_TOKEN: "secret-token",
  });

  assert.equal(options.cwd, "/tmp/acpx-agent");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_AUTH_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions prevents session env from overriding injected auth env", () => {
  const options = buildAgentSpawnOptions(
    "/tmp/acpx-agent",
    {
      "api-token": "secret-token",
    },
    {
      ACPX_AUTH_API_TOKEN: "session-prefixed",
      API_TOKEN: "session-normalized",
    },
  );

  assert.equal(options.env.ACPX_AUTH_API_TOKEN, "secret-token");
  assert.equal(options.env.API_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions protects auth env case-insensitively on Windows", () => {
  return withPlatform("win32", () => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      {
        "case-token": "secret-token",
      },
      {
        acpx_auth_case_token: "session-prefixed",
        case_token: "session-normalized",
      },
    );

    assert.equal(options.env.ACPX_AUTH_CASE_TOKEN, "secret-token");
    assert.equal(options.env.CASE_TOKEN, "secret-token");
    assert.equal(options.env.acpx_auth_case_token, undefined);
    assert.equal(options.env.case_token, undefined);
  });
});

test("buildAgentSpawnOptions protects inherited auth env case-insensitively on Windows", () => {
  return withPlatform("win32", () => {
    const previous = process.env.acpx_auth_inherited_token;
    process.env.acpx_auth_inherited_token = "inherited-secret";
    try {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        ACPX_AUTH_INHERITED_TOKEN: "session-prefixed",
        INHERITED_TOKEN: "session-normalized",
      });

      assert.equal(options.env.acpx_auth_inherited_token, "inherited-secret");
      assert.equal(options.env.INHERITED_TOKEN, "inherited-secret");
      assert.equal(options.env.ACPX_AUTH_INHERITED_TOKEN, undefined);
    } finally {
      if (previous == null) {
        delete process.env.acpx_auth_inherited_token;
      } else {
        process.env.acpx_auth_inherited_token = previous;
      }
    }
  });
});

test("buildAgentSpawnOptions replaces inherited env case collisions on Windows", () => {
  return withPlatform("win32", () => {
    const previous = process.env.ACPX_TEST_SESSION_ENV_CASE;
    process.env.ACPX_TEST_SESSION_ENV_CASE = "inherited";
    try {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpx_test_session_env_case: "session",
      });

      assert.equal(options.env.ACPX_TEST_SESSION_ENV_CASE, undefined);
      assert.equal(options.env.acpx_test_session_env_case, "session");
    } finally {
      if (previous == null) {
        delete process.env.ACPX_TEST_SESSION_ENV_CASE;
      } else {
        process.env.ACPX_TEST_SESSION_ENV_CASE = previous;
      }
    }
  });
});

test("buildAgentSpawnOptions promotes explicit ACPX auth env vars into agent auth env", () => {
  const previousPrefixed = process.env.ACPX_AUTH_OPENAI_API_KEY;
  const previousNormalized = process.env.OPENAI_API_KEY;

  process.env.ACPX_AUTH_OPENAI_API_KEY = "sk-explicit";
  delete process.env.OPENAI_API_KEY;

  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined);
    assert.equal(options.env.ACPX_AUTH_OPENAI_API_KEY, "sk-explicit");
    assert.equal(options.env.OPENAI_API_KEY, "sk-explicit");
  } finally {
    if (previousPrefixed == null) {
      delete process.env.ACPX_AUTH_OPENAI_API_KEY;
    } else {
      process.env.ACPX_AUTH_OPENAI_API_KEY = previousPrefixed;
    }

    if (previousNormalized == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousNormalized;
    }
  }
});

test("buildTerminalSpawnOptions hides Windows console windows and maps env entries", () => {
  const options = buildTerminalSpawnOptions("node", "/tmp/acpx-terminal", [
    { name: "TMUX", value: "/tmp/tmux-1000/default,123,0" },
    { name: "TERM", value: "screen-256color" },
  ]);

  assert.equal(options.cwd, "/tmp/acpx-terminal");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env?.TMUX, "/tmp/tmux-1000/default,123,0");
  assert.equal(options.env?.TERM, "screen-256color");
});

test("buildQueueOwnerSpawnOptions hides Windows console windows and passes payload path", () => {
  const options = buildQueueOwnerSpawnOptions("/tmp/acpx-queue-owner/payload.json");

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_QUEUE_OWNER_PAYLOAD_FILE, "/tmp/acpx-queue-owner/payload.json");
  assert.equal(options.env.ACPX_QUEUE_OWNER_PAYLOAD, undefined);
});

test("buildSpawnCommandOptions enables shell for .cmd/.bat on Windows", () => {
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  const cmdOptions = buildSpawnCommandOptions("C:\\Program Files\\nodejs\\npx.cmd", base, "win32");
  const batOptions = buildSpawnCommandOptions("C:\\tools\\agent.bat", base, "win32");

  assert.equal(cmdOptions.shell, true);
  assert.equal(batOptions.shell, true);
  assert.deepEqual(cmdOptions.stdio, base.stdio);
  assert.equal(cmdOptions.windowsHide, true);
});

test("buildSpawnCommandOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildSpawnCommandOptions("npx", base, "win32", env);
    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, base.stdio);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSpawnCommandOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const linuxOptions = buildSpawnCommandOptions("/usr/bin/npx", base, "linux");
    const windowsExeOptions = buildSpawnCommandOptions("node", base, "win32", env);

    assert.equal(linuxOptions.shell, undefined);
    assert.equal(windowsExeOptions.shell, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnCommand preserves explicit argv", () => {
  assert.deepEqual(buildTerminalSpawnCommand("node", ["-e", "console.log('ok')"]), {
    command: "node",
    args: ["-e", "console.log('ok')"],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", []), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", undefined), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
});

test("buildTerminalShellSpawnCommand routes command lines through the shell", () => {
  assert.deepEqual(buildTerminalShellSpawnCommand("echo hello | tr a-z A-Z", "darwin"), {
    command: "/bin/sh",
    args: ["-c", "echo hello | tr a-z A-Z"],
    killProcessGroup: true,
  });
  assert.deepEqual(buildTerminalShellSpawnCommand("dir C:\\Users", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "dir C:\\Users"],
    killProcessGroup: true,
  });
});

test("resolveAgentSessionCwd translates WSL cwd for Windows exe agents", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Users/User/AppData/Local/GitHub CLI/copilot/copilot.exe" --acp --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd leaves non-WSL and non-Windows agents on resolved cwd", async () => {
  const nonWsl = await resolveAgentSessionCwd("relative/project", "/mnt/c/tools/copilot.exe", {
    platform: "linux",
    existsSync: () => false,
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });
  const inputCwd = "/home/user/project";
  const wslNodeAgent = await resolveAgentSessionCwd(inputCwd, "node ./agent.js", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });

  assert.equal(nonWsl, path.resolve("relative/project"));
  assert.equal(wslNodeAgent, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd translates WSL cwd for Windows .cmd wrappers", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Program Files/nodejs/npx.cmd" some-acp-agent --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd translates WSL cwd for Windows agents on non-C drives", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/d/tools/agent.bat --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async (value) => {
      capturedCwd = value;
      return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
    },
  });

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd does not translate WSL cwd for extension-less commands under /mnt/<drive>/", async () => {
  const inputCwd = "/home/user/project";
  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/c/tools/linux-agent --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run for extension-less /mnt/<drive>/ commands");
    },
  });

  assert.equal(cwd, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd rejects empty wslpath output", async () => {
  await assert.rejects(
    resolveAgentSessionCwd("/home/user/project", "/mnt/c/tools/copilot.exe --acp", {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async () => "\n",
    }),
    /wslpath returned an empty Windows path/,
  );
});

test("buildTerminalSpawnOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildTerminalSpawnOptions(
      "npx",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const options = buildTerminalSpawnOptions(
      "node",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable finds claude.exe on PATH on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = { PATH: tempDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, path.join(tempDir, "claude.exe"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable ignores a Windows command shim without a native executable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-shim-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.cmd"), '@echo off\r\nnode "%~dp0cli.js" %*\r\n');
    const env = {
      PATH: tempDir,
      PATHEXT: ".CMD;.EXE;.BAT;.PS1",
    } as NodeJS.ProcessEnv;

    assert.equal(resolveClaudeCodeExecutable("win32", env), undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable prefers a native sibling when PATH ordering finds a shim first", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-shim-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.cmd"), "@echo off\r\n");
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".CMD;.EXE;.BAT;.PS1",
    } as NodeJS.ProcessEnv;

    assert.equal(resolveClaudeCodeExecutable("win32", env), path.join(tempDir, "claude.exe"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveWindowsExecutablePath follows a wrapper to a native entrypoint", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-shim-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    const executable = path.join(binDir, "claude.exe");
    await fs.writeFile(executable, "");
    await fs.writeFile(
      path.join(tempDir, "claude.cmd"),
      `@echo off\r\n"%~dp0bin\\claude.exe" %*\r\n`,
    );
    const env = {
      PATH: tempDir,
      PATHEXT: ".CMD;.EXE;.BAT;.PS1",
    } as NodeJS.ProcessEnv;

    assert.equal(resolveWindowsExecutablePath("claude", env), executable);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined when CLAUDE_CODE_EXECUTABLE is already set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable respects case-insensitive env var on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      claude_code_executable: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable finds an executable Claude CLI on POSIX PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-cli-"));
  const executable = path.join(tempDir, "claude");
  try {
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(resolveClaudeCodeExecutable("darwin", { PATH: tempDir }), executable);
    assert.equal(resolveClaudeCodeExecutable("linux", { PATH: tempDir }), executable);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable prefers the official POSIX user install over PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-cli-"));
  const homeDir = path.join(tempDir, "home");
  const localExecutable = path.join(homeDir, ".local", "bin", "claude");
  const pathDir = path.join(tempDir, "path-bin");
  try {
    await fs.mkdir(path.dirname(localExecutable), { recursive: true });
    await fs.mkdir(pathDir);
    await fs.writeFile(localExecutable, "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(path.join(pathDir, "claude"), "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(
      resolveClaudeCodeExecutable("darwin", { HOME: homeDir, PATH: pathDir }),
      localExecutable,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable ignores a non-executable Claude file on POSIX PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-cli-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude"), "#!/bin/sh\n", { mode: 0o644 });

    assert.equal(resolveClaudeCodeExecutable("darwin", { PATH: tempDir }), undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable preserves an explicit POSIX Claude executable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-cli-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude"), "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(
      resolveClaudeCodeExecutable("darwin", {
        PATH: tempDir,
        CLAUDE_CODE_EXECUTABLE: "/custom/claude",
      }),
      undefined,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined when claude is not on PATH", () => {
  const env = { PATH: "/nonexistent", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
  const result = resolveClaudeCodeExecutable("win32", env);
  assert.equal(result, undefined);
});

test("resolveCodexExecutable finds an executable Codex CLI on POSIX PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-cli-"));
  const executable = path.join(tempDir, "codex");
  try {
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(resolveCodexExecutable("darwin", { PATH: tempDir }), executable);
    assert.equal(resolveCodexExecutable("linux", { PATH: tempDir }), executable);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable prefers the POSIX user install over PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-cli-"));
  const homeDir = path.join(tempDir, "home");
  const localExecutable = path.join(homeDir, ".local", "bin", "codex");
  const pathDir = path.join(tempDir, "path-bin");
  try {
    await fs.mkdir(path.dirname(localExecutable), { recursive: true });
    await fs.mkdir(pathDir);
    await fs.writeFile(localExecutable, "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(path.join(pathDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(
      resolveCodexExecutable("darwin", { HOME: homeDir, PATH: pathDir }),
      localExecutable,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable accepts Windows command shims and native executables", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-exe-"));
  const shimDir = path.join(tempDir, "shim");
  const nativeDir = path.join(tempDir, "native");
  try {
    await fs.mkdir(shimDir);
    await fs.mkdir(nativeDir);
    const shim = path.join(shimDir, "codex.cmd");
    const executable = path.join(nativeDir, "codex.exe");
    await fs.writeFile(shim, "@echo off\r\n");
    await fs.writeFile(executable, "");

    assert.equal(
      resolveCodexExecutable("win32", {
        PATH: shimDir,
        PATHEXT: ".CMD;.EXE;.BAT",
      }),
      shim,
    );
    assert.equal(
      resolveCodexExecutable("win32", {
        PATH: nativeDir,
        PATHEXT: ".CMD;.EXE;.BAT",
      }),
      executable,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable preserves an explicit CODEX_PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-cli-"));
  try {
    await fs.writeFile(path.join(tempDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(path.join(tempDir, "codex.exe"), "");

    assert.equal(
      resolveCodexExecutable("darwin", {
        PATH: tempDir,
        CODEX_PATH: "/custom/codex",
      }),
      undefined,
    );
    assert.equal(
      resolveCodexExecutable("win32", {
        PATH: tempDir,
        PATHEXT: ".EXE;.CMD",
        CODEX_PATH: "C:\\custom\\codex.exe",
      }),
      undefined,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable respects case-insensitive CODEX_PATH on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "codex.cmd"), "@echo off\r\n");

    assert.equal(
      resolveCodexExecutable("win32", {
        PATH: tempDir,
        PATHEXT: ".CMD;.EXE;.BAT",
        codex_path: "C:\\custom\\codex.cmd",
      }),
      undefined,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AcpClient injects the resolved CODEX_PATH into built-in Codex ACP launches", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-launch-"));
  const homeDir = path.join(tempDir, "home");
  const executable = path.join(homeDir, ".local", "bin", "codex");
  const previousCodexPath = process.env.CODEX_PATH;
  delete process.env.CODEX_PATH;

  try {
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    const client = asLaunchInternals(
      new AcpClient({
        agentCommand: AGENT_REGISTRY.codex,
        cwd: tempDir,
        permissionMode: "approve-reads",
        sessionOptions: { env: { HOME: homeDir, PATH: "/nonexistent" } },
      }),
    );

    const plan = await client.resolveAgentLaunchPlan();
    assert.equal(plan.codexAcp, true);
    assert.equal(plan.spawnOptions.env.CODEX_PATH, undefined);

    await client.ensureLaunchSupport(plan);
    assert.equal(plan.spawnOptions.env.CODEX_PATH, executable);
  } finally {
    if (previousCodexPath == null) {
      delete process.env.CODEX_PATH;
    } else {
      process.env.CODEX_PATH = previousCodexPath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("AcpClient preserves an explicit CODEX_PATH for built-in Codex ACP launches", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-launch-"));
  const homeDir = path.join(tempDir, "home");
  const executable = path.join(homeDir, ".local", "bin", "codex");
  const explicitPath = "/custom/codex";

  try {
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    const client = asLaunchInternals(
      new AcpClient({
        agentCommand: AGENT_REGISTRY.codex,
        cwd: tempDir,
        permissionMode: "approve-reads",
        sessionOptions: {
          env: { HOME: homeDir, PATH: "/nonexistent", CODEX_PATH: explicitPath },
        },
      }),
    );

    const plan = await client.resolveAgentLaunchPlan();
    assert.equal(plan.codexAcp, true);

    await client.ensureLaunchSupport(plan);
    assert.equal(plan.spawnOptions.env.CODEX_PATH, explicitPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
