import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { registerDB } from "./tools/db/index.js";
import { registerShip } from "./tools/ship/index.js";
import { ApprovalRegistry } from "./core/approval.js";
import { providerRegistry } from "./providers/registry.js";
import { environmentSource } from "./core/environment.js";
import { registerBoundary } from "./boundary/integration/register.js";
import { loadProviderRuntimeBinding } from "./persistence/manifest-store.js";
import { composeShipSchema } from "./tools/ship/schema.js";
import { composeDBSchema } from "./tools/db/schema.js";

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

  // ── Build one startup binding ────────────────────────────────────────
  // ENOENT → local binding. Invalid/unreadable → throws before any registration.
  const binding = await loadProviderRuntimeBinding(process.cwd(), providerRegistry.packages);

  // ── Register boundary (null if managed mode or no manifest) ──────────
  const boundary = await registerBoundary(pi, binding, credentialSource, approvalRegistry);
  const effectiveSource = boundary?.vault.asCredentialSource() ?? credentialSource;

  // ── Register gate unconditionally ────────────────────────────────────
  registerGate(pi, approvalRegistry);

  // ── Register DB always ───────────────────────────────────────────────
  // Always use profile-composed schema to match capabilities exactly.
  // Local profile has no additions — composeDBSchema([]) = 8 shared actions.
  const dbSchema = composeDBSchema(binding.profile.databaseAdditions);

  const database = registerDB(pi, approvalRegistry, {
    credentialSource: effectiveSource,
    binding,
    parameters: dbSchema,
  });

  // ── Register ship only when profile has variants ─────────────────────
  if (binding.profile.ship.length > 0) {
    const shipSchema = composeShipSchema(binding.profile.ship);
    registerShip(pi, approvalRegistry, {
      credentialSource: effectiveSource,
      vault: boundary?.vault,
      binding,
      parameters: shipSchema,
    });
  }

  // ── Register commands only when a provider package is selected ──────
  if (binding.package) {
    providerRegistry.registerCommands(
      pi,
      approvalRegistry,
      (cwd) => providerRegistry.services(cwd, binding, effectiveSource),
      binding,
    );
  }

  pi.on("session_shutdown", async () => { approvalRegistry.clear(); database.cleanup(); });
}
