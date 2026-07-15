import { Value } from "typebox/value";
import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import { readOperationJournal } from "./operation-journal.js";
import {
  computeCloudflareFingerprint,
  computeCloudflareOperationId,
  computeCloudflarePlanDigest,
  isCloudflarePlan,
  type CloudflarePlan,
} from "./plan.js";
import { CloudflareStateSchema, type CloudflareState } from "./state.js";

export interface CloudflareAuthorizationContext {
  cwd: string;
  plan: CloudflarePlan;
  suppliedDigest: string;
  manifest: unknown;
  registry: ApprovalRegistry;
  state: CloudflareState;
  now?: number;
  signal?: AbortSignal;
}

export async function authorizeCloudflarePlanApply(ctx: CloudflareAuthorizationContext): Promise<void> {
  ctx.signal?.throwIfAborted();
  if (!isCloudflarePlan(ctx.plan) || !Value.Check(CloudflareStateSchema, ctx.state)) {
    throw err("E_CONFIG_INVALID", "invalid Cloudflare plan or state");
  }
  if (computeCloudflarePlanDigest(ctx.plan) !== ctx.plan.planDigest || ctx.suppliedDigest !== ctx.plan.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  }
  if (!ctx.registry.isApproved(ctx.plan.planId, ctx.plan.planDigest, ctx.cwd, { domain: "deployment", risk: "destructive" })) {
    throw err("E_APPROVAL_REQUIRED", "plan has not been approved");
  }

  const created = Date.parse(ctx.plan.createdAt);
  if (Number.isFinite(created) && created > (ctx.now ?? Date.now()) + 60_000) {
    throw err("E_PLAN_STALE", "plan timestamp is in the future");
  }
  if (!Number.isFinite(created) || (ctx.now ?? Date.now()) - created > 30 * 60 * 1000) {
    throw err("E_PLAN_STALE", "plan is stale; regenerate");
  }
  // Verify manifest matches plan identity (plan does not embed full manifest)
  const m = ctx.manifest as Record<string, unknown>;
  if (m?.accountId !== ctx.plan.identity.account.id || m?.name !== ctx.plan.identity.worker.name) {
    throw err("E_STATE_CONFLICT", "current manifest differs from approved plan");
  }
  const recomputedManifestFingerprint = computeCloudflareFingerprint({
    mainModule: (m as Record<string, unknown>)?.mainModule,
    compatibilityDate: (m as Record<string, unknown>)?.compatibilityDate,
    compatibilityFlags: (m as Record<string, unknown>)?.compatibilityFlags,
    source: (m as Record<string, unknown>)?.source,
  });
  if (recomputedManifestFingerprint !== ctx.plan.manifestFingerprint) {
    throw err("E_STATE_CONFLICT", "manifest settings do not match approved plan fingerprint");
  }
  validateTargetBinding(ctx.plan, ctx.state);
  validateOperations(ctx.plan);

  // Reading validates every physical entry and the complete hash chain before any filter.
  await readOperationJournal(ctx.cwd);
  ctx.signal?.throwIfAborted();
}

function validateTargetBinding(plan: CloudflarePlan, state: CloudflareState): void {
  if (state.accountId && state.accountId !== plan.identity.account.id) {
    throw err("E_STATE_CONFLICT", "account changed since plan creation");
  }
  if (state.worker && state.worker.name !== plan.identity.worker.name) {
    throw err("E_STATE_CONFLICT", "worker target changed since plan creation");
  }
}

function validateOperations(plan: CloudflarePlan): void {
  const expectedKinds = plan.intent === "deploy"
    ? ["ensure_worker", "upload_version", "set_secrets", "deploy"]
    : ["rollback"];

  if (plan.operations.length !== expectedKinds.length) {
    throw err("E_STATE_CONFLICT", "plan has an invalid operation sequence");
  }

  // Recompute and verify identity fingerprints
  const expectedAccountFingerprint = computeCloudflareFingerprint(plan.identity.account);
  if (expectedAccountFingerprint !== plan.accountFingerprint) {
    throw err("E_STATE_CONFLICT", "plan accountFingerprint does not match identity");
  }
  const expectedTargetFingerprint = computeCloudflareFingerprint({
    worker: plan.identity.worker.name,
    accountId: plan.identity.account.id,
  });
  if (expectedTargetFingerprint !== plan.targetFingerprint) {
    throw err("E_STATE_CONFLICT", "plan targetFingerprint does not match identity");
  }

  const priorIds = new Set<string>();
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    if (operation.kind !== expectedKinds[index]) {
      throw err("E_STATE_CONFLICT", "plan has an invalid operation sequence");
    }
    if (priorIds.has(operation.operationId) || operation.dependsOn?.some((dependency: string) => !priorIds.has(dependency))) {
      throw err("E_STATE_CONFLICT", "plan dependencies are not topological");
    }
    if (
      operation.operationId !== computeCloudflareOperationId({
        provider: operation.provider,
        kind: operation.kind,
        targetFingerprint: operation.targetFingerprint,
        requestFingerprint: operation.requestFingerprint,
      }) ||
      operation.expectedStateFingerprint !== computeCloudflareFingerprint({
        targetFingerprint: operation.targetFingerprint,
        kind: operation.kind,
        requestFingerprint: operation.requestFingerprint,
      })
    ) {
      throw err("E_STATE_CONFLICT", "operation fingerprints do not match the approved plan");
    }
    if (operation.provider !== plan.provider || operation.targetFingerprint !== plan.targetFingerprint) {
      throw err("E_STATE_CONFLICT", "operation target does not match plan");
    }
    // Verify every operation targets the approved worker
    const op = operation as Record<string, unknown>;
    if (op.workerName !== plan.identity.worker.name) {
      throw err("E_STATE_CONFLICT", `operation ${operation.operationId} workerName does not match approved plan identity`);
    }
    priorIds.add(operation.operationId);
  }
}
