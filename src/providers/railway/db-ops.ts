/** Railway DB handler. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import type { Environment, ToolResult } from "../../core/types.js";
import { loadAppSecrets, type CredentialSource } from "../../deployment/credentials.js";
import type { DatabaseHandler } from "../../tools/db/contracts.js";
import type { RegistryServices } from "../contracts.js";
import { requestRailwayApproval } from "./approval.js";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import { authorizeRailwayPlanApply } from "./authorization.js";
import { applyRailwayPlan } from "./engine.js";
import { isRailwayExecution } from "./execution.js";
import { isRailwayManifest, type RailwayManifest } from "./manifest.js";
import { buildRailwayPlan, isRailwayPlan, type RailwayPlan } from "./plan.js";
import { isRailwayState, type LocalState } from "./state.js";

function requireManifest(value: unknown): RailwayManifest {
  if (!isRailwayManifest(value)) throw err("E_CONFIG_INVALID", "unexpected manifest type");
  return value;
}

function requireState(value: unknown): LocalState {
  if (!isRailwayState(value)) throw err("E_STATE_CONFLICT", "expected V1 Railway state");
  return value;
}

function requirePlan(value: unknown): RailwayPlan {
  if (!isRailwayPlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

async function planMigration(
  cwd: string,
  manifest: RailwayManifest,
  environment: Environment,
  ctx: ExtensionContext,
  registry: ApprovalRegistry,
  services: RegistryServices,
): Promise<ToolResult> {

  if (!manifest.db?.migrate?.command) {
    throw err("E_CONFIG_INVALID", "manifest missing db.migrate.command");
  }
  if (environment === "production" && !manifest.db.migrate.allowProductionMigrations) {
    throw err("E_APPROVAL_REQUIRED", "production migration requires db.migrate.allowProductionMigrations: true");
  }
  const state = requireState(await services.loadState("railway"));
  const plan = await buildRailwayPlan(cwd, manifest, environment, {
    intent: "migration",
    targetSnapshot: {
      projectId: state.projectId,
      projectName: state.projectName,
      environmentId: state.environmentId,
      environmentName: state.environmentName,
      serviceIds: state.serviceIds,
      serviceNames: state.serviceNames,
    },
  });
  await services.persistPlan("railway", plan);
  const approval = await requestRailwayApproval(ctx, plan, registry);
  if (approval.approved && approval.approvedAt) {
    await writeApprovalSidecar(cwd, plan.planId, plan.planDigest, approval.approvedAt, environment);
  }
  return {
    content: [{
      type: "text",
      text: `Migration plan ${plan.planId} created for ${environment}. Digest: ${plan.planDigest}. Approved: ${approval.approved}.`,
    }],
    details: { planId: plan.planId, planDigest: plan.planDigest, approved: approval.approved },
  };
}

async function applyMigration(
  pi: ExtensionAPI,
  cwd: string,
  manifest: RailwayManifest,
  environment: Environment,
  planId: string,
  planDigest: string,
  envReader: (names: string[]) => Record<string, string | undefined>,
  source: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  if (!manifest.db?.migrate?.command) {
    throw err("E_CONFIG_INVALID", "manifest missing db.migrate.command");
  }
  const plan = requirePlan(await services.loadPlan("railway", planId));
  // Plan environment must equal current operational environment
  if (plan.environment !== environment) {
    throw err("E_STATE_CONFLICT", "plan environment does not match current operational environment");
  }
  // Production legacy migration additionally requires PI_SHIP_ALLOW_PRODUCTION_DB_WRITES === 'true'
  if (plan.environment === "production" && source.get("PI_SHIP_ALLOW_PRODUCTION_DB_WRITES") !== "true") {
    throw err("E_APPROVAL_REQUIRED", "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES must be 'true' for production database writes");
  }
  const state = requireState(await services.loadState("railway"));
  await authorizeRailwayPlanApply({ registry, cwd, plan, suppliedDigest: planDigest, manifest, state, signal });
  const execution = services.createExecution(manifest, {
    pi,
    credentialSource: source,
    state,
    appSecretValues: Object.values(loadAppSecrets(source, plan.secretNames)),
  });
  if (!isRailwayExecution(execution)) {
    throw err("E_STATE_CONFLICT", "Railway manifest resolved to a non-Railway execution");
  }
  return applyRailwayPlan({
    adapter: execution.adapter,
    manifest: plan.manifest,
    plan,
    cwd,
    envReader,
    piExec: pi.exec.bind(pi),
    registry,
    suppliedDigest: planDigest,
    stateStore: {
      load: async () => requireState(await services.loadState("railway")),
      save: (next) => services.saveState("railway", next),
    },
    signal,
  });
}

export const handleRailwayDatabaseOps: DatabaseHandler = async (params, context) => {
  const { cwd, pi, ctx, registry, credentialSource, environment, signal, services } = context;
  const manifest = requireManifest(context.manifest);
  const envReader = (names: string[]) => {
    const output: Record<string, string | undefined> = {};
    for (const name of names) output[name] = credentialSource.get(name);
    return output;
  };

  switch (params.action) {
    case "plan_migration":
      return planMigration(cwd, manifest, environment, ctx, registry, services);
    case "apply_plan":
      return applyMigration(pi, cwd, manifest, environment, params.planId, params.planDigest, envReader, credentialSource, registry, signal, services);
    default:
      throw err("E_PHASE_UNSUPPORTED", `DB.${params.action} is unsupported via Railway provider`);
  }
};
