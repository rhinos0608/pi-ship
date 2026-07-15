import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  requestPlanApproval,
  type ApprovalRegistry,
  type ApprovalResult,
} from "../../core/approval.js";
import type { VercelPlan } from "./plan.js";

export function renderVercelPlanSummary(plan: VercelPlan): string {
  const lines = [
    `Intent: ${plan.intent}`,
    `Provider: ${plan.provider}`,
    `Environment: ${plan.environment}`,
    `Project: ${plan.identity.project.name}`,
    `Account: ${plan.identity.account.kind}:${plan.identity.account.id}`,
    `Git commit: ${plan.gitCommit}`,
    `Dirty worktree: ${plan.gitDirty ? "yes" : "no"}`,
    `Estimated impact: ${plan.estimatedImpact}`,
    "Operations:",
    ...plan.operations.map((operation) => `- ${operation.kind}`),
  ];
  if (plan.secretNames.length > 0) {
    lines.push("Secrets (names only):", ...plan.secretNames.map((name) => `- ${name}`));
  }
  lines.push(`Plan digest: ${plan.planDigest}`);
  return lines.join("\n");
}

export function requestVercelApproval(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">,
  plan: VercelPlan,
  registry: ApprovalRegistry,
): Promise<ApprovalResult> {
  return requestPlanApproval(ctx, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    title: `Approve ${plan.intent} to ${plan.environment}?`,
    summary: renderVercelPlanSummary(plan),
  }, registry);
}
