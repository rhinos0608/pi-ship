import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApprovalRegistry, requestApproval } from "../core/approval.js";
import { writeApprovalSidecar } from "../core/approval-store.js";
import { err } from "../core/errors.js";
import { applyPlan } from "../core/engine.js";
import { loadManifest } from "../core/manifest.js";
import { buildPlan, type Plan } from "../core/plan.js";
import { loadPlan, persistPlan } from "../core/plan-store.js";
import { loadState } from "../core/state.js";
import { authorizePlanApply } from "../core/authorization.js";
import type { Environment, ToolResult } from "../core/types.js";
import { createRailwayAdapter } from "../providers/railway/index.js";

export const shipOpsSchema = Type.Union(
  [
    Type.Object(
      {
        action: Type.Literal("validate"),
      },
      { additionalProperties: false }

    ),
    Type.Object({ action: Type.Literal("plan"), environment: Type.Literal("production") }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("plan"), environment: Type.Literal("production"), intent: Type.Literal("rollback"), targetReleaseId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object(
      {
        action: Type.Literal("apply_plan"),
        planId: Type.String({ minLength: 1 }),
        planDigest: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        action: Type.Literal("status"),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        action: Type.Literal("logs"),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      },
      { additionalProperties: false }
    ),
  ]
);

export type ShipOpsInput = Static<typeof shipOpsSchema>;

export function registerShipOps(pi: ExtensionAPI, registry: ApprovalRegistry): void {
  pi.registerTool({
    name: "ship_ops",
    label: "Ship Operations",
    description: "Validate, plan, apply, and inspect Railway deployments",
    parameters: shipOpsSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (!Value.Check(shipOpsSchema, rawParams)) {
        throw err("E_CONFIG_INVALID", "ship_ops parameters invalid");
      }
      const params = rawParams as ShipOpsInput;
      const cwd = ctx.cwd;
      const manifest = await loadManifest(cwd);
      const envReader = (names: string[]) => {
        const out: Record<string, string | undefined> = {};
        for (const n of names) out[n] = process.env[n];
        return out;
      };

      switch (params.action) {
        case "validate":
          return validate(cwd, manifest, envReader);
        case "plan":
          return plan(pi, ctx, cwd, manifest, params, registry);
        case "apply_plan":
          return apply(pi, ctx, cwd, manifest, params.planId, params.planDigest, envReader, registry, signal);
        case "status":
          return status(pi, cwd, manifest, signal);
        case "logs":
          return logs(pi, cwd, manifest, params.lines ?? 100, signal);
      }
    },
  });
}

async function validate(
  cwd: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  envReader: (names: string[]) => Record<string, string | undefined>
): Promise<ToolResult> {
  const missing = (manifest.secrets ?? []).filter((n) => !envReader([n])[n]);
  return {
    content: [
      {
        type: "text",
        text: `Manifest valid for ${manifest.name}. Project: ${manifest.project}. Missing secrets: ${missing.join(", ") || "none"}.`,
      },
    ],
    details: { missingSecrets: missing },
  };
}

function snapshot(state: Awaited<ReturnType<typeof loadState>>) {
  return { projectId: state.projectId, projectName: state.projectName, environmentId: state.environmentId, environmentName: state.environmentName, serviceIds: state.serviceIds, serviceNames: state.serviceNames };
}

async function plan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  params: Extract<ShipOpsInput, { action: "plan" }>,
  registry: ApprovalRegistry
): Promise<ToolResult> {
  const state = await loadState(cwd);
  const environment = params.environment;
  const isRollback = "intent" in params && params.intent === "rollback";
  const p = await buildPlan(cwd, manifest, environment, { intent: isRollback ? "rollback" : "deploy", targetReleaseId: isRollback ? params.targetReleaseId : undefined, targetSnapshot: snapshot(state) });
  await persistPlan(cwd, p);
  const approval = await requestApproval(ctx, p, registry);
  if (approval.approved) {
    await writeApprovalSidecar(cwd, p.planId, p.planDigest, approval.approvedAt!, environment);
  }
  return {
    content: [
      {
        type: "text",
        text: `Plan ${p.planId} created. Digest: ${p.planDigest}. Approved: ${approval.approved}.`,
      },
    ],
    details: { planId: p.planId, planDigest: p.planDigest, approved: approval.approved },
  };
}

async function apply(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  cwd: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  planId: string,
  planDigest: string,
  envReader: (names: string[]) => Record<string, string | undefined>,
  registry: ApprovalRegistry,
  signal?: AbortSignal
): Promise<ToolResult> {
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

async function status(pi: ExtensionAPI, cwd: string, manifest: Awaited<ReturnType<typeof loadManifest>>, signal?: AbortSignal): Promise<ToolResult> {
  const state = await loadState(cwd);
  if (!state.serviceIds.app) {
    return { content: [{ type: "text", text: "No deployed service found." }], details: {} };
  }
  const adapter = createRailwayAdapter(pi, {
    apiToken: process.env.RAILWAY_API_TOKEN,
    projectToken: process.env.RAILWAY_TOKEN,
    projectId: state.projectId,
    environmentId: state.environmentId,
    serviceId: state.serviceIds.app,
    secretValues: [...(manifest.secrets ?? []).map((n) => process.env[n]), process.env.RAILWAY_API_TOKEN, process.env.RAILWAY_TOKEN].filter((v): v is string => !!v),
  });
  const s = await adapter.status(state.serviceIds.app, signal);
  return {
    content: [{ type: "text", text: `Service status: ${s.status}${s.url ? ` (${s.url})` : ""}` }],
    details: { status: s.status, ...(s.url ? { url: s.url } : {}) },
  };
}

async function logs(pi: ExtensionAPI, cwd: string, manifest: Awaited<ReturnType<typeof loadManifest>>, lines: number, signal?: AbortSignal): Promise<ToolResult> {
  const state = await loadState(cwd);
  if (!state.serviceIds.app) {
    return { content: [{ type: "text", text: "No deployed service found." }], details: {} };
  }
  const bounded = Number.isFinite(lines) ? Math.min(Math.max(Math.floor(lines), 1), 500) : 100;
  const adapter = createRailwayAdapter(pi, {
    apiToken: process.env.RAILWAY_API_TOKEN,
    projectToken: process.env.RAILWAY_TOKEN,
    projectId: state.projectId,
    environmentId: state.environmentId,
    serviceId: state.serviceIds.app,
    secretValues: [...(manifest.secrets ?? []).map((n) => process.env[n]), process.env.RAILWAY_API_TOKEN, process.env.RAILWAY_TOKEN].filter((v): v is string => !!v),
  });
  const text = await adapter.logs(state.serviceIds.app, bounded, signal);
  return {
    content: [{ type: "text", text: text.length > 4000 ? text.slice(0, 4000) + "\n...truncated" : text }],
    details: { lines: bounded },
  };
}
