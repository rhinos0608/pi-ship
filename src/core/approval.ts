import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ApprovalMetadata {
  domain: "deployment" | "database";
  risk?: "write" | "destructive";
}
export interface ApprovalRecord {
  planId: string;
  planDigest: string;
  approvedAt: string;
  metadata?: ApprovalMetadata;
}

export class ApprovalRegistry {
  private readonly records = new Map<string, ApprovalRecord>();

  constructor(private readonly cwd = process.cwd()) {}

  private key(planId: string, digest: string, cwd: string): string {
    return `${cwd}::${planId}::${digest}`;
  }

  approve(planId: string, digest: string, cwd = this.cwd, metadata?: ApprovalMetadata): ApprovalRecord {
    const record: ApprovalRecord = {
      planId,
      planDigest: digest,
      approvedAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
    this.records.set(this.key(planId, digest, cwd), record);
    return record;
  }

  isApproved(planId: string, digest: string, cwd = this.cwd, metadata?: ApprovalMetadata): boolean {
    const record = this.records.get(this.key(planId, digest, cwd));
    if (!record) return false;
    if (!metadata) return true;
    return record.metadata?.domain === metadata.domain && record.metadata?.risk === metadata.risk;
  }

  revoke(planId: string, digest: string, cwd = this.cwd): boolean {
    return this.records.delete(this.key(planId, digest, cwd));
  }

  clear(): void {
    this.records.clear();
  }
}

export interface ApprovalRequest {
  planId: string;
  planDigest: string;
  title: string;
  summary: string;
  metadata?: ApprovalMetadata;
}

export interface ApprovalResult {
  approved: boolean;
  approvedAt?: string;
}

/** Provider-neutral UI approval primitive. Provider packages own plan summaries. */
export async function requestPlanApproval(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">,
  request: ApprovalRequest,
  registry: ApprovalRegistry,
): Promise<ApprovalResult> {
  if (!ctx.hasUI) return { approved: false };
  const ok = await ctx.ui.confirm(request.title, request.summary);
  if (!ok) return { approved: false };
  const record = registry.approve(request.planId, request.planDigest, ctx.cwd, request.metadata);
  return { approved: true, approvedAt: record.approvedAt };
}
