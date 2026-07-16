import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { registerDB } from "./tools/db/index.js";
import { registerShip } from "./tools/ship/index.js";
import { ApprovalRegistry } from "./core/approval.js";
import { providerRegistry } from "./providers/registry.js";
import { environmentSource } from "./core/environment.js";
import { registerBoundary } from "./boundary/integration/register.js";
import { manifestPath } from "./persistence/manifest-store.js";

export { spotlightingPreamble, defendToolResult, type SpotlightingPolicy } from "./defense/index.js";
export { registerShip } from "./tools/ship/index.js";
export type { ShipHandler, ShipHandlerContext } from "./tools/ship/contracts.js";
export type { ShipInput } from "./tools/ship/schema.js";
export { shipSchema } from "./tools/ship/schema.js";
export { registerDB, DBFilterSchema, DBOrderSchema, DBSchema, DBValueSchema } from "./tools/db/index.js";
export type { DatabaseHandler, DatabaseHandlerContext } from "./tools/db/contracts.js";
export type { DBFilter, DBInput, DBOrder, DBValue } from "./tools/db/schema.js";

export default async function piShipExtension(pi: ExtensionAPI): Promise<void> {
  const approvalRegistry = new ApprovalRegistry(process.cwd());
  const credentialSource = environmentSource();

  // Register boundary (null if managed mode or no manifest).
  // On misconfiguration, let errors propagate so initialization aborts
  // instead of falling back to raw credentials (fail closed).
  const boundary = await registerBoundary(pi, process.cwd(), credentialSource, approvalRegistry);
  const effectiveSource = boundary?.vault.asCredentialSource() ?? credentialSource;

  // Detect whether a pi-ship.json manifest exists. The ship tool requires
  // a provider manifest to function; skip registration when running in local
  // mode (no manifest) so the tool is not presented to the agent.
  let manifestExists = false;
  try {
    await access(manifestPath(process.cwd()));
    manifestExists = true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  registerGate(pi, approvalRegistry);
  if (manifestExists) {
    registerShip(pi, approvalRegistry, {
      credentialSource: effectiveSource,
      vault: boundary?.vault,
    });
  }
  const database = registerDB(pi, approvalRegistry, { credentialSource: effectiveSource });
  if (manifestExists) {
    providerRegistry.registerCommands(pi, approvalRegistry, (cwd) => providerRegistry.services(cwd));
  }
  pi.on("session_shutdown", async () => { approvalRegistry.clear(); database.cleanup(); });
}
