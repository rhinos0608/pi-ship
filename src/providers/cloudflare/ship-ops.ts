/** Cloudflare ship handler. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestPlanApproval, type ApprovalRegistry } from "../../core/approval.js";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import { err } from "../../core/errors.js";
import type { ToolResult } from "../../core/types.js";
import { loadAppSecrets, type CredentialSource } from "../../deployment/credentials.js";
import type { ShipHandler, ShipHandlerContext } from "../../tools/ship/contracts.js";
import type { ShipInput } from "../../tools/ship/schema.js";
import type { RegistryServices } from "../contracts.js";
import { applyCloudflarePlan } from "./engine.js";
import { isCloudflareExecution, type CloudflareExecution } from "./execution.js";
import { isCloudflareManifest, type CloudflareManifest } from "./manifest.js";
import { buildCloudflareOperations, computeCloudflareFingerprint, computeCloudflarePlanDigest, isCloudflarePlan, type CloudflarePlan } from "./plan.js";
import { isCloudflareState, type CloudflareState } from "./state.js";

function requireState(value: unknown): CloudflareState {
  if (!isCloudflareState(value)) throw err("E_STATE_CONFLICT", "expected Cloudflare state");
  return value;
}

function requirePlan(value: unknown): CloudflarePlan {
  if (!isCloudflarePlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

function createExecution(
  pi: ExtensionAPI,
  cwd: string,
  manifest: CloudflareManifest,
  state: CloudflareState,
  credentialSource: CredentialSource,
  services: RegistryServices,
): CloudflareExecution {
  const execution = services.createExecution(manifest, {
    pi,
    credentialSource,
    state,
    cwd,
  });
  if (!isCloudflareExecution(execution)) {
    throw err("E_STATE_CONFLICT", "expected Cloudflare execution for manifest");
  }
  return execution;
}

async function planAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
  manifest: CloudflareManifest,
  params: Extract<ShipInput, { action: "plan" }>,
  credentialSource: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const environment = params.environment;
  const isRollback = "intent" in params && params.intent === "rollback";
  const state = requireState(await services.loadState("cloudflare"));
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, services);
  const auth = await runtime.checkAuth(signal);
  if (auth.status === "unverified") {
    throw err(
      auth.reason === "unauthorized" || auth.reason === "forbidden" ? "E_AUTH_MISSING" : "E_STATE_CONFLICT",
      auth.safeMessage,
      auth.retryable,
    );
  }

  const discovered = await runtime.discover({ workerName: manifest.name }, signal);
  if (discovered.status === "unverified") {
    throw err("E_STATE_CONFLICT", discovered.safeMessage, discovered.retryable);
  }

  const operations = buildCloudflareOperations(isRollback ? "rollback" : "deploy", environment, {
    workerName: manifest.name,
    accountId: manifest.accountId,
    secretNames: manifest.secrets ?? [],
    versionId: undefined,
    targetVersionId: isRollback ? params.targetReleaseId : undefined,
    source: manifest.source,
    mainModule: manifest.mainModule,
    compatibilityDate: manifest.compatibilityDate,
  });

  const accountFingerprint = computeCloudflareFingerprint({ kind: "user", id: manifest.accountId });
  const targetFingerprint = computeCloudflareFingerprint({ worker: manifest.name, accountId: manifest.accountId });
  const manifestFingerprint = computeCloudflareFingerprint({
    mainModule: manifest.mainModule,
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: manifest.compatibilityFlags,
    source: manifest.source,
  });
  const plan: CloudflarePlan = {
    version: 1,
    planId: `cf-${Date.now()}-${randomUUID().slice(0, 8)}`,
    planDigest: "",
    provider: "cloudflare",
    environment,
    intent: isRollback ? "rollback" : "deploy",
    identity: {
      account: { kind: "user", id: manifest.accountId },
      worker: { name: manifest.name },
    },
    accountFingerprint,
    targetFingerprint,
    manifestFingerprint,
    secretNames: manifest.secrets ?? [],
    operations,
    createdAt: new Date().toISOString(),
  };
  plan.planDigest = computeCloudflarePlanDigest(plan);

  await services.persistPlan("cloudflare", plan);
  const approval = await requestCloudflareApproval(ctx, plan, registry);
  if (approval.approved && approval.approvedAt) {
    await writeApprovalSidecar(cwd, plan.planId, plan.planDigest, approval.approvedAt, environment);
  }

  return {
    content: [{
      type: "text",
      text: `Plan ${plan.planId} created. Digest: ${plan.planDigest}. Approved: ${approval.approved}. Environment: ${environment}. Operations: ${plan.operations.length}.`,
    }],
    details: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      approved: approval.approved,
      environment,
      intent: isRollback ? "rollback" : "deploy",
      operationCount: plan.operations.length,
    },
  };
}

async function applyAction(
  pi: ExtensionAPI,
  cwd: string,
  manifest: CloudflareManifest,
  params: Extract<ShipInput, { action: "apply_plan" }>,
  credentialSource: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  services: RegistryServices,
  runApprovedOperation: ShipHandlerContext["runApprovedOperation"],
): Promise<ToolResult> {
  const plan = requirePlan(await services.loadPlan("cloudflare", params.planId));
  if (plan.planDigest !== params.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match stored plan");
  }
  const state = requireState(await services.loadState("cloudflare"));
  const runAfterAuthorization = runApprovedOperation
    ? <T>(fn: () => T) => runApprovedOperation({ provider: "cloudflare", planId: plan.planId, planDigest: plan.planDigest }, fn)
    : undefined;

  const updated = await applyCloudflarePlan({
    cwd,
    plan,
    manifest,
    suppliedDigest: params.planDigest,
    registry,
    createRuntime: () => {
      const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, services);
      return runtime;
    },
    loadSecrets: () => loadAppSecrets(credentialSource, plan.secretNames),
    stateStore: {
      load: async () => requireState(await services.loadState("cloudflare")),
      save: (next) => services.saveState("cloudflare", next),
    },
    signal,
    runAfterAuthorization,
  });

  return {
    content: [{
      type: "text",
      text: `Plan ${params.planId} applied. Worker: ${updated.worker?.name ?? "unknown"}.`,
    }],
    details: {
      planId: params.planId,
      planDigest: params.planDigest,
      workerName: updated.worker?.name,
      deploymentCount: updated.deployments.length,
    },
  };
}

async function statusAction(
  pi: ExtensionAPI,
  cwd: string,
  manifest: CloudflareManifest,
  credentialSource: CredentialSource,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireState(await services.loadState("cloudflare"));
  const lastDeployment = [...state.deployments].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!lastDeployment) {
    return { content: [{ type: "text", text: "No deployment found." }], details: {} };
  }
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, services);
  const statusResult = await runtime.status(lastDeployment.id, signal);
  if (statusResult.status === "unverified") {
    return {
      content: [{ type: "text", text: `Status unavailable: ${statusResult.safeMessage}` }],
      details: { deploymentId: lastDeployment.id, error: statusResult.safeMessage },
    };
  }
  return {
    content: [{ type: "text", text: `Worker status: ${statusResult.value}.` }],
    details: { deploymentId: lastDeployment.id, status: statusResult.value },
  };
}

async function logsAction(
  pi: ExtensionAPI,
  cwd: string,
  manifest: CloudflareManifest,
  credentialSource: CredentialSource,
  _params: Extract<ShipInput, { action: "logs" }>,
  signal: AbortSignal | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireState(await services.loadState("cloudflare"));
  const lastDeployment = [...state.deployments].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!lastDeployment) {
    return { content: [{ type: "text", text: "No deployment found." }], details: {} };
  }
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, services);
  const secretValues = Object.values(loadAppSecrets(credentialSource, manifest.secrets ?? []));
  const logResult = await runtime.logs(lastDeployment.id, { lines: 100, secretValues }, signal);
  if (logResult.status === "unverified") {
    return {
      content: [{ type: "text", text: `Logs unavailable: ${logResult.safeMessage}` }],
      details: { deploymentId: lastDeployment.id, error: logResult.safeMessage },
    };
  }
  return {
    content: [{ type: "text", text: logResult.value }],
    details: { deploymentId: lastDeployment.id },
  };
}

function requestCloudflareApproval(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">,
  plan: CloudflarePlan,
  registry: ApprovalRegistry,
) {
  const lines = [
    `Intent: ${plan.intent}`,
    `Provider: ${plan.provider}`,
    `Environment: ${plan.environment}`,
    `Worker: ${plan.identity.worker.name}`,
    `Account: ${plan.identity.account.kind}:${plan.identity.account.id}`,
    "Operations:",
    ...plan.operations.map((op) => `- ${op.kind}`),
  ];
  if (plan.secretNames.length > 0) {
    lines.push("Secrets (names only):", ...plan.secretNames.map((name) => `- ${name}`));
  }
  lines.push(`Plan digest: ${plan.planDigest}`);

  return requestPlanApproval(ctx, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    title: `Approve ${plan.intent} to ${plan.environment}?`,
    summary: lines.join("\n"),
    metadata: { domain: "deployment", risk: "destructive" },
  }, registry);
}

export const handleCloudflareShipOps: ShipHandler = async (params, context) => {
  const { manifest, cwd, pi, ctx, registry, credentialSource, signal, services } = context;
  if (!isCloudflareManifest(manifest)) throw err("E_CONFIG_INVALID", "Cloudflare handler requires Cloudflare manifest");
  const secretNames = (manifest as CloudflareManifest).secrets ?? [];
  const missingSecrets = secretNames.filter((name) => !credentialSource.get(name));
  const missingToken = !credentialSource.get("CLOUDFLARE_API_TOKEN");
  const missingAccountId = !credentialSource.get("CLOUDFLARE_ACCOUNT_ID");
  const allMissing = [
    ...(missingToken ? ["CLOUDFLARE_API_TOKEN"] : []),
    ...(missingAccountId ? ["CLOUDFLARE_ACCOUNT_ID"] : []),
    ...missingSecrets,
  ];

  switch (params.action) {
    case "validate":
      return {
        content: [{
          type: "text",
          text: `Manifest valid for ${(manifest as CloudflareManifest).name}. Provider: cloudflare. Missing: ${allMissing.join(", ") || "none"}.`,
        }],
        details: { provider: "cloudflare", worker: (manifest as CloudflareManifest).name, missingSecrets: allMissing },
      };
    case "plan":
      return planAction(pi, ctx, cwd, manifest as CloudflareManifest, params, credentialSource, registry, signal, services);
    case "apply_plan":
      return applyAction(pi, cwd, manifest as CloudflareManifest, params, credentialSource, registry, signal, services, context.runApprovedOperation);
    case "status":
      return statusAction(pi, cwd, manifest as CloudflareManifest, credentialSource, signal, services);
    case "logs":
      return logsAction(pi, cwd, manifest as CloudflareManifest, credentialSource, params, signal, services);
  }
};
