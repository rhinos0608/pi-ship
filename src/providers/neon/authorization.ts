import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import type { NeonPlan } from "./plan.js";
import { computePlanDigest } from "./plan.js";
import type { NeonManifest } from "./manifest.js";
import type { NeonState } from "./state.js";
import { canonicalize } from "../../core/canonicalize.js";

export interface NeonAuthorizationContext {
  registry: ApprovalRegistry;
  cwd: string;
  plan: NeonPlan;
  /** Current on-disk inputs. Plan values must remain bound to these values. */
  manifest: NeonManifest;
  state: NeonState;
  suppliedDigest: string;
  signal?: AbortSignal;
  now?: number;
}

export async function authorizeNeonPlanApply(ctx: NeonAuthorizationContext): Promise<void> {
  ctx.signal?.throwIfAborted();

  if (computePlanDigest(ctx.plan) !== ctx.plan.planDigest || ctx.suppliedDigest !== ctx.plan.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  }

  if (!ctx.registry.isApproved(ctx.plan.planId, ctx.plan.planDigest, ctx.cwd, { domain: "database", risk: "destructive" })) {
    throw err("E_APPROVAL_REQUIRED", "plan has not been approved");
  }

  // Staleness check — reject plans older than 30 minutes
  const created = Date.parse(ctx.plan.createdAt);
  if (Number.isFinite(created) && created > (ctx.now ?? Date.now()) + 60_000) {
    throw err("E_PLAN_STALE", "plan timestamp is in the future");
  }
  if (!Number.isFinite(created) || (ctx.now ?? Date.now()) - created > 30 * 60 * 1000) {
    throw err("E_PLAN_STALE", "plan is stale; regenerate");
  }

  ctx.signal?.throwIfAborted();

  // Manifest is part of signed plan input; never apply against changed current config.
  if (canonicalize(ctx.plan.manifest) !== canonicalize(ctx.manifest)) {
    throw err("E_STATE_CONFLICT", "plan manifest does not match current manifest");
  }

  const baseBranch = ctx.manifest.branch?.name ?? ctx.manifest.project;
  if (ctx.plan.intent !== "provision") {
    if (!ctx.state.projectName || ctx.state.projectName !== ctx.manifest.project || !ctx.state.projectId) {
      throw err("E_STATE_CONFLICT", "current Neon project binding does not match plan");
    }
    const currentBaseBranchId = ctx.state.branchIds[baseBranch];
    if (!currentBaseBranchId) {
      throw err("E_STATE_CONFLICT", "current Neon base branch binding is missing");
    }

    if (ctx.plan.intent === "rollback") {
      if (ctx.plan.targetBranchId !== currentBaseBranchId || !ctx.plan.sourceBranchId || !ctx.plan.restoreTimestamp) {
        throw err("E_STATE_CONFLICT", "rollback target binding does not match current Neon state");
      }
      const restorePoint = (ctx.state.restorePoints ?? []).find((point) =>
        point.projectId === ctx.state.projectId &&
        point.branchId === ctx.plan.sourceBranchId &&
        point.timestamp === ctx.plan.restoreTimestamp,
      );
      if (!restorePoint) {
        throw err("E_STATE_CONFLICT", "rollback restore point does not match current Neon state");
      }
    }
  }

  ctx.signal?.throwIfAborted();
}
