import * as crypto from "node:crypto";
import type { BoundaryCapability, SignedCapability, ResourceType } from "./types.js";
import type { ApprovalRegistry } from "../core/approval.js";
import { verifyCapability } from "./crypto.js";
import { ReplayStore } from "./replay-store.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- jti replay tracking (in-memory fallback, used when replayStore is null) ---
const jtiCache = new Map<string, number>();

function pruneJtiCache(): void {
  const now = Date.now();
  for (const [jti, expiresAt] of jtiCache) {
    if (expiresAt < now) jtiCache.delete(jti);
  }
}

/** Mark a jti as used. Returns true if accepted, false if replay detected. */
function markJtiUsed(jti: string, expiresAt: number): boolean {
  pruneJtiCache();
  if (jtiCache.has(jti)) return false;
  jtiCache.set(jti, expiresAt);
  return true;
}

export function clearJtiCacheForTests(): void { jtiCache.clear(); }

const defaultReplayStores = new Map<string, ReplayStore>();
function getDefaultReplayStore(): ReplayStore {
  const cwd = process.cwd();
  let s = defaultReplayStores.get(cwd);
  if (!s) {
    s = new ReplayStore(cwd);
    defaultReplayStores.set(cwd, s);
  }
  return s;
}
// for tests to clear per-cwd cache if needed
function clearDefaultReplayStoresForTests(): void { defaultReplayStores.clear(); }

// --- mint/verify signed capabilities ---

export function mintSignedCapability(
  options: {
    resource: string;
    operation: BoundaryCapability["operation"];
    planId: string;
    planDigest: string;
    riskLevel: BoundaryCapability["riskLevel"];
    issuer: string;
    audience: string;
    projectBinding: string;
    keyId: string;
    ttlMs?: number;
  },
  signer: (claims: Record<string, unknown>) => string,
): SignedCapability {
  if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
    throw new Error(`mintSignedCapability: ttlMs must be finite and positive, got ${options.ttlMs}`);
  }
  const now = Date.now();
  const jti = crypto.randomUUID();
  const claims = {
    version: 1 as const,
    resource: options.resource,
    operation: options.operation,
    planId: options.planId,
    planDigest: options.planDigest,
    riskLevel: options.riskLevel,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    keyId: options.keyId,
    issuer: options.issuer,
    audience: options.audience,
    projectBinding: options.projectBinding,
    jti,
  };
  const signature = signer(claims as Record<string, unknown>);
  return { ...claims, signature };
}

export function verifySignedCapability(
  signed: SignedCapability,
  trustedPublicKeys: Map<string, crypto.KeyObject>,
  expectedAudience: string,
  replayStore?: ReplayStore | null,
): { valid: boolean; reason?: string } {
  const { signature, ...claims } = signed;

  // 1. Look up public key by keyId
  const publicKey = trustedPublicKeys.get(signed.keyId);
  if (!publicKey) {
    return { valid: false, reason: "unknown keyId" };
  }

  // 2. Verify signature first (before trusting any claims)
  if (!verifyCapability(claims as Record<string, unknown>, signature, publicKey)) {
    return { valid: false, reason: "invalid signature" };
  }

  // 3. Check expiry
  const expiry = new Date(signed.expiresAt).getTime();
  if (Number.isNaN(expiry) || !Number.isFinite(expiry)) {
    return { valid: false, reason: "capability expiresAt is not a valid date" };
  }
  if (expiry < Date.now()) {
    return { valid: false, reason: "capability expired" };
  }

  // 4. Check audience
  if (signed.audience !== expectedAudience) {
    return { valid: false, reason: "audience mismatch" };
  }

  // 5. Check jti replay - durable by default, in-memory only if explicitly null
  const store = replayStore === undefined ? getDefaultReplayStore() : replayStore;
  if (store) {
    try {
      const accepted = store.consumeSync(signed.jti, expiry);
      if (!accepted) return { valid: false, reason: "jti replay detected" };
    } catch {
      return { valid: false, reason: "replay store unavailable" };
    }
  } else {
    if (!markJtiUsed(signed.jti, expiry)) {
      return { valid: false, reason: "jti replay detected" };
    }
  }

  return { valid: true };
}

/** Durable variant: same checks but JTI consumption is atomic on disk via ReplayStore. Fail closed on storage error. */
export async function verifySignedCapabilityAsync(
  signed: SignedCapability,
  trustedPublicKeys: Map<string, crypto.KeyObject>,
  expectedAudience: string,
  replayStore?: ReplayStore | null,
): Promise<{ valid: boolean; reason?: string }> {
  const { signature, ...claims } = signed;
  const publicKey = trustedPublicKeys.get(signed.keyId);
  if (!publicKey) return { valid: false, reason: "unknown keyId" };
  if (!verifyCapability(claims as Record<string, unknown>, signature, publicKey)) return { valid: false, reason: "invalid signature" };
  const expiry = new Date(signed.expiresAt).getTime();
  if (Number.isNaN(expiry) || !Number.isFinite(expiry)) return { valid: false, reason: "capability expiresAt is not a valid date" };
  if (expiry < Date.now()) return { valid: false, reason: "capability expired" };
  if (signed.audience !== expectedAudience) return { valid: false, reason: "audience mismatch" };
  const store = replayStore === undefined ? getDefaultReplayStore() : replayStore;
  if (store) {
    try {
      const accepted = await store.consume(signed.jti, expiry);
      if (!accepted) return { valid: false, reason: "jti replay detected" };
    } catch {
      return { valid: false, reason: "replay store unavailable" };
    }
  } else {
    if (!markJtiUsed(signed.jti, expiry)) return { valid: false, reason: "jti replay detected" };
  }
  return { valid: true };
}

export function mintCapability(options: {
  resource: string;
  operation: BoundaryCapability["operation"];
  planId: string;
  planDigest: string;
  riskLevel: BoundaryCapability["riskLevel"];
  ttlMs?: number;
}): BoundaryCapability {
  if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
    throw new Error(`mintCapability: ttlMs must be finite and positive, got ${options.ttlMs}`);
  }
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
  expectedOperation: BoundaryCapability["operation"],
  expectedRisk: BoundaryCapability["riskLevel"],
): { valid: boolean; reason?: string } {
  if (capability.operation !== expectedOperation) {
    return { valid: false, reason: "capability operation mismatch" };
  }
  if (capability.riskLevel !== expectedRisk) {
    return { valid: false, reason: "capability risk level mismatch" };
  }
  if (capability.planId !== expectedPlanId) {
    return { valid: false, reason: "capability plan id mismatch" };
  }
  if (capability.resource !== expectedResource) {
    return { valid: false, reason: "capability resource mismatch" };
  }
  if (capability.planDigest !== expectedPlanDigest) {
    return { valid: false, reason: "capability plan digest mismatch" };
  }
  const expiry = new Date(capability.expiresAt).getTime();
  if (Number.isNaN(expiry) || !Number.isFinite(expiry)) {
    return { valid: false, reason: "capability expiresAt is not a valid date" };
  }
  if (expiry < Date.now()) {
    return { valid: false, reason: "capability expired" };
  }
  // Use expected risk (authoritative) rather than untrusted capability.riskLevel
  const risk = expectedRisk === "destructive" ? "destructive" : "write";
  if (!registry.isApproved(expectedPlanId, expectedPlanDigest, cwd, { domain: resourceType, risk })) {
    return { valid: false, reason: "capability not backed by approval" };
  }
  return { valid: true };
}
