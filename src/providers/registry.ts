import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { err } from "../core/errors.js";
import type { ApprovalRegistry } from "../core/approval.js";
import { loadManifestContract, loadProviderRuntimeBinding } from "../persistence/manifest-store.js";
import { readPlanFile, validateLoadedPlan, persistPlan as persistStoredPlan } from "../persistence/plan-store.js";
import { loadRegisteredState, saveRegisteredState } from "../persistence/state-store.js";
import type {
  ProviderCatalog,
  ProviderExecutionBase,
  ProviderExecutionOptions,
  ProviderId,
  ProviderPackage,
  RegistryServices,
} from "./contracts.js";
import type { ProviderCapabilityProfile, ProviderRuntimeBinding } from "./capability-profile.js";
import type { CredentialSource } from "../deployment/credentials.js";
import { environmentSource } from "../deployment/credentials.js";
import { railwayPackage } from "./railway/package.js";
import { vercelPackage } from "./vercel/package.js";
import { cloudflarePackage } from "./cloudflare/package.js";
import { neonPackage } from "./neon/package.js";

function duplicateIds(packages: readonly ProviderPackage[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const providerPackage of packages) {
    if (seen.has(providerPackage.id)) duplicates.add(providerPackage.id);
    seen.add(providerPackage.id);
  }
  return [...duplicates];
}

function requireUniquePackage(
  packages: readonly ProviderPackage[],
  value: unknown,
  predicate: (providerPackage: ProviderPackage, candidate: unknown) => boolean,
  kind: "manifest" | "plan" | "state",
): ProviderPackage | undefined {
  const matches = packages.filter((providerPackage) => predicate(providerPackage, value));
  if (matches.length > 1) {
    throw err("E_CONFIG_INVALID", `ambiguous ${kind} contract matched multiple provider packages`);
  }
  return matches[0];
}

export class ProviderRegistry implements ProviderCatalog {
  readonly packages: readonly ProviderPackage[];
  private readonly byId: ReadonlyMap<ProviderId, ProviderPackage>;

  constructor(packages: readonly ProviderPackage[]) {
    const duplicates = duplicateIds(packages);
    if (duplicates.length > 0) {
      throw err("E_CONFIG_INVALID", `duplicate provider package id: ${duplicates.join(", ")}`);
    }
    this.packages = [...packages];
    this.byId = new Map(packages.map((providerPackage) => [providerPackage.id, providerPackage]));
  }

  ids(): readonly ProviderId[] {
    return this.packages.map((providerPackage) => providerPackage.id);
  }

  async loadRuntimeBinding(cwd: string): Promise<ProviderRuntimeBinding> {
    return loadProviderRuntimeBinding(cwd, this.packages);
  }

  packageFor(packageId: ProviderId): ProviderPackage {
    const providerPackage = this.byId.get(packageId);
    if (!providerPackage) throw err("E_PROVIDER", `unsupported provider package: ${packageId}`);
    return providerPackage;
  }

  resolveManifest(manifest: unknown): ProviderPackage {
    const providerPackage = requireUniquePackage(
      this.packages,
      manifest,
      (candidate, value) => candidate.isManifest(value),
      "manifest",
    );
    if (!providerPackage) throw err("E_CONFIG_INVALID", "unsupported manifest provider/version");
    return providerPackage;
  }

  resolvePlan(plan: unknown): ProviderPackage {
    const providerPackage = requireUniquePackage(
      this.packages,
      plan,
      (candidate, value) => candidate.isPlan(value),
      "plan",
    );
    if (!providerPackage) throw err("E_CONFIG_INVALID", "plan has invalid shape");
    return providerPackage;
  }

  createExecution(manifest: unknown, options: ProviderExecutionOptions): ProviderExecutionBase {
    const providerPackage = this.resolveManifest(manifest);
    if (!providerPackage.createExecution) {
      throw err("E_PHASE_UNSUPPORTED", `provider ${providerPackage.id} has no execution runtime`);
    }
    return providerPackage.createExecution(manifest, options);
  }

  getShipOpsHandler(manifest: unknown) {
    return this.resolveManifest(manifest).getShipOpsHandler?.(manifest);
  }

  getDatabaseOpsHandler(manifest: unknown) {
    return this.resolveManifest(manifest).getDatabaseOpsHandler?.(manifest);
  }

  async loadManifest(cwd: string): Promise<{ manifest: unknown; packageId: ProviderId }> {
    const manifest = await loadManifestContract(cwd, this.packages);
    return { manifest, packageId: this.resolveManifest(manifest).id };
  }

  async loadState(cwd: string, packageId: ProviderId): Promise<unknown> {
    return loadRegisteredState(cwd, this.packageFor(packageId), this.packages);
  }

  async saveState(cwd: string, state: unknown, packageId: ProviderId): Promise<void> {
    await saveRegisteredState(cwd, state, this.packageFor(packageId), this.packages);
  }

  async loadPlan(cwd: string, packageId: ProviderId, planId: string): Promise<unknown> {
    const expected = this.packageFor(packageId);
    if (!expected.computePlanDigest) {
      throw err("E_PHASE_UNSUPPORTED", `provider ${packageId} has no plan persistence`);
    }
    const raw = await readPlanFile(cwd, planId);
    const owner = requireUniquePackage(
      this.packages,
      raw,
      (candidate, value) => candidate.isPlan(value),
      "plan",
    );
    if (!owner) throw err("E_CONFIG_INVALID", `plan ${planId} has invalid shape`);
    if (owner.id !== expected.id) {
      throw err("E_STATE_CONFLICT", expected.conflictMessage.loadPlanFromOther ?? "plan belongs to another provider package");
    }
    return validateLoadedPlan(raw, planId, {
      isValid: expected.isPlan,
      computeDigest: expected.computePlanDigest,
    });
  }

  async persistPlan(cwd: string, packageId: ProviderId, plan: unknown): Promise<void> {
    const expected = this.packageFor(packageId);
    if (!expected.computePlanDigest) {
      throw err("E_PHASE_UNSUPPORTED", `provider ${packageId} has no plan persistence`);
    }
    const owner = this.resolvePlan(plan);
    if (owner.id !== expected.id) throw err("E_CONFIG_INVALID", "plan has invalid shape");
    await persistStoredPlan(cwd, plan, {
      isValid: expected.isPlan,
      computeDigest: expected.computePlanDigest,
    });
  }

  services(cwd: string, binding?: ProviderRuntimeBinding, credentialSource?: CredentialSource): RegistryServices {
    const source = credentialSource ?? environmentSource();
    return {
      credentialSource: source,
      loadManifest: binding
        ? async () => {
            if (binding.manifest === undefined) {
              throw err("E_CONFIG_INVALID", "no manifest available in startup binding");
            }
            return binding.manifest;
          }
        : async () => (await this.loadManifest(cwd)).manifest,
      loadState: (packageId) => this.loadState(cwd, packageId),
      saveState: (packageId, state) => this.saveState(cwd, state, packageId),
      loadPlan: (packageId, planId) => this.loadPlan(cwd, packageId, planId),
      persistPlan: (packageId, plan) => this.persistPlan(cwd, packageId, plan),
      createExecution: (manifest, options) => this.createExecution(manifest, options),
    };
  }

  registerCommands(
    pi: ExtensionAPI,
    approvalRegistry: ApprovalRegistry,
    makeServices: (cwd: string) => RegistryServices,
    binding?: ProviderRuntimeBinding,
  ): void {
    // When a binding is provided, wrap registerCommand to reject undeclared
    // names and assert manifest integrity on every accepted handler dispatch.
    // Even when profile.commands is empty, the wrapper ensures undeclared
    // registration always rejects (fails closed for safety).
    const profile = binding?.profile;
    const effectivePi = binding
      ? wrapCommandAPI(pi, profile!, binding)
      : pi;
    const toRegister = binding?.package ? [binding.package] : this.packages;
    for (const providerPackage of toRegister) {
      providerPackage.registerCommands?.(effectivePi, approvalRegistry, makeServices);
    }
  }
}

/**
 * Build a proxy pi that wraps registerCommand to:
 * - Reject command names not in the profile's command list
 * - Wrap accepted handlers with assertIntact(ctx.cwd) as first dispatch statement
 */
function wrapCommandAPI(
  pi: ExtensionAPI,
  profile: ProviderCapabilityProfile,
  binding: ProviderRuntimeBinding,
): ExtensionAPI {
  const origRegisterCommand = pi.registerCommand.bind(pi);
  const wrappedRegisterCommand: ExtensionAPI['registerCommand'] = (name, options) => {
    if (!profile.commands.includes(name)) {
      throw err("E_CONFIG_INVALID", `command "${name}" not declared in provider profile`);
    }
    const origHandler = options.handler;
    origRegisterCommand(name, {
      ...options,
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        await binding.assertIntact(ctx.cwd);
        return origHandler(args, ctx);
      },
    });
  };
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "registerCommand") return wrappedRegisterCommand;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function createProviderRegistry(packages: readonly ProviderPackage[]): ProviderRegistry {
  return new ProviderRegistry(packages);
}

export const providerRegistry = createProviderRegistry([railwayPackage, vercelPackage, cloudflarePackage, neonPackage]);

export function createProviderExecution(
  manifest: unknown,
  options: ProviderExecutionOptions,
): ProviderExecutionBase {
  return providerRegistry.createExecution(manifest, options);
}
