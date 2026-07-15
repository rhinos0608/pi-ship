/** Neon DB handler. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../../core/approval.js";
import { requestPlanApproval } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import type { Environment, ToolResult } from "../../core/types.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import type { DatabaseHandler } from "../../tools/db/contracts.js";
import type { RegistryServices } from "../contracts.js";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import { authorizeNeonPlanApply } from "./authorization.js";
import { applyNeonPlan } from "./engine.js";
import { isNeonExecution } from "./execution.js";
import { isNeonManifest, type NeonManifest } from "./manifest.js";
import { buildNeonPlan, isNeonPlan, type NeonPlan } from "./plan.js";
import { isNeonState, type NeonState } from "./state.js";

function requireManifest(value: unknown): NeonManifest {
  if (!isNeonManifest(value)) throw err("E_CONFIG_INVALID", "unexpected manifest type");
  return value;
}

function requireState(value: unknown): NeonState {
  if (!isNeonState(value)) throw err("E_STATE_CONFLICT", "expected V1 Neon state");
  return value;
}

function requirePlan(value: unknown): NeonPlan {
  if (!isNeonPlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

function renderNeonPlanSummary(plan: NeonPlan): string {
  const lines = [
    `Intent: ${plan.intent}`,
    `Environment: ${plan.environment}`,
    `Provider: ${plan.provider}`,
    `Plan digest: ${plan.planDigest}`,
  ];
  if (plan.migrationCommand) lines.push(`Migration: ${plan.migrationCommand.join(" ")}`);
  return lines.join("\n");
}

function createNeonExecution(
  pi: ExtensionAPI,
  manifest: NeonManifest,
  state: NeonState,
  source: CredentialSource,
  services: RegistryServices,
): import("./adapter.js").NeonAdapter {
  const execution = services.createExecution(manifest, {
    pi,
    credentialSource: source,
    state,
  });
  if (!isNeonExecution(execution)) {
    throw err("E_STATE_CONFLICT", "Neon manifest resolved to a non-Neon execution");
  }
  return execution.adapter;
}

async function planMigration(
  cwd: string,
  manifest: NeonManifest,
  environment: Environment,
  ctx: ExtensionContext,
  registry: ApprovalRegistry,
  services: RegistryServices,
): Promise<ToolResult> {
  if (!manifest.migrations?.command) {
    throw err("E_CONFIG_INVALID", "manifest missing migrations.command");
  }

  if (environment === "production") {
    throw err("E_APPROVAL_REQUIRED", "production migration requires explicit approval");
  }

  const state = requireState(await services.loadState("neon"));
  const plan = buildNeonPlan(manifest, environment, "migration", {
    migrationCommand: manifest.migrations.command,
  });

  await services.persistPlan("neon", plan);

  const approval = await requestPlanApproval(ctx, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    title: `Approve migration to ${environment}?`,
    summary: renderNeonPlanSummary(plan),
    metadata: { domain: "database", risk: "destructive" },
  }, registry);

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
  manifest: NeonManifest,
  environment: Environment,
  planId: string,
  planDigest: string,
  envReader: (names: string[]) => Record<string, string | undefined>,
  source: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  if (!manifest.migrations?.command) {
    throw err("E_CONFIG_INVALID", "manifest missing migrations.command");
  }

  const plan = requirePlan(await services.loadPlan("neon", planId));
  if (plan.environment !== environment) {
    throw err("E_STATE_CONFLICT", "plan environment does not match current operational environment");
  }

  if (plan.environment === "production" && source.get("PI_SHIP_ALLOW_PRODUCTION_DB_WRITES") !== "true") {
    throw err("E_APPROVAL_REQUIRED", "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES must be 'true' for production database writes");
  }

  const state = requireState(await services.loadState("neon"));
  await authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: planDigest, signal });

  const adapter = createNeonExecution(pi, manifest, state, source, services);

  return applyNeonPlan({
    adapter,
    manifest: plan.manifest,
    plan,
    cwd,
    envReader,
    piExec: pi.exec.bind(pi),
    registry,
    suppliedDigest: planDigest,
    stateStore: {
      load: async () => requireState(await services.loadState("neon")),
      save: (next) => services.saveState("neon", next),
    },
    signal,
  });
}

export const handleNeonDatabaseOps: DatabaseHandler = async (params, context) => {
  const { cwd, pi, ctx, registry, credentialSource, environment, signal, services } = context;
  const manifest = requireManifest(context.manifest);
  const envReader = (names: string[]) => {
    const output: Record<string, string | undefined> = {};
    for (const name of names) output[name] = credentialSource.get(name);
    return output;
  };

  switch (params.action) {
    case "inspect":
      return { content: [{ type: "text", text: "Database inspection unavailable via Neon provider." }], details: {} };
    case "migration_status":
      return { content: [{ type: "text", text: "Migration status requires database connection." }], details: {} };
    case "browse":
    case "query":
    case "plan":
      throw err("E_PHASE_UNSUPPORTED", `DB.${params.action} is unsupported via Neon provider`);
    case "plan_migration":
      return planMigration(cwd, manifest, environment, ctx, registry, services);
    case "apply_plan":
      return applyMigration(pi, cwd, manifest, environment, params.planId, params.planDigest, envReader, credentialSource, registry, signal, services);
  }
};
