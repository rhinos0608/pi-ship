import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { registerDB } from "./tools/db/index.js";
import { registerShip } from "./tools/ship/index.js";
import { ApprovalRegistry } from "./core/approval.js";
import { providerRegistry } from "./providers/registry.js";

export { registerShip } from "./tools/ship/index.js";
export type { ShipHandler, ShipHandlerContext } from "./tools/ship/contracts.js";
export type { ShipInput } from "./tools/ship/schema.js";
export { shipSchema } from "./tools/ship/schema.js";
export { registerDB, DBFilterSchema, DBOrderSchema, DBSchema, DBValueSchema } from "./tools/db/index.js";
export type { DatabaseHandler, DatabaseHandlerContext } from "./tools/db/contracts.js";
export type { DBFilter, DBInput, DBOrder, DBValue } from "./tools/db/schema.js";

export default function piShipExtension(pi: ExtensionAPI): void {
  const approvalRegistry = new ApprovalRegistry(process.cwd());
  registerGate(pi, approvalRegistry);
  registerShip(pi, approvalRegistry);
  const database = registerDB(pi, approvalRegistry);
  providerRegistry.registerCommands(pi, approvalRegistry, (cwd) => providerRegistry.services(cwd));
  pi.on("session_shutdown", async () => { approvalRegistry.clear(); database.cleanup(); });
}
