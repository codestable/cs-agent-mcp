import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function commandName(command: string): string {
  return (
    command
      .trim()
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(?:bat|cmd|exe|ps1)$/i, "")
      .toLowerCase() ?? ""
  );
}

function isControlPlanePackage(value: string | undefined): boolean {
  return value !== undefined && /^cs-agent-mcp(?:@[^/\s]+)?$/i.test(value);
}

type OptionPolicy = {
  withValue: ReadonlySet<string>;
  withoutValue: ReadonlySet<string>;
};

const NPM_GLOBAL_OPTIONS: OptionPolicy = {
  withValue: new Set([
    "--cache",
    "--loglevel",
    "--node-options",
    "--prefix",
    "--registry",
    "--shell",
    "--tag",
    "--userconfig",
    "-w",
    "--workspace",
  ]),
  withoutValue: new Set([
    "--include-workspace-root",
    "--silent",
    "--workspaces",
    "-ws",
    "--yes",
    "-y",
  ]),
};

const NPM_EXEC_OPTIONS: OptionPolicy = {
  withValue: new Set([...NPM_GLOBAL_OPTIONS.withValue, "-c", "--call", "-p", "--package"]),
  withoutValue: new Set([...NPM_GLOBAL_OPTIONS.withoutValue, "--ignore-existing", "--no"]),
};

const PNPM_GLOBAL_OPTIONS: OptionPolicy = {
  withValue: new Set(["-C", "--dir", "--filter", "--registry", "--reporter", "--store-dir"]),
  withoutValue: new Set(["-r", "--recursive", "-s", "--silent", "-w", "--workspace-root"]),
};

const PNPM_DLX_OPTIONS: OptionPolicy = {
  withValue: new Set([
    "--allow-build",
    "-C",
    "--dir",
    "--package",
    "--registry",
    "--reporter",
    "--store-dir",
  ]),
  withoutValue: new Set(["-c", "--shell-mode", "-s", "--silent"]),
};

type PositionalArgument = {
  index: number;
  value: string;
};

function nextOptionIndex(
  args: string[],
  index: number,
  argument: string,
  options: OptionPolicy,
): number | undefined {
  if (argument.startsWith("--") && argument.includes("=")) {
    return index + 1;
  }
  if (options.withoutValue.has(argument)) {
    return index + 1;
  }
  if (options.withValue.has(argument) && args[index + 1] !== undefined) {
    return index + 2;
  }
  return undefined;
}

function resolvePositionalArgument(
  args: string[],
  index: number,
  argument: string,
  separatorStartsTarget: boolean,
): PositionalArgument | null | undefined {
  if (argument === "--") {
    const value = separatorStartsTarget ? args[index + 1] : undefined;
    return value === undefined ? undefined : { index: index + 1, value };
  }
  return argument.startsWith("-") ? null : { index, value: argument };
}

function firstPositionalArgument(
  args: string[],
  options: OptionPolicy,
  separatorStartsTarget: boolean,
): PositionalArgument | undefined {
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) {
      return undefined;
    }
    const positional = resolvePositionalArgument(args, index, argument, separatorStartsTarget);
    if (positional !== null) {
      return positional;
    }
    const nextIndex = nextOptionIndex(args, index, argument, options);
    if (nextIndex === undefined) {
      return undefined;
    }
    index = nextIndex;
  }
  return undefined;
}

function launchTarget(args: string[], options: OptionPolicy): string | undefined {
  return firstPositionalArgument(args, options, true)?.value;
}

function hasControlPlanePackage(args: string[], options: OptionPolicy): boolean {
  return isControlPlanePackage(launchTarget(args, options));
}

function argumentsAfterSubcommand(
  args: string[],
  subcommand: string,
  options: OptionPolicy,
): string[] | undefined {
  const candidate = firstPositionalArgument(args, options, false);
  return candidate?.value === subcommand ? args.slice(candidate.index + 1) : undefined;
}

type PackageExecInvocation = {
  args: string[];
  options: OptionPolicy;
};

function packageExecInvocation(command: string, args: string[]): PackageExecInvocation | undefined {
  if (command === "npx") {
    return { args, options: NPM_EXEC_OPTIONS };
  }
  if (command === "npm") {
    const launchArgs = argumentsAfterSubcommand(args, "exec", NPM_GLOBAL_OPTIONS);
    return launchArgs === undefined ? undefined : { args: launchArgs, options: NPM_EXEC_OPTIONS };
  }
  if (command === "pnpm") {
    const launchArgs = argumentsAfterSubcommand(args, "dlx", PNPM_GLOBAL_OPTIONS);
    return launchArgs === undefined ? undefined : { args: launchArgs, options: PNPM_DLX_OPTIONS };
  }
  return undefined;
}

function stringArguments(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((argument) => typeof argument === "string")) {
    return undefined;
  }
  return value;
}

function launchesControlPlane(server: UnknownRecord): boolean {
  if (typeof server.command !== "string") {
    return false;
  }
  const command = commandName(server.command);
  if (command === "cs-agent-mcp") {
    return true;
  }
  const args = stringArguments(server.args);
  if (!args) {
    return false;
  }
  const invocation = packageExecInvocation(command, args);
  return invocation !== undefined && hasControlPlanePackage(invocation.args, invocation.options);
}

export function findClaudeControlPlaneMcpAliases(config: unknown): string[] {
  const servers = asRecord(asRecord(config)?.mcpServers);
  if (!servers) {
    return [];
  }
  const aliases: string[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const server = asRecord(value);
    if (name.trim().length > 0 && server && launchesControlPlane(server)) {
      aliases.push(name);
    }
  }
  return aliases;
}

export async function readClaudeControlPlaneMcpAliases(
  configPath = path.join(os.homedir(), ".claude.json"),
): Promise<string[]> {
  try {
    return findClaudeControlPlaneMcpAliases(JSON.parse(await fs.readFile(configPath, "utf8")));
  } catch {
    return [];
  }
}

export function buildManagedIdentityMcpServers(input: {
  configuredServers: McpServer[];
  aliases: string[];
  includeClaudeAliases: boolean;
  url: string;
  token: string;
}): McpServer[] {
  const names = ["cs-agent-mcp", ...(input.includeClaudeAliases ? input.aliases : [])].filter(
    (name, index, all) => all.indexOf(name) === index,
  );
  return [
    ...input.configuredServers,
    ...names.map(
      (name): McpServer => ({
        type: "http",
        name,
        url: input.url,
        headers: [{ name: "Authorization", value: `Bearer ${input.token}` }],
      }),
    ),
  ];
}
