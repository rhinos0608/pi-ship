import { describe, it, expect } from "vitest";
import { loadBoundaryConfig } from "../../../src/boundary/config.js";
import { ProtectedResourceRegistry, createDatabaseResource, createVercelResource } from "../../../src/boundary/resource.js";
import { CredentialVault } from "../../../src/boundary/vault.js";
import { BoundaryEnforcer } from "../../../src/boundary/enforcement.js";
import { mintCapability } from "../../../src/boundary/capability.js";
import type { CredentialSource } from "../../../src/deployment/credentials.js";

function mockSource(vars: Record<string, string | undefined>): CredentialSource {
  return { get: (name: string) => vars[name] };
}

describe("full boundary integration", () => {
  it("exclusive mode: bash cannot access DATABASE_URL, DB tool can with capability", () => {
    const config = loadBoundaryConfig({ databaseAccess: { mode: "exclusive" } });
    const resources = new ProtectedResourceRegistry();
    resources.register(createDatabaseResource());
    const enforcer = new BoundaryEnforcer(config.mode, resources, true);
    const vault = new CredentialVault(mockSource({ DATABASE_URL: "postgres://secret@host/db" }), resources, config.mode);

    // Bash tool: blocked from seeing DATABASE_URL
    const bashCheck = enforcer.checkToolCall({ toolName: "bash", input: { command: "psql $DATABASE_URL" } });
    expect(bashCheck.allowed).toBe(false);

    // Direct credential access without capability: blocked
    const directAccess = vault.get("DATABASE_URL");
    expect(directAccess).toBeUndefined();

    // DB tool with valid capability: allowed
    const cap = mintCapability({
      resource: "production-database",
      operation: "execute",
      planId: "plan-abc-123",
      planDigest: "abc123",
      riskLevel: "write",
    });
    const dbAccess = vault.get("DATABASE_URL", cap);
    expect(dbAccess).toBe("postgres://secret@host/db");

    // DB tool call itself: always allowed
    const dbCheck = enforcer.checkToolCall({ toolName: "DB", input: { action: "inspect" } });
    expect(dbCheck.allowed).toBe(true);
  });

  it("warn mode: bash gets warning but still allowed", () => {
    const config = loadBoundaryConfig({ databaseAccess: { mode: "warn" } });
    const resources = new ProtectedResourceRegistry();
    resources.register(createDatabaseResource());
    const enforcer = new BoundaryEnforcer(config.mode, resources, false);

    const bashCheck = enforcer.checkToolCall({ toolName: "bash", input: { command: "psql $DATABASE_URL" } });
    expect(bashCheck.allowed).toBe(true);
    expect(bashCheck.reason).toContain("warning");
  });

  it("managed mode: everything passes through", () => {
    const config = loadBoundaryConfig({ databaseAccess: { mode: "managed" } });
    expect(config.mode).toBe("managed");
    // No enforcement — DB tool gates operations through its own approval flow
  });

  it("exclusive mode: blocks deployment credential in bash, allows non-credential bash and DB", () => {
    const config = loadBoundaryConfig({ databaseAccess: { mode: "exclusive" } });
    const resources = new ProtectedResourceRegistry();
    resources.register(createDatabaseResource());
    resources.register(createVercelResource());
    const enforcer = new BoundaryEnforcer(config.mode, resources, true);

    // Non-credential bash: allowed
    const safe = enforcer.checkToolCall({ toolName: "bash", input: { command: "echo hello" } });
    expect(safe.allowed).toBe(true);

    // Database credential in bash: blocked
    const dbLeak = enforcer.checkToolCall({ toolName: "bash", input: { command: "psql $DATABASE_URL" } });
    expect(dbLeak.allowed).toBe(false);
    expect(dbLeak.reason).toContain("DATABASE_URL");

    // Deployment credential in bash: blocked
    const deployLeak = enforcer.checkToolCall({ toolName: "bash", input: { command: "echo $VERCEL_TOKEN" } });
    expect(deployLeak.allowed).toBe(false);
    expect(deployLeak.reason).toContain("VERCEL_TOKEN");

    // DB tool always allowed (it IS the boundary)
    const dbTool = enforcer.checkToolCall({ toolName: "DB", input: { action: "inspect" } });
    expect(dbTool.allowed).toBe(true);

    // Ship tool always allowed
    const shipTool = enforcer.checkToolCall({ toolName: "ship", input: { action: "validate" } });
    expect(shipTool.allowed).toBe(true);
  });

  // Pi event-system integration: the BoundaryEnforcer's checkToolCall is wired
  // into pi.on("tool_call", ...) in registerBoundary (register.ts). DB and ship
  // events pass through; other tools are checked for credential references.
  // The handler returns { block: true, reason } when a credential is detected
  // in exclusive mode, or undefined to allow.

  it("exclusive mode without boundary extension throws at startup", () => {
    const resources = new ProtectedResourceRegistry();
    resources.register(createDatabaseResource());
    const enforcer = new BoundaryEnforcer("exclusive", resources, false);
    expect(() => enforcer.validateStartup()).toThrow("requires an active boundary");
  });
});
