import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { registerDbOps } from "./tools/db-ops.js";
import { registerShipOps } from "./tools/ship-ops.js";
import { registerShipCommands } from "./commands/ship.js";
import { ApprovalRegistry } from "./core/approval.js";

export type { ShipOpsInput } from "./tools/ship-ops.js";
export type { DbOpsInput } from "./tools/db-ops.js";

export default function piShipExtension(pi: ExtensionAPI): void {
  const registry = new ApprovalRegistry(process.cwd());
  registerGate(pi, registry);
  registerShipOps(pi, registry);
  registerDbOps(pi, registry);
  registerShipCommands(pi, registry);
  pi.on("session_shutdown", async () => { registry.clear(); });
}
