import { describe, it, expect } from "vitest";
import { mintCapability, validateCapability } from "../../src/boundary/capability.js";
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

describe("validateCapability", () => {
  it("rejects plan id mismatch", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-a", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "plan-b", "x", reg, "/cwd", "database").valid).toBe(false);
  });

  it("rejects resource mismatch", () => {
    const cap = mintCapability({ resource: "db-a", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db-b", "p1", "x", reg, "/cwd", "database").valid).toBe(false);
  });

  it("rejects plan digest mismatch", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "p1", "y", reg, "/cwd", "database").valid).toBe(false);
  });

  it("rejects expired capability", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "p1", planDigest: "x", riskLevel: "write", ttlMs: 0 });
    const reg = new ApprovalRegistry();
    // ttlMs=0 means expiresAt == issuedAt, which is < now
    expect(validateCapability(cap, "db", "p1", "x", reg, "/cwd", "database").valid).toBe(false);
  });

  it("rejects unapproved capability", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    expect(validateCapability(cap, "db", "plan-1", "x", reg, "/cwd", "database").valid).toBe(false);
  });

  it("accepts valid capability with approval", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    reg.approve("plan-1", "x", "/cwd", { domain: "database", risk: "write" });
    expect(validateCapability(cap, "db", "plan-1", "x", reg, "/cwd", "database").valid).toBe(true);
  });

  it("rejects deployment-approved capability for database resource type validation", () => {
    const cap = mintCapability({ resource: "db", operation: "execute", planId: "plan-1", planDigest: "x", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    reg.approve("plan-1", "x", "/cwd", { domain: "deployment", risk: "write" });
    const result = validateCapability(cap, "db", "plan-1", "x", reg, "/cwd", "database");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("approval");
  });

  it("rejects database-approved capability for deployment resource type validation", () => {
    const cap = mintCapability({ resource: "deploy-prod", operation: "execute", planId: "plan-2", planDigest: "y", riskLevel: "write" });
    const reg = new ApprovalRegistry();
    reg.approve("plan-2", "y", "/cwd", { domain: "database", risk: "write" });
    const result = validateCapability(cap, "deploy-prod", "plan-2", "y", reg, "/cwd", "deployment");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("approval");
  });
});
