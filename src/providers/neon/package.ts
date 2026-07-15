import { err } from "../../core/errors.js";
import type { ProviderPackage } from "../contracts.js";
import { createNeonAdapter } from "./adapter.js";
import { loadNeonCredentials } from "./credentials.js";
import { handleNeonDatabaseOps } from "./db-ops.js";
import { isNeonManifest, validateNeonManifest } from "./manifest.js";
import { computeDigest, isNeonPlan } from "./plan.js";
import { handleNeonShipOps } from "./ship-ops.js";
import { defaultNeonState, isNeonState } from "./state.js";
import type { NeonExecution } from "./execution.js";
export { isNeonExecution, type NeonExecution } from "./execution.js";

export const neonPackage: ProviderPackage = {
  id: "neon",
  isManifest: isNeonManifest,
  isPlan: isNeonPlan,
  isState: isNeonState,
  validateManifest: validateNeonManifest,
  computePlanDigest: computeDigest,
  defaultState: defaultNeonState,
  stateInvalidSaveMessage: "state has invalid shape",
  conflictMessage: {
    loadStateFromOther: "state.json contains V2 state; V1 caller cannot load it",
    saveStateOverOther: "cannot overwrite V2 state with V1 state",
    loadPlanFromOther: "V2 plan requires loadPlanV2",
  },
  createExecution(manifest, options): NeonExecution {
    if (!isNeonManifest(manifest)) {
      throw err("E_CONFIG_INVALID", "Neon execution requires a V1 manifest");
    }
    if (options.state !== undefined && !isNeonState(options.state)) {
      throw err("E_STATE_CONFLICT", "Neon factory requires V1 state");
    }
    const credentials = loadNeonCredentials(options.credentialSource);
    return {
      provider: "neon",
      contract: 1,
      adapter: createNeonAdapter(options.pi, {
        apiKey: credentials.apiKey,
      }),
    };
  },
  getShipOpsHandler: (manifest) => isNeonManifest(manifest) ? handleNeonShipOps : undefined,
  getDatabaseOpsHandler: (manifest) => isNeonManifest(manifest) ? handleNeonDatabaseOps : undefined,
};

export const neonProviderPackage = neonPackage;
