import path from "node:path";
import { fileURLToPath } from "node:url";
import { FacadeError } from "../facade/errors.js";
import { canonicalizeWorkspacePath } from "../workspace-path.js";

export type RootListingServer = {
  getClientCapabilities(): { roots?: object } | undefined;
  listRoots(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{ roots: Array<{ uri: string }> }>;
};

export type RootWorkspace = {
  stateKey: string;
  allowedCwdRoots: string[];
  rootCwd: string;
  defaultCreateCwd?: string;
  requireExplicitCreateCwd?: true;
};

const ROOTS_REQUEST_TIMEOUT_MS = 5_000;

function fallbackWorkspace(cwd: string): RootWorkspace {
  const canonicalCwd = canonicalizeWorkspacePath(cwd);
  return {
    stateKey: canonicalCwd,
    allowedCwdRoots: [canonicalCwd],
    rootCwd: canonicalCwd,
    defaultCreateCwd: canonicalCwd,
  };
}

function localRootPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      throw new FacadeError(
        "WORKSPACE_ROOT_INVALID",
        `MCP workspace root must use a file URI: ${uri}`,
      );
    }
    return canonicalizeWorkspacePath(fileURLToPath(url));
  } catch (error) {
    if (error instanceof FacadeError) {
      throw error;
    }
    throw new FacadeError("WORKSPACE_ROOT_INVALID", `Invalid MCP workspace root URI: ${uri}`, {
      cause: error,
    });
  }
}

export async function resolveRootWorkspace(
  server: RootListingServer,
  processCwd: string,
): Promise<RootWorkspace> {
  const cwd = path.resolve(processCwd);
  if (!server.getClientCapabilities()?.roots) {
    return fallbackWorkspace(cwd);
  }

  let result: Awaited<ReturnType<RootListingServer["listRoots"]>>;
  try {
    result = await server.listRoots(undefined, { timeout: ROOTS_REQUEST_TIMEOUT_MS });
  } catch (error) {
    throw new FacadeError("WORKSPACE_ROOT_INVALID", "MCP client returned invalid workspace roots", {
      cause: error,
    });
  }
  const roots = [...new Set(result.roots.map((root) => localRootPath(root.uri)))].toSorted();
  if (roots.length === 0) {
    throw new FacadeError(
      "WORKSPACE_ROOT_INVALID",
      "MCP client declared roots support but returned no workspace roots",
    );
  }
  if (roots.length === 1) {
    const root = roots[0] ?? cwd;
    return {
      stateKey: root,
      allowedCwdRoots: [root],
      rootCwd: root,
      defaultCreateCwd: root,
    };
  }
  return {
    stateKey: roots.join("\0"),
    allowedCwdRoots: roots,
    rootCwd: roots[0] ?? cwd,
    requireExplicitCreateCwd: true,
  };
}
