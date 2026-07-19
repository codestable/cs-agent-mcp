import path from "node:path";
import type { ResolvedAcpxConfig } from "../../cli/config.js";
import { runBrokerTransportBridge } from "../broker/bridge.js";
import { ensureLocalBroker } from "../broker/discovery.js";

export { resolveRootWorkspace } from "./workspace.js";
export type { RootWorkspace } from "./workspace.js";

type RunMcpServerOptions = {
  cwd: string;
  config?: ResolvedAcpxConfig;
};

export async function runMcpServer(options: RunMcpServerOptions): Promise<void> {
  const processCwd = path.resolve(options.cwd);
  const descriptor = await ensureLocalBroker();
  await runBrokerTransportBridge({ cwd: processCwd, descriptor });
}
