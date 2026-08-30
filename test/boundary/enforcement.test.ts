import { describe, it, expect, beforeEach } from "vitest";
import * as crypto from "node:crypto";
import { BoundaryEnforcer } from "../../src/boundary/enforcement.js";
import { ProtectedResourceRegistry, createDatabaseResource, createVercelResource, createRailwayResource, createCloudflareResource } from "../../src/boundary/resource.js";
import { mintCapability, validateCapability, mintSignedCapability, verifySignedCapability } from "../../src/boundary/capability.js";
import { generateKeyPair, signCapability } from "../../src/boundary/crypto.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import type { BoundaryCapability, SignedCapability } from "../../src/boundary/types.js";

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

  describe("checkToolCall hostname and filePath enforcement", () => {
    let registry: ProtectedResourceRegistry;

    beforeEach(() => {
      registry = new ProtectedResourceRegistry();
      registry.register(createDatabaseResource({
        hostnames: ["db.example.com"],
        filePaths: ["/etc/secrets"],
      }));
    });

    it("rejects bash call with hostname in exclusive mode", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      const result = enforcer.checkToolCall({
        toolName: "bash",
        input: { command: "psql -h db.example.com -c 'SELECT 1'" },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("db.example.com");
    });

    it("rejects bash call with filePath in exclusive mode", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      const result = enforcer.checkToolCall({
        toolName: "bash",
        input: { command: "cat /etc/secrets/db-password" },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("/etc/secrets");
    });

    it("warns on hostname in warn mode, does not reject", () => {
      const enforcer = new BoundaryEnforcer("warn", registry, true);
      const result = enforcer.checkToolCall({
        toolName: "bash",
        input: { command: "psql -h db.example.com" },
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("warning");
    });

    it("allows DB tool regardless of protected content", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      const result = enforcer.checkToolCall({
        toolName: "DB",
        input: { command: "psql -h db.example.com" },
      });
      expect(result.allowed).toBe(true);
    });

    it("allows ship tool regardless of protected content", () => {
      const enforcer = new BoundaryEnforcer("exclusive", registry, true);
      const result = enforcer.checkToolCall({
        toolName: "ship",
        input: { command: "psql -h db.example.com" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("checkCredentialAccess with signed capabilities", () => {
    let keyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
    let trustedPublicKeys: Map<string, crypto.KeyObject>;
    let registry: ProtectedResourceRegistry;
    let approvalRegistry: ApprovalRegistry;
    let enforcer: BoundaryEnforcer;
    let signer: (claims: Record<string, unknown>) => string;

    beforeEach(() => {
      keyPair = generateKeyPair();
      trustedPublicKeys = new Map();
      trustedPublicKeys.set("test-key-1", keyPair.publicKey);

      registry = new ProtectedResourceRegistry();
      registry.register(createDatabaseResource({ credentialNames: ["DATABASE_URL"] }));

      approvalRegistry = new ApprovalRegistry();

      enforcer = new BoundaryEnforcer(
        "exclusive",
        registry,
        true,
        approvalRegistry,
        process.cwd(),
        trustedPublicKeys,
        "https://pi-ship.test/audience",
      );

      signer = (claims: Record<string, unknown>) => signCapability(claims, keyPair.privateKey);
    });

    it("allows valid signed capability", () => {
      const signed = mintSignedCapability(
        {
          resource: "database/production",
          operation: "write",
          planId: "plan-1",
          planDigest: "digest-abc",
          riskLevel: "write",
          issuer: "pi-ship",
          audience: "https://pi-ship.test/audience",
          projectBinding: "acme-corp/production",
          keyId: "test-key-1",
        },
        signer,
      );

      // Pre-approve the plan so the approval registry check passes
      approvalRegistry.approve("plan-1", "digest-abc", process.cwd(), { domain: "database", risk: "write" });

      const result = enforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
        expectedResource: "database/production",
        expectedProjectBinding: "acme-corp/production",
        expectedPlanId: "plan-1",
        expectedPlanDigest: "digest-abc",
        expectedOperation: "write",
        expectedRisk: "write",
        expectedIssuer: "pi-ship",
        resourceType: "database",
      });

      expect(result.allowed).toBe(true);
    });

    it("rejects wrong audience", () => {
      const signed = mintSignedCapability(
        {
          resource: "database/production",
          operation: "write",
          planId: "plan-1",
          planDigest: "digest-abc",
          riskLevel: "write",
          issuer: "pi-ship",
          audience: "wrong-audience",
          projectBinding: "acme-corp/production",
          keyId: "test-key-1",
        },
        signer,
      );

      const result = enforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
        expectedResource: "database/production",
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("audience");
    });

    it("rejects wrong resource", () => {
      const signed = mintSignedCapability(
        {
          resource: "database/production",
          operation: "write",
          planId: "plan-1",
          planDigest: "digest-abc",
          riskLevel: "write",
          issuer: "pi-ship",
          audience: "https://pi-ship.test/audience",
          projectBinding: "acme-corp/production",
          keyId: "test-key-1",
        },
        signer,
      );

      const result = enforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
        expectedResource: "database/staging", // mismatch
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("resource");
    });

    it("rejects wrong projectBinding", () => {
      const signed = mintSignedCapability(
        {
          resource: "database/production",
          operation: "write",
          planId: "plan-1",
          planDigest: "digest-abc",
          riskLevel: "write",
          issuer: "pi-ship",
          audience: "https://pi-ship.test/audience",
          projectBinding: "acme-corp/production",
          keyId: "test-key-1",
        },
        signer,
      );

      const result = enforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
        expectedProjectBinding: "other-corp/staging", // mismatch
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("projectBinding");
    });

    it("rejects expired capability", () => {
      // mintSignedCapability validates ttlMs > 0, so manually construct an expired capability
      const jti = crypto.randomUUID();
      const claims: Record<string, unknown> = {
        version: 1,
        resource: "database/production",
        operation: "write",
        planId: "plan-1",
        planDigest: "digest-abc",
        riskLevel: "write",
        issuedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second in the past
        keyId: "test-key-1",
        issuer: "pi-ship",
        audience: "https://pi-ship.test/audience",
        projectBinding: "acme-corp/production",
        jti,
      };
      const signature = signCapability(claims, keyPair.privateKey);
      const signed: SignedCapability = { ...claims, signature } as SignedCapability;

      const result = enforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("rejects signed with wrong key (invalid signature)", () => {
      const otherPair = generateKeyPair();
      const wrongSigner = (claims: Record<string, unknown>) => signCapability(claims, otherPair.privateKey);

      const signed = mintSignedCapability(
        {
          resource: "database/production",
          operation: "write",
          planId: "plan-1",
          planDigest: "digest-abc",
          riskLevel: "write",
          issuer: "pi-ship",
          audience: "https://pi-ship.test/audience",
          projectBinding: "acme-corp/production",
          keyId: "test-key-1",
        },
        wrongSigner,
      );

      const result = enforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("signature");
    });

    it("rejects when trustedPublicKeys not configured", () => {
      const noKeysEnforcer = new BoundaryEnforcer(
        "exclusive",
        registry,
        true,
        approvalRegistry,
        process.cwd(),
        undefined,
        undefined,
      );

      const signed = mintSignedCapability(
        {
          resource: "database/production",
          operation: "write",
          planId: "plan-1",
          planDigest: "digest-abc",
          riskLevel: "write",
          issuer: "pi-ship",
          audience: "https://pi-ship.test/audience",
          projectBinding: "acme-corp/production",
          keyId: "test-key-1",
        },
        signer,
      );

      const result = noKeysEnforcer.checkCredentialAccess({
        credentialName: "DATABASE_URL",
        caller: "test",
        capability: signed,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("signed capability verification not configured");
    });
  });
});
