import { describe, it, expect, beforeEach } from "vitest";
import { CredentialVault } from "../../src/boundary/vault.js";
import { ProtectedResourceRegistry, createDatabaseResource, createVercelResource } from "../../src/boundary/resource.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import type { CredentialSource } from "../../src/deployment/credentials.js";
import type { BoundaryCapability } from "../../src/boundary/types.js";

function mockSource(vars: Record<string, string | undefined>): CredentialSource {
  return { get: (name: string) => vars[name] };
}

describe("CredentialVault", () => {
  let registry: ProtectedResourceRegistry;

  beforeEach(() => {
    registry = new ProtectedResourceRegistry();
    registry.register(createDatabaseResource());
    registry.register(createVercelResource());
  });

  it("managed mode always returns credentials", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "managed");
    expect(vault.get("DATABASE_URL")).toBe("postgres://...");
  });

  it("warn mode returns credentials (enforcement layer warns)", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "warn");
    expect(vault.get("DATABASE_URL")).toBe("postgres://...");
  });

  it("exclusive mode returns undefined without capability", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    expect(vault.get("DATABASE_URL")).toBeUndefined();
  });

  it("exclusive mode returns undefined with expired capability", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    const expired: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "abc",
      riskLevel: "write",
      issuedAt: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    expect(vault.get("DATABASE_URL", expired)).toBeUndefined();
  });

  it("exclusive mode returns credential with valid capability", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "abc",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(vault.get("DATABASE_URL", cap)).toBe("postgres://...");
  });

  it("unprotected credentials always accessible", () => {
    const vault = new CredentialVault(mockSource({ HOME: "/home/user" }), registry, "exclusive");
    expect(vault.get("HOME")).toBe("/home/user");
  });

  it("returns undefined for missing credentials", () => {
    const vault = new CredentialVault(mockSource({}), registry, "managed");
    expect(vault.get("DATABASE_URL")).toBeUndefined();
  });

  it("exclusive mode returns credential with approvalRegistry and valid approved capability", () => {
    const approvalRegistry = new ApprovalRegistry();
    approvalRegistry.approve("plan-abc", "digest-1", process.cwd(), { domain: "database", risk: "write" });
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://approved..." }), registry, "exclusive", approvalRegistry);
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "digest-1",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(vault.get("DATABASE_URL", cap)).toBe("postgres://approved...");
  });

  it("exclusive mode returns undefined with approvalRegistry and unapproved capability", () => {
    const approvalRegistry = new ApprovalRegistry();
    // No approve call — capability not backed by approval
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://secret..." }), registry, "exclusive", approvalRegistry);
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-unapproved",
      planDigest: "digest-xyz",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(vault.get("DATABASE_URL", cap)).toBeUndefined();
  });

  it("exclusive mode with approvalRegistry rejects capability for different resource", () => {
    const approvalRegistry = new ApprovalRegistry();
    approvalRegistry.approve("plan-abc", "digest-1", process.cwd(), { domain: "database", risk: "write" });
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive", approvalRegistry);
    const cap: BoundaryCapability = {
      resource: "some-other-resource",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "digest-1",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(vault.get("DATABASE_URL", cap)).toBeUndefined();
  });

  it("exclusive mode returns credential without approvalRegistry (backward compat)", () => {
    const approver = new ApprovalRegistry();
    approver.approve("plan-abc", "digest-1", process.cwd(), { domain: "database", risk: "write" });
    // vault not given approvalRegistry — no full validation
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://nocheck..." }), registry, "exclusive");
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-unused",
      planDigest: "digest-unused",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(vault.get("DATABASE_URL", cap)).toBe("postgres://nocheck...");
  });

  it("runWithCapability makes capability available to get() without explicit arg", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "abc",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    let result: string | undefined;
    vault.runWithCapability(cap, () => {
      result = vault.get("DATABASE_URL");
    });
    expect(result).toBe("postgres://...");
  });

  it("runTrusted allows protected credential access in exclusive mode without capability", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    let result: string | undefined;
    vault.runTrusted(() => {
      result = vault.get("DATABASE_URL");
    });
    expect(result).toBe("postgres://...");
  });

  it("nested runWithCapability — inner overrides outer", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    const outerCap: BoundaryCapability = {
      resource: "outer-resource",
      operation: "read",
      planId: "outer",
      planDigest: "o",
      riskLevel: "read",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const innerCap: BoundaryCapability = {
      resource: "inner-resource",
      operation: "write",
      planId: "inner",
      planDigest: "i",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    let innerResult: string | undefined;
    let outerAfterInner: string | undefined;
    vault.runWithCapability(outerCap, () => {
      vault.runWithCapability(innerCap, () => {
        innerResult = vault.get("DATABASE_URL");
      });
      outerAfterInner = vault.get("DATABASE_URL");
    });
    expect(innerResult).toBe("postgres://...");
    expect(outerAfterInner).toBe("postgres://...");
  });

  it("capability cleared after runWithCapability completes (no leak)", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "abc",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    vault.runWithCapability(cap, () => {
      vault.get("DATABASE_URL"); // inside — works
    });
    // After runWithCapability completes, capability should be cleared
    expect(vault.get("DATABASE_URL")).toBeUndefined();
  });

  it("trusted cleared after runTrusted completes (no leak)", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    vault.runTrusted(() => {
      vault.get("DATABASE_URL"); // inside — works
    });
    // After runTrusted completes, trusted should be cleared
    expect(vault.get("DATABASE_URL")).toBeUndefined();
  });

  it("runTrusted + expired explicit capability — still blocked", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://..." }), registry, "exclusive");
    const expired: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "abc",
      riskLevel: "write",
      issuedAt: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    let result: string | undefined;
    vault.runTrusted(() => {
      result = vault.get("DATABASE_URL", expired);
    });
    expect(result).toBeUndefined();
  });

  it("runWithCapability + approvalRegistry — full validation runs", () => {
    const approvalRegistry = new ApprovalRegistry();
    approvalRegistry.approve("plan-approved", "digest-approved", process.cwd(), { domain: "database", risk: "write" });
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://approved..." }), registry, "exclusive", approvalRegistry);
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-approved",
      planDigest: "digest-approved",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    let result: string | undefined;
    vault.runWithCapability(cap, () => {
      result = vault.get("DATABASE_URL");
    });
    expect(result).toBe("postgres://approved...");
  });

  it("runWithCapability + approvalRegistry blocks unapproved capability", () => {
    const approvalRegistry = new ApprovalRegistry();
    // No approve call
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://secret..." }), registry, "exclusive", approvalRegistry);
    const cap: BoundaryCapability = {
      resource: "production-database",
      operation: "execute",
      planId: "plan-unapproved",
      planDigest: "digest-xyz",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    let result: string | undefined;
    vault.runWithCapability(cap, () => {
      result = vault.get("DATABASE_URL");
    });
    expect(result).toBeUndefined();
  });

  it("asCredentialSource returns a CredentialSource routing through vault", () => {
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://...", HOME: "/home/user", VERCEL_TOKEN: "vctok" }), registry, "exclusive");
    const source = vault.asCredentialSource();
    // Without capability, protected credential returns undefined through vault source
    expect(source.get("DATABASE_URL")).toBeUndefined();
    // VERCEL_TOKEN also protected
    expect(source.get("VERCEL_TOKEN")).toBeUndefined();
    // Unprotected credential passes through
    expect(source.get("HOME")).toBe("/home/user");
  });

  it("exclusive mode protects deployment credentials registered via additional resource", () => {
    const vault = new CredentialVault(mockSource({ VERCEL_TOKEN: "my-token" }), registry, "exclusive");
    // Without capability, deployment credential is protected
    expect(vault.get("VERCEL_TOKEN")).toBeUndefined();

    const cap: BoundaryCapability = {
      resource: "vercel-deployment",
      operation: "execute",
      planId: "plan-abc",
      planDigest: "abc",
      riskLevel: "write",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    expect(vault.get("VERCEL_TOKEN", cap)).toBe("my-token");
  });
});
