/** Vercel package facade. Never imports another provider or registry. */
import { err } from "../../core/errors.js";
import type { ProviderExecutionOptions, ProviderPackage } from "../contracts.js";
import { vercelCapabilityProfile } from "../capability-profile.js";
import { createVercelClient } from "./client.js";
import { requireVercelCredentials } from "./credentials.js";
import { handleVercelDatabaseOps } from "./db-ops.js";
import { isVercelManifest, validateVercelManifestSemantics } from "./manifest.js";
import { computeVercelPlanDigest, isVercelPlan } from "./plan.js";
import { createVercelRuntime } from "./runtime.js";
import { handleVercelShipOps } from "./ship-ops.js";
import { defaultVercelState, isVercelState } from "./state.js";
import type { VercelExecution } from "./execution.js";
export { isVercelExecution, type VercelExecution } from "./execution.js";

function validateVercelManifest(manifest: unknown): void {
  if (!isVercelManifest(manifest)) {
    throw err("E_CONFIG_INVALID", "Vercel manifest has invalid shape");
  }
  validateVercelManifestSemantics(manifest);
}

function createExecution(manifest: unknown, options: ProviderExecutionOptions): VercelExecution {
  if (!isVercelManifest(manifest)) {
    throw err("E_CONFIG_INVALID", "Vercel factory requires V2 manifest");
  }
  if (!options.cwd) throw err("E_CONFIG_INVALID", "Vercel factory requires explicit cwd");
  if (options.state !== undefined && !isVercelState(options.state)) {
    throw err("E_STATE_CONFLICT", "Vercel factory requires V2 state");
  }
  const state = options.state !== undefined && isVercelState(options.state) ? options.state : undefined;
  const manifestTeamId = manifest.app.config.teamId;
  const stateAccount = state?.app?.account;
  if (manifestTeamId && stateAccount && (stateAccount.kind !== "team" || stateAccount.id !== manifestTeamId)) {
    throw err("E_STATE_CONFLICT", `manifest teamId "${manifestTeamId}" does not match persisted account binding`);
  }
  const effectiveTeamId = manifestTeamId ?? (stateAccount?.kind === "team" ? stateAccount.id : undefined);
  const credentials = requireVercelCredentials(options.credentialSource);
  const client = createVercelClient(
    { token: credentials.apiToken, teamId: effectiveTeamId },
    options.fetchImpl ?? fetch,
  );
  const runtime = createVercelRuntime({ client, cwd: options.cwd, teamId: effectiveTeamId });
  return { contract: 2, provider: "vercel", runtime, client };
}

export const vercelPackage: ProviderPackage = {
  id: "vercel",
  profile: vercelCapabilityProfile,
  isManifest: isVercelManifest,
  validateManifest: validateVercelManifest,
  isPlan: isVercelPlan,
  isState: isVercelState,
  computePlanDigest: computeVercelPlanDigest,
  defaultState: defaultVercelState,
  stateInvalidSaveMessage: "state V2 has invalid shape",
  conflictMessage: {
    loadStateFromOther: "state.json contains V1 state; V2 caller cannot load it",
    saveStateOverOther: "cannot overwrite V1 state with V2 state",
    loadPlanFromOther: "V1 plan requires loadPlan",
  },
  createExecution,
  getShipOpsHandler: (manifest) => isVercelManifest(manifest) ? handleVercelShipOps : undefined,
  getDatabaseOpsHandler: (manifest) => isVercelManifest(manifest) ? handleVercelDatabaseOps : undefined,
};

export const vercelProviderPackage = vercelPackage;
