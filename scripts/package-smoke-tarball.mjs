import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageCommandSpawnOptions } from "./package-command-spawn.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-tarball-smoke-"));
const installRoot = path.join(temporaryRoot, "install");
const npmCache = process.env.NPM_CONFIG_CACHE ?? path.join(os.tmpdir(), "cs-agent-mcp-npm-cache");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let tarballPath;

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache, ...options.env },
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    ...packageCommandSpawnOptions(command),
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
  return stdout;
}

try {
  await run(pnpmCommand, ["run", "build:test"]);
  const packOutput = await run(npmCommand, ["pack", "--json", "--silent"], { capture: true });
  const packageFile = JSON.parse(packOutput)[0]?.filename;
  if (typeof packageFile !== "string" || packageFile.length === 0) {
    throw new Error("npm pack did not return a tarball filename");
  }
  tarballPath = path.join(root, packageFile);

  await run(npmCommand, [
    "install",
    "--prefix",
    installRoot,
    tarballPath,
    "--no-audit",
    "--no-fund",
  ]);
  const binary = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "cs-agent-mcp.cmd" : "cs-agent-mcp",
  );
  const installedCli = path.join(installRoot, "node_modules", "cs-agent-mcp", "dist", "mcp-cli.js");
  await run(binary, ["--version"]);
  await run(binary, ["--help"]);
  await run(pnpmCommand, ["run", "package:smoke"], {
    env: {
      CS_AGENT_MCP_BIN: process.execPath,
      CS_AGENT_MCP_BIN_ARGS: JSON.stringify([installedCli]),
      CS_AGENT_MCP_MOCK_AGENT: path.join(root, "dist-test", "test", "mock-agent.js"),
    },
  });
} finally {
  await Promise.all([
    fs.rm(temporaryRoot, { recursive: true, force: true }),
    tarballPath ? fs.rm(tarballPath, { force: true }) : Promise.resolve(),
  ]);
}
