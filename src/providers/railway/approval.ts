import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  requestPlanApproval,
  type ApprovalRegistry,
  type ApprovalResult,
} from "../../core/approval.js";
import type { RailwayPlan } from "./plan.js";

export function renderRailwayPlanSummary(plan: RailwayPlan): string {
  const lines = [
    `Intent: ${plan.intent}`,
    `Environment: ${plan.environment}`,
    `Provider: ${plan.provider}`,
    `Git commit: ${plan.gitCommit}`,
    `Dirty worktree: ${plan.gitDirty ? "yes" : "no"}`,
    `Estimated impact: ${plan.estimatedImpact}`,
    "Resources:",
    ...plan.resourceActions.map((item) => `- ${item.action} ${item.resource} ${item.name}`),
  ];
  if (plan.secretNames.length > 0) {
    lines.push("Secrets (names only):", ...plan.secretNames.map((name) => `- ${name}`));
  }
  if (plan.migrationCommand) lines.push(`Migration: ${plan.migrationCommand.join(" ")}`);
  if (plan.targetReleaseId) lines.push(`Target release: ${plan.targetReleaseId}`);
  lines.push(`Plan digest: ${plan.planDigest}`);
  return lines.join("\n");
}

export function requestRailwayApproval(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">,
  plan: RailwayPlan,
  registry: ApprovalRegistry,
): Promise<ApprovalResult> {
  return requestPlanApproval(ctx, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    title: `Approve ${plan.intent} to ${plan.environment}?`,
    summary: renderRailwayPlanSummary(plan),
  }, registry);
}
