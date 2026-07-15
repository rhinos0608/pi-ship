import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import type { CredentialSource } from "../../../src/deployment/credentials.js";

function makeCredentialSource(vars: Record<string, string | undefined>): CredentialSource {
  return { get: (name: string) => vars[name] };
}

interface PiMock {
  registerTool?: (def: unknown) => void;
  on?: (event: string, handler: (...args: unknown[]) => unknown) => void;
}

/**
 * Set/unset the pi-permission-system runtime sentinel for tests.
 * registerBoundary calls detectPermissionSystem() which probes globalThis.
 */
function setPermissionSystemSentinel(active: boolean): void {
  if (active) {
    (globalThis as any).__piPermissionSystem = {
      getYoloMode: () => false,
      setYoloMode: () => undefined,
      toggleYoloMode: () => ({ error: undefined }),
    };
  } else {
    delete (globalThis as any).__piPermissionSystem;
  }
}

describe("registerBoundary", () => {
  let tmpDir: string;
  let pi: PiMock;

  const registeredHandlers: Record<string, Function> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-reg-test-"));
    pi = { on: (event: string, handler: (...args: unknown[]) => unknown) => { registeredHandlers[event] = handler; } };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as any).__piPermissionSystem;
  });

  it("returns BoundaryRegistration for exclusive mode with pi-permission-system active", async () => {
    writeFileSync(
      join(tmpDir, "pi-ship.json"),
      JSON.stringify({
        name: "boundary-test",
        provider: "railway",
        project: "boundary-test",
        run: { command: ["node", "server.js"] },
        databaseAccess: { mode: "exclusive" },
      }),
    );

    // Simulate pi-permission-system loaded and active.
    setPermissionSystemSentinel(true);

    const { registerBoundary } = await import("../../../src/boundary/integration/register.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const approvalRegistry = new ApprovalRegistry();
    const source = makeCredentialSource({ DATABASE_URL: "postgres://test" });

    const result = await registerBoundary(pi as any, tmpDir, source, approvalRegistry);

    expect(result).not.toBeNull();
    expect(result!.vault).toBeDefined();
    expect(result!.enforcer).toBeDefined();
    expect(result!.resources).toBeDefined();
    // validateStartup does not throw because isBoundaryActive is true
    expect(() => result!.enforcer.validateStartup()).not.toThrow();

    // tool_call handler registered
    expect(typeof registeredHandlers["tool_call"]).toBe("function");

    // Invoke tool_call handler with DB tool (always allowed)
    const dbResult = registeredHandlers["tool_call"]({ type: "tool_call", toolName: "DB", input: { action: "inspect", sql: "SELECT 1" } });
    expect(dbResult).toBeUndefined();

    // Invoke with ship tool (always allowed)
    const shipResult = registeredHandlers["tool_call"]({ type: "tool_call", toolName: "ship", input: { action: "status" } });
    expect(shipResult).toBeUndefined();

    // Invoke with bash tool referencing protected credential
    const bashBlocked = registeredHandlers["tool_call"]({ type: "tool_call", toolName: "bash", input: { command: "echo $DATABASE_URL" } });
    expect(bashBlocked).toBeDefined();
    expect(bashBlocked.block).toBe(true);
  });

  it("returns null for managed mode", async () => {
    writeFileSync(
      join(tmpDir, "pi-ship.json"),
      JSON.stringify({
        name: "boundary-test",
        provider: "railway",
        databaseAccess: { mode: "managed" },
      }),
    );

    const { registerBoundary } = await import("../../../src/boundary/integration/register.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const approvalRegistry = new ApprovalRegistry();
    const source = makeCredentialSource({});

    const result = await registerBoundary(pi as any, tmpDir, source, approvalRegistry);
    expect(result).toBeNull();
  });

  it("returns null when manifest has no databaseAccess config (default managed)", async () => {
    writeFileSync(
      join(tmpDir, "pi-ship.json"),
      JSON.stringify({
        name: "boundary-test",
        provider: "railway",
      }),
    );

    const { registerBoundary } = await import("../../../src/boundary/integration/register.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const approvalRegistry = new ApprovalRegistry();
    const source = makeCredentialSource({});

    const result = await registerBoundary(pi as any, tmpDir, source, approvalRegistry);
    expect(result).toBeNull();
  });

  it("returns BoundaryRegistration for warn mode", async () => {
    writeFileSync(
      join(tmpDir, "pi-ship.json"),
      JSON.stringify({
        name: "boundary-test",
        provider: "railway",
        databaseAccess: { mode: "warn" },
      }),
    );

    const { registerBoundary } = await import("../../../src/boundary/integration/register.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const approvalRegistry = new ApprovalRegistry();
    const source = makeCredentialSource({});

    const result = await registerBoundary(pi as any, tmpDir, source, approvalRegistry);
    expect(result).not.toBeNull();
  });

  it("exclusive mode throws when pi-permission-system is not detected", async () => {
    writeFileSync(
      join(tmpDir, "pi-ship.json"),
      JSON.stringify({
        name: "boundary-test",
        provider: "railway",
        databaseAccess: { mode: "exclusive" },
      }),
    );

    // No pi-permission-system sentinel set.
    setPermissionSystemSentinel(false);

    const { registerBoundary } = await import("../../../src/boundary/integration/register.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const approvalRegistry = new ApprovalRegistry();
    const source = makeCredentialSource({ DATABASE_URL: "postgres://test" });

    await expect(
      registerBoundary(pi as any, tmpDir, source, approvalRegistry),
    ).rejects.toThrow("requires an active boundary (install pi-permission-system)");
  });
});
