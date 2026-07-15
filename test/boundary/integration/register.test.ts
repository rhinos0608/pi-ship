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

describe("registerBoundary", () => {
  let tmpDir: string;
  let pi: PiMock;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-reg-test-"));
    pi = { on: () => undefined };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns BoundaryRegistration for exclusive mode (isBoundaryActive=true)", async () => {
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
});
