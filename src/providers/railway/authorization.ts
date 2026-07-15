import { ApprovalRegistry } from "../../core/approval.js";
import { err } from "../../core/errors.js";
import { isRailwayPlanStale, canonicalize, computeDigest, type RailwayPlan } from "./plan.js";
import type { RailwayManifest } from "./manifest.js";
import { loadRailwayState, type LocalState } from "./state.js";

export interface RailwayAuthorizationContext {
  registry: ApprovalRegistry;
  cwd: string;
  plan: RailwayPlan;
  suppliedDigest: string;
  manifest: RailwayManifest;
  signal?: AbortSignal;
  state?: LocalState;
}

export async function authorizeRailwayPlanApply(ctx: RailwayAuthorizationContext): Promise<void> {
  ctx.signal?.throwIfAborted();
  if (computeDigest(ctx.plan) !== ctx.plan.planDigest || ctx.suppliedDigest !== ctx.plan.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  }
  if (!ctx.registry.isApproved(ctx.plan.planId, ctx.plan.planDigest, ctx.cwd, { domain: "deployment", risk: "destructive" })) {
    throw err("E_APPROVAL_REQUIRED", "plan has not been approved");
  }
  if (await isRailwayPlanStale(ctx.plan, ctx.cwd)) throw err("E_PLAN_STALE", "plan is stale; regenerate");
  if (canonicalize({ ...ctx.plan, manifest: ctx.manifest } as RailwayPlan) !== canonicalize(ctx.plan)) {
    throw err("E_STATE_CONFLICT", "current manifest differs from approved plan");
  }
  const actions = ctx.plan.resourceActions.map((a) => a.resource);
  if (ctx.plan.intent === "deploy" && (!actions.includes("deployment") || ctx.plan.resourceActions.some((a) => a.action === "rollback"))) {
    throw err("E_STATE_CONFLICT", "deploy plan intent is incompatible with resource actions");
  }
  if (ctx.plan.intent === "migration" && (actions.includes("deployment") || actions.includes("project") || actions.includes("service"))) {
    throw err("E_STATE_CONFLICT", "migration plan contains deployment actions");
  }
  if (ctx.plan.intent === "rollback" && (!ctx.plan.targetReleaseId || actions.some((a) => a !== "deployment"))) {
    throw err("E_STATE_CONFLICT", "rollback plan intent is incompatible with resource actions");
  }
  const state = ctx.state ?? await loadRailwayState(ctx.cwd);
  if ((ctx.plan.intent === "deploy" || ctx.plan.intent === "rollback") && !ctx.plan.targetSnapshot) {
    throw err("E_STATE_CONFLICT", "plan missing bound targetSnapshot");
  }
  if (ctx.plan.targetSnapshot && canonicalize(ctx.plan.targetSnapshot) !== canonicalize({ projectId: state.projectId, projectName: state.projectName, environmentId: state.environmentId, environmentName: state.environmentName, serviceIds: state.serviceIds, serviceNames: state.serviceNames })) {
    throw err("E_STATE_CONFLICT", "provider target identity changed since plan creation");
  }
  ctx.signal?.throwIfAborted();
}
