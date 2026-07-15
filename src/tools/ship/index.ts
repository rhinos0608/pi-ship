import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import { providerRegistry } from "../../providers/registry.js";
import { shipSchema, type ShipInput } from "./schema.js";
import type { ShipHandlerContext, ApprovedPlanBinding } from "./contracts.js";
import { mintCapability } from "../../boundary/capability.js";
import type { CredentialVault } from "../../boundary/vault.js";

export type { ShipInput } from "./schema.js";
export { shipSchema } from "./schema.js";

/**
 * Map from provider id to its corresponding boundary resource name.
 * Used by runApprovedOperation to mint a capability scoped to the right resource.
 */
const PROVIDER_RESOURCE: Record<string, string> = {
  cloudflare: "cloudflare-deployment",
  vercel: "vercel-deployment",
  railway: "railway-deployment",
  neon: "neon-control-plane",
};

export function registerShip(
  pi: ExtensionAPI,
  registry: ApprovalRegistry,
  deps: {
    credentialSource?: import("../../deployment/credentials.js").CredentialSource;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    vault?: CredentialVault;
  } = {},
): void {
  pi.registerTool({
    name: "ship",
    label: "Ship Operations",
    description: "Validate, plan, apply, and inspect deployments",
    parameters: shipSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (!Value.Check(shipSchema, rawParams)) {
        throw err("E_CONFIG_INVALID", "ship parameters invalid");
      }
      const params = rawParams as ShipInput;
      const cwd = ctx.cwd;
      const { manifest, packageId } = await providerRegistry.loadManifest(cwd);
      const credentialSource = deps.credentialSource ?? (await import("../../deployment/credentials.js")).environmentSource();

      // Build runApprovedOperation when vault is available (exclusive mode).
      // Providers call this after authorization to mint a capability scoped to
      // the binding's plan and resource, then execute fn under that capability.
      const runApprovedOperation = deps.vault
        ? <T>(binding: ApprovedPlanBinding, fn: () => T): T => {
            const resource = PROVIDER_RESOURCE[binding.provider];
            if (!resource) {
              throw err("E_CONFIG_INVALID", `no boundary resource for provider: ${binding.provider}`);
            }
            const cap = mintCapability({
              resource,
              operation: "execute",
              planId: binding.planId,
              planDigest: binding.planDigest,
              riskLevel: "destructive",
            });
            return deps.vault!.runWithCapability(cap, fn);
          }
        : undefined;

      const handlerContext: ShipHandlerContext = {
        manifest,
        cwd,
        pi,
        ctx,
        registry,
        credentialSource,
        signal,
        fetchImpl: deps.fetchImpl,
        services: providerRegistry.services(cwd),
        runApprovedOperation,
      };

      const handler = providerRegistry.getShipOpsHandler(manifest);
      if (!handler) {
        throw err("E_PHASE_UNSUPPORTED", `ship.${params.action} not supported for ${packageId} provider`);
      }

      // Non-mutating actions (validate, plan, status, logs) run under vault's
      // trusted scope so protected credential reads are allowed without an
      // explicit capability. apply_plan is the one mutating action that must
      // go through runApprovedOperation inside the handler.
      const isMutating = params.action === "apply_plan";
      const invoke = () => handler(params, handlerContext);
      return isMutating
        ? invoke()
        : deps.vault ? deps.vault.runTrusted(invoke) : invoke();
    },
  });
}
