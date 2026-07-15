/** Railway ship handler. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import type { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import type { ToolResult } from "../../core/types.js";
import { loadAppSecrets, type CredentialSource } from "../../deployment/credentials.js";
import type { RegistryServices } from "../contracts.js";
import type { ShipHandler } from "../../tools/ship/contracts.js";
import type { ShipInput } from "../../tools/ship/schema.js";
import type { ProviderAdapter } from "./adapter.js";
import { requestRailwayApproval } from "./approval.js";
import { authorizeRailwayPlanApply } from "./authorization.js";
import { applyRailwayPlan } from "./engine.js";
import { isRailwayManifest, type RailwayManifest } from "./manifest.js";
import { buildRailwayPlan, isRailwayPlan, type RailwayPlan } from "./plan.js";
import { isRailwayExecution } from "./execution.js";
import { isRailwayState, type LocalState } from "./state.js";

function requireRailwayManifest(value: unknown): RailwayManifest {
  if (!isRailwayManifest(value)) throw err("E_CONFIG_INVALID", "unexpected manifest type");
  return value;
}

function requireRailwayState(value: unknown): LocalState {
  if (!isRailwayState(value)) throw err("E_STATE_CONFLICT", "expected V1 Railway state");
  return value;
}

function requireRailwayPlan(value: unknown): RailwayPlan {
  if (!isRailwayPlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

function snapshot(state: LocalState) {
  return {
    projectId: state.projectId,
    projectName: state.projectName,
    environmentId: state.environmentId,
    environmentName: state.environmentName,
    serviceIds: state.serviceIds,
    serviceNames: state.serviceNames,
  };
}

function createRailwayExecution(
  pi: ExtensionAPI,
  manifest: RailwayManifest,
  state: LocalState,
  source: CredentialSource,
  secretNames: readonly string[],
  services: RegistryServices,
): ProviderAdapter {
  const appSecretValues = Object.values(loadAppSecrets(source, secretNames));
  const execution = services.createExecution(manifest, {
    pi,
    credentialSource: source,
    state,
    appSecretValues,
  });
  if (!isRailwayExecution(execution)) {
    throw err("E_STATE_CONFLICT", "Railway manifest resolved to a non-Railway execution");
  }
  return execution.adapter;
}

async function validateAction(
  manifest: RailwayManifest,
  envReader: (names: string[]) => Record<string, string | undefined>,
): Promise<ToolResult> {
  const missing = (manifest.secrets ?? []).filter((name) => !envReader([name])[name]);
  return {
    content: [{
      type: "text",
      text: `Manifest valid for ${manifest.name}. Project: ${manifest.project}. Missing secrets: ${missing.join(", ") || "none"}.`,
    }],
    details: { missingSecrets: missing },
  };
}

async function planAction(
  ctx: ExtensionContext,
  cwd: string,
  manifest: RailwayManifest,
  params: Extract<ShipInput, { action: "plan" }>,
  registry: ApprovalRegistry,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireRailwayState(await services.loadState("railway"));
  const environment = params.environment;
  const isRollback = "intent" in params && params.intent === "rollback";
  const plan = await buildRailwayPlan(cwd, manifest, environment, {
    intent: isRollback ? "rollback" : "deploy",
    targetReleaseId: isRollback ? params.targetReleaseId : undefined,
    targetSnapshot: snapshot(state),
  });
  await services.persistPlan("railway", plan);
  const approval = await requestRailwayApproval(ctx, plan, registry);
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
  manifest: RailwayManifest,
  planId: string,
  planDigest: string,
  envReader: (names: string[]) => Record<string, string | undefined>,
  source: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const plan = requireRailwayPlan(await services.loadPlan("railway", planId));
  const state = requireRailwayState(await services.loadState("railway"));
  await authorizeRailwayPlanApply({
    registry,
    cwd,
    plan,
    suppliedDigest: planDigest,
    manifest,
    state,
    signal,
  });
  const adapter = createRailwayExecution(pi, manifest, state, source, plan.secretNames, services);
  return applyRailwayPlan({
    adapter,
    manifest: plan.manifest,
    plan,
    cwd,
    envReader,
    piExec: pi.exec.bind(pi),
    registry,
    suppliedDigest: planDigest,
    stateStore: {
      load: async () => requireRailwayState(await services.loadState("railway")),
      save: (next) => services.saveState("railway", next),
    },
    signal,
  });
}

async function statusAction(
  pi: ExtensionAPI,
  manifest: RailwayManifest,
  source: CredentialSource,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireRailwayState(await services.loadState("railway"));
  if (!state.serviceIds.app) {
    return { content: [{ type: "text", text: "No deployed service found." }], details: {} };
  }
  const adapter = createRailwayExecution(pi, manifest, state, source, manifest.secrets ?? [], services);
  const result = await adapter.status(state.serviceIds.app, signal);
  return {
    content: [{ type: "text", text: `Service status: ${result.status}${result.url ? ` (${result.url})` : ""}` }],
    details: { status: result.status, ...(result.url ? { url: result.url } : {}) },
  };
}

async function logsAction(
  pi: ExtensionAPI,
  manifest: RailwayManifest,
  source: CredentialSource,
  lines: number,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireRailwayState(await services.loadState("railway"));
  if (!state.serviceIds.app) {
    return { content: [{ type: "text", text: "No deployed service found." }], details: {} };
  }
  const bounded = Number.isFinite(lines) ? Math.min(Math.max(Math.floor(lines), 1), 500) : 100;
  const adapter = createRailwayExecution(pi, manifest, state, source, manifest.secrets ?? [], services);
  const text = await adapter.logs(state.serviceIds.app, bounded, signal);
  return {
    content: [{ type: "text", text: text.length > 4000 ? `${text.slice(0, 4000)}\n...truncated` : text }],
    details: { lines: bounded },
  };
}

export const handleRailwayShipOps: ShipHandler = async (params, context) => {
  const { cwd, pi, ctx, registry, credentialSource, signal, services } = context;
  const manifest = requireRailwayManifest(context.manifest);
  if (params.action === "plan" && params.environment === "preview") {
    throw err("E_PHASE_UNSUPPORTED", "preview environment is not supported in MVP");
  }
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
      return applyAction(pi, cwd, manifest, params.planId, params.planDigest, envReader, credentialSource, registry, signal, services);
    case "status":
      return statusAction(pi, manifest, credentialSource, signal, services);
    case "logs":
      return logsAction(pi, manifest, credentialSource, params.lines ?? 100, signal, services);
  }
};
