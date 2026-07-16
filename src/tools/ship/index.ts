import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import { providerRegistry } from "../../providers/registry.js";
import { shipSchema, type ShipInput } from "./schema.js";
import type { ShipHandlerContext, ApprovedPlanBinding } from "./contracts.js";
import type { ProviderRuntimeBinding } from "../../providers/capability-profile.js";
import { mintCapability } from "../../boundary/capability.js";
import type { CredentialVault } from "../../boundary/vault.js";
import { defendToolResult } from "../../defense/spotlight.js";

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

/**
 * Execute a function under a capability minted from an approved plan binding.
 * The capability is scoped to the provider's boundary resource and carries the
 * plan's id, digest, and a destructive risk level.
 *
 * @param vault - CredentialVault instance
 * @param binding - approved plan binding (provider, planId, planDigest)
 * @param fn - function to execute
 * @param resourceOverride - optional explicit boundary resource; defaults to PROVIDER_RESOURCE map
 */
export function executeApprovedOperation<T>(
  vault: CredentialVault,
  binding: ApprovedPlanBinding,
  fn: () => T,
  resourceOverride?: string,
): T {
  const resource = resourceOverride ?? PROVIDER_RESOURCE[binding.provider];
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
  return vault.runWithCapability(cap, fn);
}

export interface ShipRegistrationDeps {
  credentialSource?: import("../../deployment/credentials.js").CredentialSource;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  vault?: CredentialVault;
  /** Immutable binding from startup. When present, uses narrow profile schema and assertIntact guard. */
  binding?: ProviderRuntimeBinding;
  /** Explicit schema override. When binding is present, this is the composed profile schema. */
  parameters?: TSchema;
}

export function registerShip(
  pi: ExtensionAPI,
  registry: ApprovalRegistry,
  deps: ShipRegistrationDeps = {},
): void {
  const effectiveSchema = deps.parameters ?? shipSchema;

  pi.registerTool({
    name: "ship",
    label: "Ship Operations",
    description: "Validate, plan, apply, and inspect deployments",
    parameters: effectiveSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      // ── Drift guard (first dispatch statement) ───────────────────────
      if (deps.binding) {
        await deps.binding.assertIntact(ctx.cwd);
      }

      // ── Parameter validation ─────────────────────────────────────────
      if (!Value.Check(effectiveSchema, rawParams)) {
        throw err("E_CONFIG_INVALID", "ship parameters invalid");
      }
      const params = rawParams as ShipInput;
      const cwd = ctx.cwd;

      // ── Resolve manifest and package ──────────────────────────────────
      // When binding present, use its cached values. Otherwise fall back
      // to per-call registry load (legacy direct-call compat).
      let manifest: unknown;
      let packageId: string;
      if (deps.binding && deps.binding.manifest !== undefined) {
        manifest = deps.binding.manifest;
        packageId = deps.binding.package!.id;
      } else {
        const loaded = await providerRegistry.loadManifest(cwd);
        manifest = loaded.manifest;
        packageId = loaded.packageId;
      }

      const credentialSource = deps.credentialSource ?? (await import("../../deployment/credentials.js")).environmentSource();

      // Build runApprovedOperation when vault is available (exclusive mode).
      const runApprovedOperation = deps.vault
        ? <T>(binding: ApprovedPlanBinding, fn: () => T): T => {
            // When binding is present, verify plan provider matches selected package
            if (deps.binding && deps.binding.package && binding.provider !== deps.binding.package.id) {
              throw err("E_CONFIG_INVALID", `plan provider ${binding.provider} does not match selected package ${deps.binding.package.id}`);
            }
            const resourceOverride = deps.binding?.profile.boundaryResource;
            return executeApprovedOperation(deps.vault!, binding, fn, resourceOverride);
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
      const result = await (isMutating
        ? invoke()
        : deps.vault ? deps.vault.runTrusted(invoke) : invoke());

      // ── Defend externally-sourced results ───────────────────────────
      const shouldDefend =
        params.action === "logs" || params.action === "status";
      return shouldDefend ? defendToolResult(result) : result;
    },
  });
}
