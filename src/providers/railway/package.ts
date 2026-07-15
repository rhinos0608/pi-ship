import { err } from "../../core/errors.js";
import type { ProviderPackage } from "../contracts.js";
import { createRailwayAdapter } from "./adapter.js";
import { loadRailwayCredentials } from "./credentials.js";
import { registerRailwayCommands } from "./commands.js";
import { handleRailwayDatabaseOps } from "./db-ops.js";
import { isRailwayManifest, validateRailwayManifest } from "./manifest.js";
import { computeDigest, isRailwayPlan } from "./plan.js";
import { handleRailwayShipOps } from "./ship-ops.js";
import { defaultState, isRailwayState } from "./state.js";
import type { RailwayExecution } from "./execution.js";
export { isRailwayExecution, type RailwayExecution } from "./execution.js";

export const railwayPackage: ProviderPackage = {
  id: "railway",
  isManifest: isRailwayManifest,
  isPlan: isRailwayPlan,
  isState: isRailwayState,
  validateManifest: validateRailwayManifest,
  computePlanDigest: computeDigest,
  defaultState,
  stateInvalidSaveMessage: "state has invalid shape",
  conflictMessage: {
    loadStateFromOther: "state.json contains V2 state; V1 caller cannot load it",
    saveStateOverOther: "cannot overwrite V2 state with V1 state",
    loadPlanFromOther: "V2 plan requires loadPlanV2",
  },
  createExecution(manifest, options): RailwayExecution {
    if (!isRailwayManifest(manifest)) {
      throw err("E_CONFIG_INVALID", "Railway execution requires a V1 manifest");
    }
    if (options.state !== undefined && !isRailwayState(options.state)) {
      throw err("E_STATE_CONFLICT", "Railway factory requires V1 state");
    }
    const credentials = loadRailwayCredentials(options.credentialSource);
    const state = options.state !== undefined && isRailwayState(options.state) ? options.state : undefined;
    return {
      provider: "railway",
      contract: 1,
      adapter: createRailwayAdapter(options.pi, {
        apiToken: credentials.apiToken,
        projectToken: credentials.projectToken,
        projectId: state?.projectId,
        environmentId: state?.environmentId,
        serviceId: state?.serviceIds.app,
        secretValues: options.appSecretValues ? [...options.appSecretValues] : undefined,
      }),
    };
  },
  registerCommands: registerRailwayCommands,
  getShipOpsHandler: (manifest) => isRailwayManifest(manifest) ? handleRailwayShipOps : undefined,
  getDatabaseOpsHandler: (manifest) => isRailwayManifest(manifest) ? handleRailwayDatabaseOps : undefined,
};

export const railwayProviderPackage = railwayPackage;
