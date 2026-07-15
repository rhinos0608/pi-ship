import { Value } from "typebox/value";
import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import { readOperationJournal } from "./operation-journal.js";
import { canonicalize } from "../../core/canonicalize.js";
import {
  computeVercelFingerprint,
  computeVercelOperationId,
  computeVercelPlanDigest,
  isVercelPlan,
  type VercelPlan,
} from "./plan.js";
import { VercelStateSchema, type VercelState } from "./state.js";

export interface CurrentSourceIdentity {
  gitCommit: string;
  worktreeHash: string;
  sourceFingerprint: string;
}

export interface VercelAuthorizationContext {
  cwd: string;
  plan: VercelPlan;
  suppliedDigest: string;
  manifest: unknown;
  registry: ApprovalRegistry;
  state: VercelState;
  currentSource?: CurrentSourceIdentity;
  now?: number;
  signal?: AbortSignal;
}

export async function authorizeVercelPlanApply(ctx: VercelAuthorizationContext): Promise<void> {
  ctx.signal?.throwIfAborted();
  if (!isVercelPlan(ctx.plan) || !Value.Check(VercelStateSchema, ctx.state)) {
    throw err("E_CONFIG_INVALID", "invalid V2 plan or state");
  }
  if (computeVercelPlanDigest(ctx.plan) !== ctx.plan.planDigest || ctx.suppliedDigest !== ctx.plan.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  }
  if (!ctx.registry.isApproved(ctx.plan.planId, ctx.plan.planDigest, ctx.cwd)) {
    throw err("E_APPROVAL_REQUIRED", "plan has not been approved");
  }

  const created = Date.parse(ctx.plan.createdAt);
  if (Number.isFinite(created) && created > (ctx.now ?? Date.now()) + 60_000) throw err("E_PLAN_STALE", "plan timestamp is in the future");
  if (!Number.isFinite(created) || (ctx.now ?? Date.now()) - created > 30 * 60 * 1000) {
    throw err("E_PLAN_STALE", "plan is stale; regenerate");
  }
  if (canonicalize(ctx.plan.manifest) !== canonicalize(ctx.manifest)) {
    throw err("E_STATE_CONFLICT", "current manifest differs from approved plan");
  }
  if (ctx.plan.intent === "deploy") validateCurrentSource(ctx);
  validateTargetBinding(ctx.plan, ctx.state);
  validateOperations(ctx.plan);

  // Reading validates every physical entry and the complete hash chain before any filter.
  await readOperationJournal(ctx.cwd);
  ctx.signal?.throwIfAborted();
}

function validateCurrentSource(ctx: VercelAuthorizationContext): void {
  const current = ctx.currentSource;
  if (!current || !ctx.plan.source) {
    throw err("E_STATE_CONFLICT", "current source identity is required");
  }
  if (
    current.gitCommit !== ctx.plan.gitCommit ||
    current.worktreeHash !== ctx.plan.worktreeHash ||
    current.sourceFingerprint !== ctx.plan.source.fingerprint
  ) {
    throw err("E_STATE_CONFLICT", "current source identity differs from approved plan");
  }
}

function validateTargetBinding(plan: VercelPlan, state: VercelState): void {
  const app = state.app;
  if (!app) {
    if (plan.identity.project.observedId) {
      throw err("E_STATE_CONFLICT", "provider target identity missing");
    }
    return;
  }
  if (
    app.provider !== plan.provider ||
    app.accountFingerprint !== plan.accountFingerprint ||
    app.project.fingerprint !== plan.projectFingerprint
  ) {
    throw err("E_STATE_CONFLICT", "provider target identity changed since plan creation");
  }
  if (
    app.account.kind !== plan.identity.account.kind ||
    app.account.id !== plan.identity.account.id ||
    app.project.name !== plan.identity.project.name
  ) {
    throw err("E_STATE_CONFLICT", "account or project target changed since plan creation");
  }
  if (plan.identity.project.observedId && app.project.id !== plan.identity.project.observedId) {
    throw err("E_STATE_CONFLICT", "project target changed since plan creation");
  }
  const environment = app.environments[plan.environment];
  if (environment && environment.targetFingerprint !== plan.targetFingerprint) {
    throw err("E_STATE_CONFLICT", "environment target changed since plan creation");
  }
}

function validateOperations(plan: VercelPlan): void {
  const expectedKinds = plan.intent === "deploy"
    ? ["ensure_project", "upsert_secrets", "deploy"]
    : ["rollback"];
  if (plan.operations.length !== expectedKinds.length) {
    throw err("E_STATE_CONFLICT", "plan has an invalid operation sequence");
  }

  const priorIds = new Set<string>();
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    if (operation.kind !== expectedKinds[index]) {
      throw err("E_STATE_CONFLICT", "plan has an invalid operation sequence");
    }
    if (priorIds.has(operation.operationId) || operation.dependsOn.some((dependency) => !priorIds.has(dependency))) {
      throw err("E_STATE_CONFLICT", "plan dependencies are not topological");
    }
    if (
      operation.operationId !== computeVercelOperationId({
        provider: operation.provider,
        kind: operation.kind,
        targetFingerprint: operation.targetFingerprint,
        requestFingerprint: operation.requestFingerprint,
      }) ||
      operation.expectedStateFingerprint !== computeVercelFingerprint({
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
    if ("environment" in operation && operation.environment !== plan.environment) {
      throw err("E_STATE_CONFLICT", "operation environment does not match plan");
    }
    priorIds.add(operation.operationId);
  }
  if (plan.intent === "rollback" && plan.environment !== "production") {
    throw err("E_STATE_CONFLICT", "rollback operation is incompatible with plan");
  }
}
