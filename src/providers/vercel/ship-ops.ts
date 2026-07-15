/** Vercel ship handler. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../../core/approval.js";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import { err } from "../../core/errors.js";
import { gatherGit } from "../../core/git.js";
import type { ToolResult } from "../../core/types.js";
import { loadAppSecrets, type CredentialSource } from "../../deployment/credentials.js";
import type { ShipHandler } from "../../tools/ship/contracts.js";
import type { ShipInput } from "../../tools/ship/schema.js";
import type { RegistryServices } from "../contracts.js";
import { requestVercelApproval } from "./approval.js";
import { applyVercelPlan } from "./engine.js";
import { isVercelExecution, type VercelExecution } from "./execution.js";
import { isVercelManifest, validateVercelManifestSemantics, type VercelManifest } from "./manifest.js";
import { buildVercelPlan, isVercelPlan, type LocalSourceRef, type VercelPlan } from "./plan.js";
import { enumerateSource } from "./source.js";
import { isVercelState, type VercelState } from "./state.js";

function requireState(value: unknown): VercelState {
  if (!isVercelState(value)) throw err("E_STATE_CONFLICT", "expected V2 Vercel state");
  return value;
}

function requirePlan(value: unknown): VercelPlan {
  if (!isVercelPlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

function createExecution(
  pi: ExtensionAPI,
  cwd: string,
  manifest: VercelManifest,
  state: VercelState,
  credentialSource: CredentialSource,
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  services: RegistryServices,
): VercelExecution {
  const execution = services.createExecution(manifest, {
    pi,
    credentialSource,
    state,
    cwd,
    fetchImpl,
  });
  if (!isVercelExecution(execution)) {
    throw err("E_STATE_CONFLICT", "expected Vercel execution for V2 manifest");
  }
  return execution;
}

async function planV2(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
  manifest: VercelManifest,
  params: Extract<ShipInput, { action: "plan" }>,
  credentialSource: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const environment = params.environment;
  const isRollback = "intent" in params && params.intent === "rollback";
  const state = requireState(await services.loadState("vercel"));
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, fetchImpl, services);
  const auth = await runtime.checkAuth(signal);
  if (auth.status === "unverified") {
    throw err(
      auth.reason === "unauthorized" || auth.reason === "forbidden" ? "E_AUTH_MISSING" : "E_STATE_CONFLICT",
      auth.safeMessage,
      auth.retryable,
    );
  }

  const gitInfo = await gatherGit(cwd);
  const rootDirectory = manifest.app.config.rootDirectory ?? ".";
  let localSourceRef: LocalSourceRef | undefined;
  if (!isRollback) {
    const sourceSnapshot = await enumerateSource(cwd, rootDirectory);
    localSourceRef = {
      kind: "local-files",
      rootDirectory,
      fileCount: sourceSnapshot.fileCount,
      totalBytes: sourceSnapshot.totalBytes,
      fingerprint: sourceSnapshot.fingerprint,
    };
  }

  const discovered = await runtime.discover({
    projectName: manifest.app.config.projectName,
    teamId: manifest.app.config.teamId ?? (state.app?.account.kind === "team" ? state.app.account.id : undefined),
    environment,
  }, signal);
  if (discovered.status === "unverified") {
    throw err("E_STATE_CONFLICT", discovered.safeMessage, discovered.retryable);
  }

  const plan = await buildVercelPlan(cwd, manifest, environment, isRollback ? "rollback" : "deploy", {
    accountRef: discovered.value.account,
    observedProjectId: discovered.value.project?.id,
    targetDeploymentId: isRollback ? params.targetReleaseId : undefined,
    source: localSourceRef,
    gitCommit: gitInfo.gitCommit,
    gitDirty: gitInfo.gitDirty,
    worktreeHash: gitInfo.worktreeHash,
  });
  await services.persistPlan("vercel", plan);
  const approval = await requestVercelApproval(ctx, plan, registry);
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

async function applyV2(
  pi: ExtensionAPI,
  cwd: string,
  manifest: VercelManifest,
  params: Extract<ShipInput, { action: "apply_plan" }>,
  credentialSource: CredentialSource,
  registry: ApprovalRegistry,
  signal: AbortSignal | undefined,
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const plan = requirePlan(await services.loadPlan("vercel", params.planId));
  if (plan.planDigest !== params.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match stored plan");
  }
  const state = requireState(await services.loadState("vercel"));
  const appSecretValues = loadAppSecrets(credentialSource, plan.secretNames);
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, fetchImpl, services);
  const gitInfo = await gatherGit(cwd);
  const sourceRef = plan.source;
  let sourceFingerprint: string | undefined;
  if (sourceRef && plan.intent === "deploy") {
    sourceFingerprint = (await enumerateSource(cwd, sourceRef.rootDirectory)).fingerprint;
  }
  const updated = await applyVercelPlan({
    cwd,
    plan,
    manifest,
    suppliedDigest: params.planDigest,
    registry,
    runtime,
    secretValues: appSecretValues,
    currentSource: {
      gitCommit: gitInfo.gitCommit,
      worktreeHash: gitInfo.worktreeHash,
      sourceFingerprint: sourceFingerprint ?? sourceRef?.fingerprint ?? "",
    },
    stateStore: {
      load: async () => requireState(await services.loadState("vercel")),
      save: (next) => services.saveState("vercel", next),
    },
    signal,
  });
  return {
    content: [{
      type: "text",
      text: `Plan ${params.planId} applied. ${updated.app ? `Project: ${updated.app.project.name} (${updated.app.project.id})` : ""}`,
    }],
    details: {
      planId: params.planId,
      planDigest: params.planDigest,
      ...(updated.app ? { projectId: updated.app.project.id, projectName: updated.app.project.name } : {}),
    },
  };
}

async function statusV2(
  pi: ExtensionAPI,
  cwd: string,
  manifest: VercelManifest,
  credentialSource: CredentialSource,
  signal: AbortSignal | undefined,
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireState(await services.loadState("vercel"));
  const lastRelease = [...state.releases].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!lastRelease) {
    return { content: [{ type: "text", text: "No deployment found in any environment." }], details: {} };
  }
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, fetchImpl, services);
  const statusResult = await runtime.status(lastRelease.releaseId, signal);
  if (statusResult.status === "unverified") {
    return {
      content: [{ type: "text", text: `Status unavailable: ${statusResult.safeMessage}` }],
      details: { releaseId: lastRelease.releaseId, error: statusResult.safeMessage },
    };
  }
  return {
    content: [{ type: "text", text: `Deployment status: ${statusResult.value}. URL: ${lastRelease.url ?? "N/A"}.` }],
    details: { releaseId: lastRelease.releaseId, status: statusResult.value, url: lastRelease.url },
  };
}

async function logsV2(
  pi: ExtensionAPI,
  cwd: string,
  manifest: VercelManifest,
  credentialSource: CredentialSource,
  params: Extract<ShipInput, { action: "logs" }>,
  signal: AbortSignal | undefined,
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined,
  services: RegistryServices,
): Promise<ToolResult> {
  const state = requireState(await services.loadState("vercel"));
  const lastRelease = [...state.releases].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!lastRelease) {
    return { content: [{ type: "text", text: "No deployment found in any environment." }], details: {} };
  }
  const plan = requirePlan(await services.loadPlan("vercel", lastRelease.planId));
  if (plan.planDigest !== lastRelease.digest) {
    throw err("E_DIGEST_MISMATCH", "stored plan digest does not match release digest");
  }
  const { runtime } = createExecution(pi, cwd, manifest, state, credentialSource, fetchImpl, services);
  const requestedLines = params.lines;
  const bounded = requestedLines !== undefined && Number.isFinite(requestedLines)
    ? Math.min(Math.max(Math.floor(requestedLines), 1), 500)
    : 100;
  const secretValues = (manifest.secrets ?? [])
    .map((name) => credentialSource.get(name))
    .filter((value): value is string => Boolean(value));
  const logResult = await runtime.logs(lastRelease.releaseId, { lines: bounded, secretValues }, signal);
  if (logResult.status === "unverified") {
    return {
      content: [{ type: "text", text: `Logs unavailable: ${logResult.safeMessage}` }],
      details: { releaseId: lastRelease.releaseId, error: logResult.safeMessage },
    };
  }
  const text = logResult.value;
  return {
    content: [{ type: "text", text: text.length > 4000 ? `${text.slice(0, 4000)}\n...truncated` : text }],
    details: { lines: bounded, releaseId: lastRelease.releaseId },
  };
}

export const handleVercelShipOps: ShipHandler = async (params, context) => {
  const { manifest, cwd, pi, ctx, registry, credentialSource, signal, fetchImpl, services } = context;
  if (!isVercelManifest(manifest)) throw err("E_CONFIG_INVALID", "Vercel handler requires Vercel manifest");
  validateVercelManifestSemantics(manifest);
  const secretNames = manifest.secrets ?? [];
  const missingSecrets = secretNames.filter((name) => !credentialSource.get(name));
  const missingToken = !credentialSource.get("VERCEL_TOKEN");
  const allMissing = [...(missingToken ? ["VERCEL_TOKEN"] : []), ...missingSecrets];
  switch (params.action) {
    case "validate":
      return {
        content: [{
          type: "text",
          text: `Manifest valid for ${manifest.name}. Provider: ${manifest.app.provider}. Project: ${manifest.app.config.projectName}. Missing: ${allMissing.join(", ") || "none"}.`,
        }],
        details: { provider: manifest.app.provider, project: manifest.app.config.projectName, missingSecrets: allMissing },
      };
    case "plan":
      return planV2(pi, ctx, cwd, manifest, params, credentialSource, registry, signal, fetchImpl, services);
    case "apply_plan":
      return applyV2(pi, cwd, manifest, params, credentialSource, registry, signal, fetchImpl, services);
    case "status":
      return statusV2(pi, cwd, manifest, credentialSource, signal, fetchImpl, services);
    case "logs":
      return logsV2(pi, cwd, manifest, credentialSource, params, signal, fetchImpl, services);
  }
};
