import { describe, it, expect, beforeEach } from "vitest";
import { BoundaryEnforcer } from "../../src/boundary/enforcement.js";
import { ProtectedResourceRegistry, createDatabaseResource, createVercelResource, createRailwayResource, createCloudflareResource } from "../../src/boundary/resource.js";
import { mintCapability, validateCapability } from "../../src/boundary/capability.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import type { BoundaryCapability } from "../../src/boundary/types.js";

describe("BoundaryEnforcer", () => {
  let registry: ProtectedResourceRegistry;

  beforeEach(() => {
    registry = new ProtectedResourceRegistry();
    registry.register(createDatabaseResource());
  });

  describe("validateStartup", () => {
    it("passes for managed mode without boundary", () => {
      const enforcer = new BoundaryEnforcer("managed", registry, false);
      expect(() => enforcer.validateStartup()).not.toThrow();
    });

    it("passes for warn mode without boundary", () => {
      const enforcer = new BoundaryEnforcer("warn", registry, false);
      expect(() => enforcer.validateStartup()).not.toThrow();
    });

    it("throws for exclusive mode without boundary", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, false);
      expect(() => enforcer.validateStartup()).toThrow("requires an active boundary (install pi-permission-system)");
    });

    it("passes for exclusive mode with boundary", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      expect(() => enforcer.validateStartup()).not.toThrow();
    });
  });

  describe("checkToolCall", () => {
    it("managed mode allows everything", () => {
      const enforcer = new BoundaryEnforcer("managed", registry, false);
      expect(enforcer.checkToolCall({ toolName: "bash", input: { command: "echo $DATABASE_URL" } }).allowed).toBe(true);
    });

    it("DB tool always allowed in all modes", () => {
      for (const mode of ["managed", "warn", "exclusive"] as const) {
        const enforcer = new BoundaryEnforcer(mode, registry, mode === "exclusive");
        expect(enforcer.checkToolCall({ toolName: "DB", input: { action: "inspect" } }).allowed).toBe(true);
      }
    });

    it("ship tool always allowed in all modes", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      expect(enforcer.checkToolCall({ toolName: "ship", input: { action: "deploy" } }).allowed).toBe(true);
    });

    it("warn mode allows but flags credential in bash", () => {
      const enforcer = new BoundaryEnforcer("warn", registry, false);
      const result = enforcer.checkToolCall({ toolName: "bash", input: { command: "psql $DATABASE_URL" } });
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("warning");
    });

    it("exclusive mode blocks credential in non-protected tool", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      const result = enforcer.checkToolCall({ toolName: "bash", input: { command: "psql $DATABASE_URL" } });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("DATABASE_URL");
    });

    it("exclusive mode allows non-credential bash commands", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      expect(enforcer.checkToolCall({ toolName: "bash", input: { command: "ls -la" } }).allowed).toBe(true);
    });

    describe("deployment credential detection", () => {
      it("exclusive mode blocks VERCEL_TOKEN in bash input", () => {
        const reg = new ProtectedResourceRegistry();
        reg.register(createVercelResource());
        const enforcer = new BoundaryEnforcer("exclusive", reg, true);
        const result = enforcer.checkToolCall({ toolName: "bash", input: { command: "echo $VERCEL_TOKEN" } });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("VERCEL_TOKEN");
      });

      it("exclusive mode blocks RAILWAY_API_TOKEN in bash input", () => {
        const reg = new ProtectedResourceRegistry();
        reg.register(createRailwayResource());
        const enforcer = new BoundaryEnforcer("exclusive", reg, true);
        const result = enforcer.checkToolCall({ toolName: "bash", input: { command: "echo $RAILWAY_API_TOKEN" } });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("RAILWAY_API_TOKEN");
      });

      it("exclusive mode blocks CLOUDFLARE_API_TOKEN in bash input", () => {
        const reg = new ProtectedResourceRegistry();
        reg.register(createCloudflareResource());
        const enforcer = new BoundaryEnforcer("exclusive", reg, true);
        const result = enforcer.checkToolCall({ toolName: "bash", input: { command: "echo $CLOUDFLARE_API_TOKEN" } });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("CLOUDFLARE_API_TOKEN");
      });
    });
  });

  describe("checkCredentialAccess", () => {
    it("allows unprotected credentials in all modes", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      expect(enforcer.checkCredentialAccess({ credentialName: "HOME", caller: "bash" }).allowed).toBe(true);
    });

    it("managed mode allows protected credentials", () => {
      const enforcer = new BoundaryEnforcer("managed", registry, false);
      expect(enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "bash" }).allowed).toBe(true);
    });

    it("warn mode allows but flags protected credentials", () => {
      const enforcer = new BoundaryEnforcer("warn", registry, false);
      const result = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "bash" });
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("warning");
    });

    it("exclusive mode blocks protected credentials without capability", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      const result = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "bash" });
      expect(result.allowed).toBe(false);
    });

    it("exclusive mode blocks protected credentials with expired capability", () => {
      const approvalRegistry = new ApprovalRegistry();
      const enforcer = new BoundaryEnforcer("exclusive", registry, true, approvalRegistry);
      const expired: BoundaryCapability = {
        resource: "db", operation: "execute", planId: "p-1", planDigest: "x", riskLevel: "write",
        issuedAt: new Date(Date.now() - 600_000).toISOString(),
        expiresAt: new Date(Date.now() - 1).toISOString(),
      };
      expect(enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "DB", capability: expired }).allowed).toBe(false);
    });

    it("exclusive mode allows protected credentials with valid capability", () => {
      const approvalRegistry = new ApprovalRegistry();
      approvalRegistry.approve("p-1", "x", process.cwd(), { domain: "database", risk: "write" });
      const enforcer = new BoundaryEnforcer("exclusive", registry, true, approvalRegistry);
      const cap = mintCapability({
        resource: "production-database",
        operation: "execute",
        planId: "p-1",
        planDigest: "x",
        riskLevel: "write",
      });
      expect(enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "DB", capability: cap }).allowed).toBe(true);
    });

    it("validateCapability rejects manually constructed capability without planId", () => {
      const approvalRegistry = new ApprovalRegistry("/tmp/test");
      const cap = {
        resource: "production-database",
        operation: "execute",
        planId: "",
        planDigest: "x",
        riskLevel: "write",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      } as BoundaryCapability;
      const result = validateCapability(
        cap, "production-database", "p-1", "x",
        approvalRegistry, "/tmp/test", "database",
        "execute", "write",
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("plan id");
    });
  });
});
