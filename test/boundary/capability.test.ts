import { describe, it, expect, vi } from "vitest";
import { mintCapability, mintSignedCapability, verifySignedCapability, validateCapability } from "../../src/boundary/capability.js";
import { EphemeralKeyStore } from "../../src/boundary/key-store.js";
import { ApprovalRegistry } from "../../src/core/approval.js";

describe("mintCapability", () => {
  it("creates capability with default 5min TTL", () => {
    const cap = mintCapability({
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc-123",
      planDigest: "abc123",
      riskLevel: "write",
    });
    expect(cap.resource).toBe("production-database");
    expect(cap.planId).toBe("plan-abc-123");
    expect(cap.planDigest).toBe("abc123");
    expect(new Date(cap.expiresAt).getTime() - new Date(cap.issuedAt).getTime()).toBe(5 * 60 * 1000);
  });

  it("accepts custom TTL", () => {
    const cap = mintCapability({
      resource: "db",
      operation: "read",
      planId: "p1",
      planDigest: "x",
      riskLevel: "read",
      ttlMs: 60_000,
    });
    expect(new Date(cap.expiresAt).getTime() - new Date(cap.issuedAt).getTime()).toBe(60_000);
  });
});

describe("mintSignedCapability", () => {
  let store: EphemeralKeyStore;

  beforeEach(() => {
    store = new EphemeralKeyStore();
  });

  it("produces valid signed token", () => {
    const signed = mintSignedCapability({
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc-123",
      planDigest: "abc123",
      riskLevel: "write",
      issuer: "pi-ship-parent",
      audience: "pi-ship-child",
      projectBinding: "proj-1",
      keyId: store.getPublicKeyId(),
    }, store.getSigner());
    expect(signed.resource).toBe("production-database");
    expect(signed.signature).toBeDefined();
    expect(signed.keyId).toBe(store.getPublicKeyId());
    expect(signed.version).toBe(1);
    expect(signed.jti).toBeDefined();
  });

  it("rejects malformed ttlMs", () => {
    expect(() => mintSignedCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "p", audience: "c", projectBinding: "proj-1",
      keyId: store.getPublicKeyId(),
      ttlMs: -1,
    }, store.getSigner())).toThrow();
  });
});

describe("verifySignedCapability", () => {
  let store: EphemeralKeyStore;

  beforeEach(() => {
    store = new EphemeralKeyStore();
  });

  function makeSigned(audience = "child") {
    return mintSignedCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "parent", audience, projectBinding: "proj-1",
      keyId: store.getPublicKeyId(),
    }, store.getSigner());
  }

  it("accepts valid token", () => {
    const signed = makeSigned("child");
    const result = verifySignedCapability(signed, new Map([[store.getPublicKeyId(), store.publicKey]]), "child");
    expect(result.valid).toBe(true);
  });

  it("rejects expired token", () => {
    vi.useFakeTimers();
    const signed = mintSignedCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "parent", audience: "child", projectBinding: "proj-1",
      keyId: store.getPublicKeyId(), ttlMs: 1,
    }, store.getSigner());
    vi.advanceTimersByTime(2);
    const result = verifySignedCapability(signed, new Map([[store.getPublicKeyId(), store.publicKey]]), "child");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("expired");
    vi.useRealTimers();
  });

  it("rejects wrong audience", () => {
    const signed = makeSigned("child");
    const result = verifySignedCapability(signed, new Map([[store.getPublicKeyId(), store.publicKey]]), "wrong-audience");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("audience");
  });

  it("rejects replay (same jti twice)", () => {
    const signed = makeSigned("child");
    const keys = new Map([[store.getPublicKeyId(), store.publicKey]]);
    expect(verifySignedCapability(signed, keys, "child").valid).toBe(true);
    expect(verifySignedCapability(signed, keys, "child").valid).toBe(false);
  });

  it("rejects unknown keyId", () => {
    const signed = makeSigned("child");
    const result = verifySignedCapability(signed, new Map(), "child");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("keyId");
  });

  it("rejects tampered signature", () => {
    const signed = makeSigned("child");
    const tampered = { ...signed, resource: "hacked-db" };
    const result = verifySignedCapability(tampered, new Map([[store.getPublicKeyId(), store.publicKey]]), "child");
    expect(result.valid).toBe(false);
  });
});

describe("backward compat", () => {
  it("mintCapability still works unchanged", () => {
    const cap = mintCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write",
    });
    expect(cap.resource).toBe("db");
    expect(cap.planId).toBe("p1");
    // Unsigned caps have no signature field
    expect((cap as unknown as Record<string, unknown>).signature).toBeUndefined();
  });

  it("unsigned cap accepted by validateCapability", () => {
    const cap = mintCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write",
    });
    const reg = new ApprovalRegistry();
    reg.approve("p1", "x", "/tmp/test", { domain: "database", risk: "write" });
    const result = validateCapability(cap, "db", "p1", "x", reg, "/tmp/test", "database", "execute", "write");
    expect(result.valid).toBe(true);
  });
});

describe("validateCapability", () => {
  it("rejects plan id mismatch", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-a", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "plan-b", "x", reg, "/cwd", "database", "execute", "write").valid).toBe(false);
  });

  it("rejects resource mismatch", () => {
    const cap = mintCapability({ resource: "db-a", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db-b", "p1", "x", reg, "/cwd", "database", "execute", "write").valid).toBe(false);
  });

  it("rejects plan digest mismatch", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "p1", "y", reg, "/cwd", "database", "execute", "write").valid).toBe(false);
  });

  it("rejects expired capability", () => {
    vi.useFakeTimers();
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write", ttlMs: 1 });
    // Advance time past the 1ms TTL so the capability is expired
    vi.advanceTimersByTime(2);
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "p1", "x", reg, "/cwd", "database", "execute", "write").valid).toBe(false);
    vi.useRealTimers();
  });

  it("rejects unapproved capability", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "plan-1", "x", reg, "/cwd", "database", "execute", "write").valid).toBe(false);
  });

  it("accepts valid capability with approval", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    reg.approve("plan-1", "x", "/cwd", { domain: "database", risk: "write" });
    expect(validateCapability(cap, "db", "plan-1", "x", reg, "/cwd", "database", "execute", "write").valid).toBe(true);
  });

  it("rejects deployment-approved capability for database resource type validation", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    reg.approve("plan-1", "x", "/cwd", { domain: "deployment", risk: "write" });
    const result = validateCapability(cap, "db", "plan-1", "x", reg, "/cwd", "database", "execute", "write");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("approval");
  });

  it("rejects database-approved capability for deployment resource type validation", () => {
    const cap = mintCapability({ resource: "deploy-prod", operation: "execute", planId: "plan-2", planDigest: "y", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    reg.approve("plan-2", "y", "/cwd", { domain: "database", risk: "write" });
    const result = validateCapability(cap, "deploy-prod", "plan-2", "y", reg, "/cwd", "deployment", "execute", "write");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("approval");
  });
});
