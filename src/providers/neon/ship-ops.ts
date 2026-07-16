/** Neon ship handler. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import type { ApprovalRegistry } from "../../core/approval.js";
import { requestPlanApproval } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import type { ToolResult } from "../../core/types.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import type { RegistryServices } from "../contracts.js";
import type { ShipHandler, ShipHandlerContext } from "../../tools/ship/contracts.js";
import type { ShipInput } from "../../tools/ship/schema.js";
import { authorizeNeonPlanApply } from "./authorization.js";
import { applyNeonPlan } from "./engine.js";
import { isNeonManifest, type NeonManifest } from "./manifest.js";
import { buildNeonPlan, isNeonPlan, type NeonPlan } from "./plan.js";
import { isNeonExecution } from "./execution.js";
import { isNeonState, type NeonState } from "./state.js";

function requireNeonManifest(value: unknown): NeonManifest {
  if (!isNeonManifest(value)) throw err("E_CONFIG_INVALID", "unexpected manifest type");
  return value;
}

function requireNeonState(value: unknown): NeonState {
  if (!isNeonState(value)) throw err("E_STATE_CONFLICT", "expected V1 Neon state");
  return value;
}

function requireNeonPlan(value: unknown): NeonPlan {
  if (!isNeonPlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

function snapshot(state: NeonState) {
  return {
    projectId: state.projectId,
    projectName: state.projectName,
    branchIds: state.branchIds,
    connectionUris: state.connectionUris,
  };
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

function renderNeonPlanSummary(plan: NeonPlan): string {
  const lines = [
    `Intent: ${plan.intent}`,
    `Environment: ${plan.environment}`,
    `Provider: ${plan.provider}`,
    `Plan digest: ${plan.planDigest}`,
  ];
  if (plan.migrationCommand) lines.push(`Migration: ${plan.migrationCommand.join(" ")}`);
  if (plan.previewExpiresAt) lines.push(`Preview expires: ${plan.previewExpiresAt}`);
  if (plan.restoreTimestamp) lines.push(`Restore point: ${plan.restoreTimestamp}`);
  if (plan.sourceBranchId) lines.push(`Source branch: ${plan.sourceBranchId}`);
  if (plan.targetBranchId) lines.push(`Target branch: ${plan.targetBranchId}`);
  return lines.join("\n");
}

async function validateAction(
  manifest: NeonManifest,
  envReader: (names: string[]) => Record<string, string | undefined>,
): Promise<ToolResult> {
  const apiKey = envReader(["NEON_API_KEY"])["NEON_API_KEY"];
  const missing = apiKey ? [] : ["NEON_API_KEY"];
  return {
    content: [{
      type: "text",
      text: `Neon manifest valid for project ${manifest.project}. Missing: ${missing.join(", ") || "none"}.`,
    }],
    details: { missingSecrets: missing },
  };
}

async function planAction(
  ctx: ExtensionContext,
  cwd: string,
  manifest: NeonManifest,
  params: Extract<ShipInput, { action: "plan" }>,
  registry: ApprovalRegistry,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireNeonState(await services.loadState("neon"));
  const environment = params.environment;
  const isRollback = "intent" in params && params.intent === "rollback";
  // Resolve branch name early (needed for rollback plan too)
  const branchName = manifest.branch?.name ?? manifest.project;

  if (isRollback) {
    // Resolve targetReleaseId to owned restore point
    const targetReleaseId = (params as { targetReleaseId: string }).targetReleaseId;
    const candidatePoints = (state.restorePoints ?? []).filter((rp) => rp.planId === targetReleaseId);
    if (candidatePoints.length > 1) {
      throw err("E_PRECONDITION", `multiple restore points found for release ${targetReleaseId}; specify planDigest to disambiguate`);
    }
    // Match on planDigest if available in params; otherwise use the single match
    const planDigest = (params as { planDigest?: string }).planDigest;
    const restorePoint = planDigest
      ? candidatePoints.find((rp) => rp.planDigest === planDigest)
      : candidatePoints[0];
    if (!restorePoint) {
      throw err("E_PRECONDITION", `no owned restore point for release ${targetReleaseId}${planDigest ? ` digest ${planDigest}` : ""}`);
    }
    const plan = buildNeonPlan(manifest, environment, "rollback", {
      sourceBranchId: restorePoint.branchId,
      restoreTimestamp: restorePoint.timestamp,
      targetBranchId: state.branchIds[branchName],
    });
    // Digest binds restorePoint data — prevents substitution
    await services.persistPlan("neon", plan);
    const approval = await requestPlanApproval(ctx, {
      planId: plan.planId,
      planDigest: plan.planDigest,
      title: `Approve rollback to ${environment}?`,
      summary: renderNeonPlanSummary(plan),
      metadata: { domain: "database", risk: "destructive" },
    }, registry);
    if (approval.approved && approval.approvedAt) {
      await writeApprovalSidecar(cwd, plan.planId, plan.planDigest, approval.approvedAt, environment);
    }
    return {
      content: [{ type: "text", text: `Plan ${plan.planId} created. Digest: ${plan.planDigest}. Approved: ${approval.approved}.` }],
      details: { planId: plan.planId, planDigest: plan.planDigest, approved: approval.approved },
    };
  }

  // Determine intent based on manifest and environment.
  // Provision takes priority when no project exists, even if migrations are configured.
  let intent: "provision" | "migration" | "preview" = "provision";
  if (environment === "preview" && state.projectId) {
    intent = "preview";
  } else if (!state.projectId) {
    intent = "provision";
  } else if (manifest.migrations?.command) {
    intent = "migration";
  }

  const plan = buildNeonPlan(manifest, environment, intent, {
    migrationCommand: manifest.migrations?.command,
    previewExpiresAt: environment === "preview"
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : undefined,
  });

  await services.persistPlan("neon", plan);

  const approval = await requestPlanApproval(ctx, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    title: `Approve ${intent} to ${environment}?`,
    summary: renderNeonPlanSummary(plan),
    metadata: { domain: "database", risk: "destructive" },
  }, registry);

  if (approval.approved && approval.approvedAt) {
    await writeApprovalSidecar(cwd, plan.planId, plan.planDigest, approval.approvedAt, environment);
  }

  return {
    content: [{
      type: "text",
      text: `Plan ${plan.planId} created. Digest: ${plan.planDigest}. Approved: ${approval.approved}.`,
    }],
    details: { planId: plan.planId, planDigest: plan.planDigest, approved: approval.approved },
  };
}

async function applyAction(
  pi: ExtensionAPI,
  cwd: string,
  manifest: NeonManifest,
  planId: string,
  planDigest: string,
  source: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  services: RegistryServices,
  runApprovedOperation: ShipHandlerContext["runApprovedOperation"],
): Promise<ToolResult> {
  const plan = requireNeonPlan(await services.loadPlan("neon", planId));
  const state = requireNeonState(await services.loadState("neon"));
  if (plan.environment === "production" && plan.intent === "migration" && source.get("PI_SHIP_ALLOW_PRODUCTION_DB_WRITES") !== "true") {
    throw err("E_APPROVAL_REQUIRED", "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES must be 'true' for production database writes");
  }
  await authorizeNeonPlanApply({ registry, cwd, plan, manifest, state, suppliedDigest: planDigest, signal });

  const doApply = () => {
    const adapter = createNeonExecution(pi, manifest, state, source, services);
    const envReader = (names: string[]) => {
      const values: Record<string, string | undefined> = {};
      for (const name of names) values[name] = source.get(name);
      return values;
    };
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
        load: async () => requireNeonState(await services.loadState("neon")),
        save: (next) => services.saveState("neon", next),
      },
      signal,
    });
  };
  return runApprovedOperation
    ? runApprovedOperation({ provider: "neon", planId: plan.planId, planDigest: plan.planDigest }, doApply)
    : doApply();
}

async function statusAction(
  pi: ExtensionAPI,
  manifest: NeonManifest,
  source: CredentialSource,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireNeonState(await services.loadState("neon"));
  if (!state.projectId) {
    return { content: [{ type: "text", text: "No Neon project provisioned." }], details: {} };
  }
  const adapter = createNeonExecution(pi, manifest, state, source, services);
  const auth = await adapter.checkAuth(signal);
  return {
    content: [{
      type: "text",
      text: `Neon project: ${state.projectName ?? state.projectId}. Auth: ${auth.ok ? "OK" : "FAILED"}. Branches: ${Object.keys(state.branchIds).length}.`,
    }],
    details: {
      projectId: state.projectId,
      projectName: state.projectName,
      authOk: auth.ok,
      branchCount: Object.keys(state.branchIds).length,
    },
  };
}

async function logsAction(
  _pi: ExtensionAPI,
  _manifest: NeonManifest,
  _source: CredentialSource,
  _signal: AbortSignal | undefined,
  _services: RegistryServices,
): Promise<ToolResult> {
  return { content: [{ type: "text", text: "Neon logs not supported via ship handler; use Neon Console." }], details: {} };
}

export const handleNeonShipOps: ShipHandler = async (params, context) => {
  const { cwd, pi, ctx, registry, credentialSource, signal, services } = context;
  const manifest = requireNeonManifest(context.manifest);
  const envReader = (names: string[]) => {
    const values: Record<string, string | undefined> = {};
    for (const name of names) values[name] = credentialSource.get(name);
    return values;
  };

  switch (params.action) {
    case "validate":
      return validateAction(manifest, envReader);
    case "plan":
      return planAction(ctx, cwd, manifest, params, registry, services);
    case "apply_plan":
      return applyAction(pi, cwd, manifest, params.planId, params.planDigest, credentialSource, registry, signal, services, context.runApprovedOperation);
    case "status":
      return statusAction(pi, manifest, credentialSource, signal, services);
    case "logs":
      return logsAction(pi, manifest, credentialSource, signal, services);
  }
};
