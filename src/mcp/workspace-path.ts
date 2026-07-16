import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function canonicalizeWorkspacePath(value: string): string {
  const resolved = path.resolve(value);
  const canonical = realpathSync.native(resolved);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  return canonical;
}
