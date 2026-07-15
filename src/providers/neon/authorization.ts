import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import type { NeonPlan } from "./plan.js";
import { computePlanDigest } from "./plan.js";

export interface NeonAuthorizationContext {
  registry: ApprovalRegistry;
  cwd: string;
  plan: NeonPlan;
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
}
