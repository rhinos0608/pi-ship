import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Plan } from "./plan.js";

export interface ApprovalRecord {
  planId: string;
  planDigest: string;
  approvedAt: string;
}

export class ApprovalRegistry {
  private readonly records = new Map<string, ApprovalRecord>();
  constructor(private readonly cwd = process.cwd()) {}
  private key(planId: string, digest: string, cwd: string): string { return `${cwd}::${planId}::${digest}`; }
  approve(planId: string, digest: string, cwd = this.cwd): ApprovalRecord {
    const record: ApprovalRecord = { planId, planDigest: digest, approvedAt: new Date().toISOString() };
    this.records.set(this.key(planId, digest, cwd), record);
    return record;
  }
  isApproved(planId: string, digest: string, cwd = this.cwd): boolean { return this.records.has(this.key(planId, digest, cwd)); }
  revoke(planId: string, digest: string, cwd = this.cwd): boolean { return this.records.delete(this.key(planId, digest, cwd)); }
  clear(): void { this.records.clear(); }
}

export async function requestApproval(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">,
  plan: Plan,
  registry: ApprovalRegistry
): Promise<{ approved: boolean; approvedAt?: string }> {
  if (!ctx.hasUI) {
    return { approved: false };
  }
  const summary = renderPlanSummary(plan);
  const ok = await ctx.ui.confirm(
    `Approve ${plan.intent} to ${plan.environment}?`,
    summary
  );
  if (!ok) return { approved: false };
  const record = registry.approve(plan.planId, plan.planDigest, ctx.cwd);
  return { approved: true, approvedAt: record.approvedAt };
}

function renderPlanSummary(plan: Plan): string {
  const lines: string[] = [
    `Plan ID: ${plan.planId}`,
    `Digest: ${plan.planDigest.slice(0, 16)}...`,
    `Environment: ${plan.environment}`,
    `Intent: ${plan.intent}`,
    ...(plan.targetReleaseId ? [`Target release: ${plan.targetReleaseId}`] : []),
    ...(plan.targetSnapshot ? [`Target identity: ${plan.targetSnapshot.projectId ?? "unknown"}/${plan.targetSnapshot.environmentId ?? "unknown"}/${plan.targetSnapshot.serviceIds?.app ?? "unknown"}`] : []),
    `Impact: ${plan.estimatedImpact}`,
    `Dirty worktree: ${plan.gitDirty ? "yes" : "no"}`,
    "Resource actions:",
    ...plan.resourceActions.map((a) => `  - ${a.action} ${a.resource}: ${a.name}`),
  ];
  if (plan.secretNames.length > 0) {
    lines.push(`Secrets referenced (names only): ${plan.secretNames.join(", ")}`);
  }
  if (plan.migrationCommand) {
    lines.push(`Migration command: ${plan.migrationCommand.join(" ")}`);
  }
  return lines.join("\n");
}
