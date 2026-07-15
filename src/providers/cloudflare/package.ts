/** Cloudflare package facade. Never imports another provider or registry. */
import { err } from "../../core/errors.js";
import type { ProviderExecutionOptions, ProviderPackage } from "../contracts.js";
import { createCloudflareClient } from "./client.js";
import { loadCloudflareCredentials } from "./credentials.js";
import { isCloudflareManifest, validateCloudflareManifest } from "./manifest.js";
import { computeCloudflarePlanDigest, isCloudflarePlan } from "./plan.js";
import { createCloudflareRuntime } from "./runtime.js";
import { handleCloudflareShipOps } from "./ship-ops.js";
import { defaultCloudflareState, isCloudflareState } from "./state.js";
import type { CloudflareExecution } from "./execution.js";
export { isCloudflareExecution, type CloudflareExecution } from "./execution.js";

function createExecution(manifest: unknown, options: ProviderExecutionOptions): CloudflareExecution {
  if (!isCloudflareManifest(manifest)) {
    throw err("E_CONFIG_INVALID", "Cloudflare factory requires Cloudflare manifest");
  }
  if (options.state !== undefined && !isCloudflareState(options.state)) {
    throw err("E_STATE_CONFLICT", "Cloudflare factory requires Cloudflare state");
  }
  const credentials = loadCloudflareCredentials(options.credentialSource);
  if (manifest.accountId !== credentials.accountId) {
    throw err("E_CONFIG_INVALID", `manifest account "${manifest.accountId}" does not match credentials account "${credentials.accountId}"`);
  }
  const client = createCloudflareClient({
    apiToken: credentials.apiToken,
    accountId: credentials.accountId,
  }, options.fetchImpl ?? fetch);
  const runtime = createCloudflareRuntime({
    client,
    accountId: credentials.accountId,
    cwd: options.cwd ?? "",
    workerName: manifest.name,
    mainModule: manifest.mainModule,
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: manifest.compatibilityFlags,
  });
  return { contract: 1, provider: "cloudflare", runtime, client };
}

export const cloudflarePackage: ProviderPackage = {
  id: "cloudflare",
  isManifest: isCloudflareManifest,
  validateManifest: validateCloudflareManifest,
  isPlan: isCloudflarePlan,
  isState: isCloudflareState,
  computePlanDigest: computeCloudflarePlanDigest,
  defaultState: defaultCloudflareState,
  stateInvalidSaveMessage: "Cloudflare state has invalid shape",
  conflictMessage: {
    loadStateFromOther: "state.json contains state from another provider; Cloudflare caller cannot load it",
    saveStateOverOther: "cannot overwrite another provider's state with Cloudflare state",
    loadPlanFromOther: "plan belongs to another provider package",
  },
  createExecution,
  getShipOpsHandler: (manifest) => isCloudflareManifest(manifest) ? handleCloudflareShipOps : undefined,
};

export const cloudflareProviderPackage = cloudflarePackage;
