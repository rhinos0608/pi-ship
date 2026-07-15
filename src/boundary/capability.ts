import type { BoundaryCapability, ResourceType } from "./types.js";
import type { ApprovalRegistry } from "../core/approval.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function mintCapability(options: {
  resource: string;
  operation: BoundaryCapability["operation"];
  planId: string;
  planDigest: string;
  riskLevel: BoundaryCapability["riskLevel"];
  ttlMs?: number;
}): BoundaryCapability {
  const now = Date.now();
  return {
    resource: options.resource,
    operation: options.operation,
    planId: options.planId,
    planDigest: options.planDigest,
    riskLevel: options.riskLevel,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
}

export function validateCapability(
  capability: BoundaryCapability,
  expectedResource: string,
  expectedPlanId: string,
  expectedPlanDigest: string,
  registry: ApprovalRegistry,
  cwd: string,
  resourceType: ResourceType,
): { valid: boolean; reason?: string } {
  if (capability.planId !== expectedPlanId) {
    return { valid: false, reason: "capability plan id mismatch" };
  }
  if (capability.resource !== expectedResource) {
    return { valid: false, reason: "capability resource mismatch" };
  }
  if (capability.planDigest !== expectedPlanDigest) {
    return { valid: false, reason: "capability plan digest mismatch" };
  }
  if (new Date(capability.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: "capability expired" };
  }
  const risk = capability.riskLevel === "destructive" ? "destructive" : "write";
  if (!registry.isApproved(expectedPlanId, expectedPlanDigest, cwd, { domain: resourceType, risk })) {
    return { valid: false, reason: "capability not backed by approval" };
  }
  return { valid: true };
}
