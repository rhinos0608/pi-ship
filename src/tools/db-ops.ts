import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApprovalRegistry, requestApproval } from "../core/approval.js";
import { err } from "../core/errors.js";
import { applyPlan } from "../core/engine.js";
import { loadManifest } from "../core/manifest.js";
import { buildPlan } from "../core/plan.js";
import { loadPlan, persistPlan, verifyDigest } from "../core/plan-store.js";
import { loadState } from "../core/state.js";
import { authorizePlanApply } from "../core/authorization.js";
import type { Environment, ToolResult } from "../core/types.js";
import { createRailwayAdapter } from "../providers/railway/index.js";

export const dbOpsSchema = Type.Union(
  [
    Type.Object({ action: Type.Literal("inspect") }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("migration_status") }, { additionalProperties: false }),
    Type.Object(
      {
        action: Type.Literal("provision"),
        environment: Type.Union([
          Type.Literal("development"),
          Type.Literal("preview"),
          Type.Literal("production"),
        ]),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        action: Type.Literal("plan_migration"),
        environment: Type.Union([
          Type.Literal("development"),
          Type.Literal("preview"),
          Type.Literal("production"),
        ]),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        action: Type.Literal("apply_plan"),
        planId: Type.String({ minLength: 1 }),
        planDigest: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
  ]
);

export type DbOpsInput = Static<typeof dbOpsSchema>;

export function registerDbOps(pi: ExtensionAPI, registry: ApprovalRegistry): void {
  pi.registerTool({
    name: "db_ops",
    label: "Database Operations",
    description: "Plan and apply database migrations; provisioning is unsupported in MVP",
    parameters: dbOpsSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (!Value.Check(dbOpsSchema, rawParams)) {
        throw err("E_CONFIG_INVALID", "db_ops parameters invalid");
      }
      const params = rawParams as DbOpsInput;
      const cwd = ctx.cwd;
      const manifest = await loadManifest(cwd);
      const envReader = (names: string[]) => {
        const out: Record<string, string | undefined> = {};
        for (const n of names) out[n] = process.env[n];
        return out;
      };

      switch (params.action) {
        case "inspect":
          return { content: [{ type: "text", text: "Database inspection unavailable without provider query." }], details: {} };
        case "migration_status":
          return { content: [{ type: "text", text: "Migration status requires provider deployment metadata." }], details: {} };
        case "provision":
          return provision(params.environment);
        case "plan_migration":
          return planMigration(cwd, manifest, params.environment, ctx, registry);
        case "apply_plan":
          return applyMigration(pi, cwd, manifest, params.planId, params.planDigest, envReader, registry, signal);
      }
    },
  });
}

function provision(_environment: Environment): ToolResult {
  throw err("E_PHASE_UNSUPPORTED", "db_ops.provision is unsupported in MVP; use existing DATABASE_URL");
}

async function planMigration(
  cwd: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  environment: Environment,
  ctx: ExtensionContext,
  registry: ApprovalRegistry
): Promise<ToolResult> {
  if (environment === "preview") {
    throw err("E_PHASE_UNSUPPORTED", "preview environment is not supported in MVP");
  }
  if (!manifest.db?.migrate?.command) {
    throw err("E_CONFIG_INVALID", "manifest missing db.migrate.command");
  }
  if (environment === "production" && !(manifest.db.migrate.allowProductionMigrations)) {
    throw err("E_APPROVAL_REQUIRED", "production migration requires db.migrate.allowProductionMigrations: true");
  }
  const state = await loadState(cwd);
  const plan = await buildPlan(cwd, manifest, environment, { intent: "migration", targetSnapshot: { projectId: state.projectId, projectName: state.projectName, environmentId: state.environmentId, environmentName: state.environmentName, serviceIds: state.serviceIds, serviceNames: state.serviceNames } });
  await persistPlan(cwd, plan);
  const approval = await requestApproval(ctx, plan, registry);
  return {
    content: [
      {
        type: "text",
        text: `Migration plan ${plan.planId} created for ${environment}. Digest: ${plan.planDigest}. Approved: ${approval.approved}.`,
      },
    ],
    details: { planId: plan.planId, planDigest: plan.planDigest, approved: approval.approved },
  };
}

async function applyMigration(
  pi: ExtensionAPI,
  cwd: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  planId: string,
  planDigest: string,
  envReader: (names: string[]) => Record<string, string | undefined>,
  registry: ApprovalRegistry,
  signal?: AbortSignal
): Promise<ToolResult> {
  if (!manifest.db?.migrate?.command) {
    throw err("E_CONFIG_INVALID", "manifest missing db.migrate.command");
  }
  const plan = await loadPlan(cwd, planId);
  await authorizePlanApply({ registry, cwd, plan, suppliedDigest: planDigest, manifest, signal });
  const state = await loadState(cwd);
  const adapter = createRailwayAdapter(pi, {
    apiToken: process.env.RAILWAY_API_TOKEN,
    projectToken: process.env.RAILWAY_TOKEN,
    projectId: state.projectId,
    environmentId: state.environmentId,
    serviceId: state.serviceIds.app,
    secretValues: plan.secretNames.map((n) => process.env[n]).filter((v): v is string => !!v),
  });
  return applyPlan({ adapter, manifest: plan.manifest, plan, cwd, envReader, piExec: pi.exec.bind(pi), registry, suppliedDigest: planDigest, signal });
}
