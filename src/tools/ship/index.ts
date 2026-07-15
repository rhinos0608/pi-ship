import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import { providerRegistry } from "../../providers/registry.js";
import { shipSchema, type ShipInput } from "./schema.js";
import type { ShipHandlerContext } from "./contracts.js";

export type { ShipInput } from "./schema.js";
export { shipSchema } from "./schema.js";

export function registerShip(
  pi: ExtensionAPI,
  registry: ApprovalRegistry,
  deps: { credentialSource?: import("../../deployment/credentials.js").CredentialSource; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> } = {},
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
      };

      const handler = providerRegistry.getShipOpsHandler(manifest);
      if (!handler) {
        throw err("E_PHASE_UNSUPPORTED", `ship.${params.action} not supported for ${packageId} provider`);
      }
      return handler(params, handlerContext);
    },
  });
}
