import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { shipSchema, type ShipInput } from "../../../src/tools/ship/schema.js";
import { DBSchema, type DBInput } from "../../../src/tools/db/schema.js";

describe("shipSchema", () => {
  it("accepts each ship action and rejects extra fields", () => {
    for (const value of [
      { action: "validate" },
      { action: "plan", environment: "production" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
      { action: "status" },
      { action: "logs", lines: 10 },
      {
        action: "plan",
        environment: "production",
        intent: "rollback",
        targetReleaseId: "r",
      },
    ]) {
      expect(Value.Check(shipSchema, value), JSON.stringify(value)).toBe(true);
    }
    expect(Value.Check(shipSchema, { action: "status", extra: true })).toBe(false);
  });

  it("rejects unknown actions", () => {
    expect(Value.Check(shipSchema, { action: "destroy" })).toBe(false);
  });

  it("rejects apply_plan without planDigest", () => {
    expect(Value.Check(shipSchema, { action: "apply_plan", planId: "p" })).toBe(false);
  });

  it("rejects logs without integer lines", () => {
    expect(Value.Check(shipSchema, { action: "logs", lines: "abc" })).toBe(false);
  });

  it("public shipSchema accepts production plan with optional previewId (legacy compat)", () => {
    expect(Value.Check(shipSchema, { action: "plan", environment: "production", previewId: "pr-7" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(true);
  });

  it("Vercel composed schema rejects previewId on production plan", async () => {
    const { composeShipSchema } = await import("../../../src/tools/ship/schema.js");
    const { vercelCapabilityProfile } = await import("../../../src/providers/capability-profile.js");
    const vercelShip = composeShipSchema(vercelCapabilityProfile.ship);
    expect(Value.Check(vercelShip, { action: "plan", environment: "production", previewId: "pr-7" })).toBe(false);
    expect(Value.Check(vercelShip, { action: "plan", environment: "production" })).toBe(true);
  });

  it("Cloudflare composed schema rejects previewId on production plan", async () => {
    const { composeShipSchema } = await import("../../../src/tools/ship/schema.js");
    const { cloudflareCapabilityProfile } = await import("../../../src/providers/capability-profile.js");
    const cfShip = composeShipSchema(cloudflareCapabilityProfile.ship);
    expect(Value.Check(cfShip, { action: "plan", environment: "production", previewId: "pr-7" })).toBe(false);
    expect(Value.Check(cfShip, { action: "plan", environment: "production" })).toBe(true);
  });

  it("Railway composed schema still requires previewId for preview", async () => {
    const { composeShipSchema } = await import("../../../src/tools/ship/schema.js");
    const { railwayCapabilityProfile } = await import("../../../src/providers/capability-profile.js");
    const railShip = composeShipSchema(railwayCapabilityProfile.ship);
    expect(Value.Check(railShip, { action: "plan", environment: "preview" })).toBe(false);
    expect(Value.Check(railShip, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(true);
  });
});

describe("DBSchema", () => {
  it("accepts DB actions and rejects provision", () => {
    for (const value of [
      { action: "inspect" }, { action: "migration_status" }, { action: "plan_migration" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
      { action: "browse", table: "items", limit: 1, offset: 0 },
      { action: "query", sql: "select 1", limit: 1 }, { action: "plan", sql: "select 1" },
    ]) expect(Value.Check(DBSchema, value), JSON.stringify(value)).toBe(true);
    expect(Value.Check(DBSchema, { action: "provision" })).toBe(false);
  });
});

describe("ship tool registration", () => {
  const exec = promisify(execFile);
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-shiptool-"));
    await exec("git", ["init"], { cwd });
    await exec("git", ["config", "user.email", "t@t.local"], { cwd });
    await exec("git", ["config", "user.name", "T"], { cwd });
    await writeFile(join(cwd, "x"), "y");
    await exec("git", ["add", "."], { cwd });
    await exec("git", ["commit", "-m", "init"], { cwd });
    await writeFile(
      join(cwd, "pi-ship.json"),
      JSON.stringify({
        name: "ship-tool-test",
        provider: "railway",
        project: "ship-tool-test",
        run: { command: ["node", "server.js"] },
        secrets: ["APP_SECRET"],
      })
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("registers the tool with a strict Typebox schema", async () => {
    const calls: { name: string; def: { parameters: unknown } }[] = [];
    const pi = {
      registerTool: (def: { name: string; parameters: unknown }) => {
        calls.push({ name: def.name, def: def as { parameters: unknown } });
      },
    };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const registry = new ApprovalRegistry(cwd);
    registerShip(pi as unknown as never, registry);
    expect(calls[0]?.name).toBe("ship");
    expect(calls[0]?.def.parameters).toBe(shipSchema);
  });

  it("validates input and rejects invalid params with E_CONFIG_INVALID", async () => {
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const registry = new ApprovalRegistry(cwd);
    let registeredExecute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = {
      registerTool: (def: {
        name: string;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) => {
        registeredExecute = def.execute;
      },
    };
    registerShip(pi as unknown as never, registry);
    expect(registeredExecute).toBeDefined();
    await expect(
      registeredExecute!(
        "tool-call-id",
        { action: "destroy" } as unknown as ShipInput,
        undefined,
        undefined,
        { cwd }
      )
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // ── V2 tool tests with fake fetch ────────────────────────────────────────
  // These tests verify that V2 handlers use injected fetch and never hit live APIs

  it("V2 validate reports missing VERCEL_TOKEN and app secret", async () => {
    const exec = promisify(execFile);
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-shiptool-v2-"));
    try {
      await exec("git", ["init"], { cwd });
      await exec("git", ["config", "user.email", "t@t.local"], { cwd });
      await exec("git", ["config", "user.name", "T"], { cwd });
      await writeFile(join(cwd, "index.js"), "module.exports = {};");
      await exec("git", ["add", "."], { cwd });
      await exec("git", ["commit", "-m", "init"], { cwd });
      await writeFile(
        join(cwd, "pi-ship.json"),
        JSON.stringify({
          version: 2,
          name: "v2-tool-test",
          app: { provider: "vercel", config: { projectName: "v2-tool-test" } },
          secrets: ["MY_APP_SECRET"],
        })
      );

      const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
      const pi = { registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { calls.push(def as any); } };
      const { registerShip } = await import("../../../src/tools/ship/index.js");
      const { ApprovalRegistry } = await import("../../../src/core/approval.js");
      const registry = new ApprovalRegistry(cwd);

      // Use a credentialSource that has VERCEL_TOKEN but not MY_APP_SECRET
      const credentialSource = { get: (name: string) => name === "VERCEL_TOKEN" ? "tok_test" : undefined };
      // Use a recording fetch to capture all URLs
      const seenUrls: string[] = [];
      const fetchImpl = async (url: string) => {
        seenUrls.push(url);
        // Return valid API responses
        return new Response(
          url.includes("/v2/user")
            ? JSON.stringify({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } })
            : url.includes("/v10/projects")
            ? JSON.stringify({ projects: [] })
            : JSON.stringify({}),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      registerShip(pi as any, registry, { credentialSource, fetchImpl });
      const execute = calls[0].execute;

      // Validate action
      const validateResult = await execute("id", { action: "validate" }, undefined, undefined, { cwd }) as any;
      // VERCEL_TOKEN is provided so not missing
      expect(validateResult.details.missingSecrets).not.toContain("VERCEL_TOKEN");
      // MY_APP_SECRET missing since credentialSource doesn't provide it
      expect(validateResult.details.missingSecrets).toContain("MY_APP_SECRET");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("V2 plan with persisted team state uses teamId query and plan identity", async () => {
    const exec = promisify(execFile);
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-shiptool-teamplan-"));
    try {
      await exec("git", ["init"], { cwd });
      await exec("git", ["config", "user.email", "t@t.local"], { cwd });
      await exec("git", ["config", "user.name", "T"], { cwd });
      await writeFile(join(cwd, ".gitignore"), ".pi-ship\n");
      await writeFile(join(cwd, "index.js"), "module.exports = {};");
      await exec("git", ["add", "."], { cwd });
      await exec("git", ["commit", "-m", "init"], { cwd });
      await writeFile(
        join(cwd, "pi-ship.json"),
        JSON.stringify({
          version: 2,
          name: "team-plan-test",
          app: { provider: "vercel", config: { projectName: "team-plan-test" } },
        })
      );

      // Persist a state with a team account (no teamId in manifest)
      const stateDir = join(cwd, ".pi-ship");
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        app: {
          provider: "vercel",
          account: { kind: "team", id: "team-1" },
          accountFingerprint: "af1",
          project: { id: "p1", name: "existing", fingerprint: "pf1" },
          environments: {},
        },
        databases: {},
        releases: [],
        history: [],
      }));

      const seenUrls: string[] = [];
      const fetchImpl = async (url: string) => {
        seenUrls.push(url);
        return new Response(
          url.includes("/v2/user")
            ? JSON.stringify({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } })
            : JSON.stringify({ projects: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
      const pi = {
        registerTool: (def: any) => calls.push(def),
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      };
      const { registerShip } = await import("../../../src/tools/ship/index.js");
      const { ApprovalRegistry } = await import("../../../src/core/approval.js");
      const registry = new ApprovalRegistry(cwd);
      const credentialSource = { get: (name: string) => name === "VERCEL_TOKEN" ? "tok_test" : undefined };

      registerShip(pi as any, registry, { credentialSource, fetchImpl });
      const execute = calls[0].execute;

      const planResult = await execute("id", { action: "plan", environment: "production" }, undefined, undefined, { cwd }) as any;
      expect(planResult.details.environment).toBe("production");
      expect(planResult.details.operationCount).toBeGreaterThan(0);

      // All API URLs should be team-scoped
      expect(seenUrls.length).toBeGreaterThan(0);
      for (const url of seenUrls) {
        expect(new URL(url).searchParams.get("teamId")).toBe("team-1");
      }

      // Plan identity account should be the team from persisted state
      const { loadVercelPlan } = await import("../../../src/providers/vercel/plan.js");
      const plan = await loadVercelPlan(cwd, planResult.details.planId);
      expect(plan.identity.account).toEqual({ kind: "team", id: "team-1" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("V2 plan with fake fetch captures all URLs", async () => {
    const exec = promisify(execFile);
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-shiptool-v2plan-"));
    try {
      await exec("git", ["init"], { cwd });
      await exec("git", ["config", "user.email", "t@t.local"], { cwd });
      await exec("git", ["config", "user.name", "T"], { cwd });
      await writeFile(join(cwd, ".gitignore"), ".pi-ship\n");
      await writeFile(join(cwd, "index.js"), "module.exports = {};");
      await exec("git", ["add", "."], { cwd });
      await exec("git", ["commit", "-m", "init"], { cwd });
      await writeFile(
        join(cwd, "pi-ship.json"),
        JSON.stringify({
          version: 2,
          name: "v2-plan-test",
          app: { provider: "vercel", config: { projectName: "v2-plan-test" } },
        })
      );

      const seenUrls: string[] = [];
      const fetchImpl = async (url: string) => {
        seenUrls.push(url);
        return new Response(
          url.includes("/v2/user")
            ? JSON.stringify({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } })
            : url.includes("/v10/projects")
            ? JSON.stringify({ projects: [] })
            : JSON.stringify({}),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
      const pi = {
        registerTool: (def: any) => calls.push(def),
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      };
      const { registerShip } = await import("../../../src/tools/ship/index.js");
      const { ApprovalRegistry } = await import("../../../src/core/approval.js");
      const registry = new ApprovalRegistry(cwd);
      const credentialSource = { get: (name: string) => name === "VERCEL_TOKEN" ? "tok_test" : undefined };

      registerShip(pi as any, registry, { credentialSource, fetchImpl });
      const execute = calls[0].execute;

      // Plan action - should use fake fetch, not real
      const planResult = await execute("id", { action: "plan", environment: "production" }, undefined, undefined, { cwd }) as any;
      expect(planResult.details.environment).toBe("production");
      expect(planResult.details.operationCount).toBeGreaterThan(0);
      // Verify all URLs went through fake fetch (no native fetch used)
      expect(seenUrls.length).toBeGreaterThan(0);
      // All URLs should be API endpoints, not native fetch
      for (const url of seenUrls) {
        expect(url).toContain("api.vercel.com");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("V2 apply rejects source drift before mutation", async () => {
    const driftCwd = await mkdtemp(join(tmpdir(), "pi-ship-shiptool-drift-"));
    try {
      await exec("git", ["init"], { cwd: driftCwd });
      await exec("git", ["config", "user.email", "t@t.local"], { cwd: driftCwd });
      await exec("git", ["config", "user.name", "T"], { cwd: driftCwd });
      await writeFile(join(driftCwd, ".gitignore"), ".pi-ship\n");
      await writeFile(join(driftCwd, "index.js"), "module.exports = {};");
      await writeFile(join(driftCwd, "pi-ship.json"), JSON.stringify({
        version: 2,
        name: "drift-test",
        app: { provider: "vercel", config: { projectName: "drift-test" } },
      }));
      await exec("git", ["add", "."], { cwd: driftCwd });
      await exec("git", ["commit", "-m", "init"], { cwd: driftCwd });

      const requests: Array<{ method: string; url: string }> = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        requests.push({ method: init?.method ?? "GET", url });
        return new Response(
          url.includes("/v2/user")
            ? JSON.stringify({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } })
            : JSON.stringify({ projects: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      let executeTool: ((...args: unknown[]) => Promise<unknown>) | undefined;
      const pi = {
        registerTool(definition: unknown) {
          executeTool = (definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
        },
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      };
      const { registerShip } = await import("../../../src/tools/ship/index.js");
      const { ApprovalRegistry } = await import("../../../src/core/approval.js");
      registerShip(pi as never, new ApprovalRegistry(driftCwd), {
        credentialSource: { get: (name: string) => name === "VERCEL_TOKEN" ? "tok_test" : undefined },
        fetchImpl,
      });
      if (!executeTool) throw new Error("ship execute not registered");
      const ctx = { cwd: driftCwd, hasUI: true, ui: { confirm: async () => true } };
      const planResult = await executeTool("id", { action: "plan", environment: "production" }, undefined, undefined, ctx) as {
        details: { planId: string; planDigest: string; approved: boolean };
      };
      expect(planResult.details.approved).toBe(true);

      await writeFile(join(driftCwd, "index.js"), "module.exports = { modified: true };");
      await exec("git", ["add", "index.js"], { cwd: driftCwd });
      const applyRequestStart = requests.length;
      await expect(executeTool("id", {
        action: "apply_plan",
        planId: planResult.details.planId,
        planDigest: planResult.details.planDigest,
      }, undefined, undefined, ctx)).rejects.toMatchObject({
        code: expect.stringMatching(/^E_(PLAN_STALE|STATE_CONFLICT)$/),
      });
      expect(requests.slice(applyRequestStart).filter(({ method }) => method === "POST" || method === "PATCH")).toEqual([]);
    } finally {
      await rm(driftCwd, { recursive: true, force: true });
    }
  });

  it("V2 blocks ambiguous deployment transport without a second deployment POST", async () => {
    const ambiguousCwd = await mkdtemp(join(tmpdir(), "pi-ship-shiptool-ambiguous-"));
    try {
      await exec("git", ["init"], { cwd: ambiguousCwd });
      await exec("git", ["config", "user.email", "t@t.local"], { cwd: ambiguousCwd });
      await exec("git", ["config", "user.name", "T"], { cwd: ambiguousCwd });
      await writeFile(join(ambiguousCwd, ".gitignore"), ".pi-ship\n");
      await writeFile(join(ambiguousCwd, "index.js"), "module.exports = {};");
      await writeFile(join(ambiguousCwd, "pi-ship.json"), JSON.stringify({
        version: 2,
        name: "ambiguous-test",
        app: { provider: "vercel", config: { projectName: "ambiguous-test" } },
      }));
      await exec("git", ["add", "."], { cwd: ambiguousCwd });
      await exec("git", ["commit", "-m", "init"], { cwd: ambiguousCwd });

      let deploymentPosts = 0;
      let projectExists = false;
      const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        if (url.includes("/v2/user")) {
          return new Response(JSON.stringify({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/v10/projects") && method === "GET") {
          return new Response(JSON.stringify({ projects: projectExists ? [{ id: "p1", name: "ambiguous-test" }] : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/v11/projects") && method === "POST") {
          projectExists = true;
          return new Response(JSON.stringify({ id: "p1", name: "ambiguous-test" }), { status: 201, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/v2/files") && method === "POST") {
          return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/v13/deployments") && method === "POST") {
          deploymentPosts += 1;
          throw new TypeError("connection reset after request write");
        }
        throw new Error(`unexpected fake request: ${method} ${url}`);
      };
      let executeTool: ((...args: unknown[]) => Promise<unknown>) | undefined;
      const pi = {
        registerTool(definition: unknown) {
          executeTool = (definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
        },
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      };
      const { registerShip } = await import("../../../src/tools/ship/index.js");
      const { ApprovalRegistry } = await import("../../../src/core/approval.js");
      registerShip(pi as never, new ApprovalRegistry(ambiguousCwd), {
        credentialSource: { get: (name: string) => name === "VERCEL_TOKEN" ? "tok_test" : undefined },
        fetchImpl,
      });
      if (!executeTool) throw new Error("ship execute not registered");
      const ctx = { cwd: ambiguousCwd, hasUI: true, ui: { confirm: async () => true } };
      const planResult = await executeTool("id", { action: "plan", environment: "production" }, undefined, undefined, ctx) as {
        details: { planId: string; planDigest: string; approved: boolean };
      };
      expect(planResult.details.approved).toBe(true);
      await expect(executeTool("id", {
        action: "apply_plan",
        planId: planResult.details.planId,
        planDigest: planResult.details.planDigest,
      }, undefined, undefined, ctx)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
      expect(deploymentPosts).toBe(1);
    } finally {
      await rm(ambiguousCwd, { recursive: true, force: true });
    }
  });

  it("validate action reports missing secrets", async () => {
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const registry = new ApprovalRegistry(cwd);
    let registeredExecute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = {
      registerTool: (def: {
        name: string;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) => {
        registeredExecute = def.execute;
      },
    };
    registerShip(pi as unknown as never, registry);
    const result = (await registeredExecute!(
      "id",
      { action: "validate" } as ShipInput,
      undefined,
      undefined,
      { cwd }
    )) as { details: { missingSecrets: string[] } };
    expect(result.details.missingSecrets).toContain("APP_SECRET");
  });

  // ── Vault boundary enforcement tests ────────────────────────────────

  it("non-mutating actions call runTrusted when vault present", async () => {
    let runTrustedCalled = false;
    const mockVault = {
      runTrusted: (fn: () => unknown) => {
        runTrustedCalled = true;
        return fn();
      },
      runWithCapability: () => { throw new Error("unexpected"); },
    };

    const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const pi = { registerTool: (def: any) => calls.push(def) };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    registerShip(pi as any, new ApprovalRegistry(cwd), { vault: mockVault as any });

    const execute = calls[0].execute;
    const result = await execute("id", { action: "validate" } as ShipInput, undefined, undefined, { cwd });
    expect(runTrustedCalled).toBe(true);
    expect(result).toBeDefined();
  });

  it("apply_plan does not wrap in runTrusted", async () => {
    let runTrustedCalled = false;
    const mockVault = {
      runTrusted: (fn: () => unknown) => {
        runTrustedCalled = true;
        return fn();
      },
      runWithCapability: (_cap: unknown, fn: () => unknown) => fn(),
    };

    const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const pi = { registerTool: (def: any) => calls.push(def) };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    registerShip(pi as any, new ApprovalRegistry(cwd), { vault: mockVault as any });

    const execute = calls[0].execute;
    // apply_plan with a non-existent planId — fails early but should not go through runTrusted
    await expect(
      execute("id", { action: "apply_plan", planId: "nonexistent", planDigest: "dig" } as ShipInput, undefined, undefined, { cwd })
    ).rejects.toThrow();
    expect(runTrustedCalled).toBe(false);
  });

  it("runApprovedOperation logic mints capability and wraps fn", async () => {
    const { executeApprovedOperation } = await import("../../../src/tools/ship/index.js");

    const runWithCapabilityCalls: Array<{ cap: unknown }> = [];
    const mockVault = {
      runWithCapability: (cap: unknown, fn: () => unknown) => {
        runWithCapabilityCalls.push({ cap });
        return fn();
      },
    };

    const fn = () => "called";
    const result = executeApprovedOperation(mockVault as any, { provider: "cloudflare", planId: "p-1", planDigest: "d-1" }, fn);

    expect(result).toBe("called");
    expect(runWithCapabilityCalls).toHaveLength(1);
    const cap = runWithCapabilityCalls[0].cap as Record<string, unknown>;
    expect(cap.resource).toBe("cloudflare-deployment");
    expect(cap.operation).toBe("execute");
    expect(cap.planId).toBe("p-1");
    expect(cap.planDigest).toBe("d-1");
    expect(cap.riskLevel).toBe("destructive");
  });

  it("runApprovedOperation throws for unknown provider", async () => {
    const { executeApprovedOperation } = await import("../../../src/tools/ship/index.js");

    const mockVault = { runWithCapability: () => { throw new Error("unexpected"); } };

    expect(() =>
      executeApprovedOperation(mockVault as any, { provider: "unknown" } as any, () => "x")
    ).toThrow(/no boundary resource/);
  });

  it("legacy registerShip without binding uses broad shipSchema", async () => {
    const calls: { name: string; def: { parameters: unknown } }[] = [];
    const pi = { registerTool: (def: { name: string; parameters: unknown }) => calls.push({ name: def.name, def: def as { parameters: unknown } }) };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    registerShip(pi as never, new ApprovalRegistry(cwd));
    expect(calls[0]?.name).toBe("ship");
    expect(calls[0]?.def.parameters).toBe(shipSchema);
  });

  it("bound registerShip uses narrow schema from deps.parameters", async () => {
    const narrowSchema = Type.Object({ action: Type.Literal("validate") });
    const mockBinding = {
      cwd: "/test",
      manifest: { name: "x", provider: "railway", project: "x", run: { command: ["echo"] } },
      package: { id: "railway" },
      profile: { ship: [], databaseAdditions: [], commands: [] as string[], boundaryResource: "railway-deployment" },
      manifestBytesDigest: "abc",
      assertIntact: async () => {},
    };
    const calls: { name: string; parameters: unknown }[] = [];
    const pi = { registerTool: (def: any) => calls.push({ name: def.name, parameters: def.parameters }) };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    registerShip(pi as any, new ApprovalRegistry(cwd), {
      binding: mockBinding as any,
      parameters: narrowSchema as any,
    });
    expect(calls[0]?.parameters).toBe(narrowSchema);
    expect(calls[0]?.parameters).not.toBe(shipSchema);
  });

  it("bound registerShip calls assertIntact exactly once before dispatch", async () => {
    let assertIntactCallCount = 0;
    const mockBinding = {
      cwd: "/test",
      manifest: { name: "x", provider: "railway", project: "x", run: { command: ["echo"] } },
      package: { id: "railway" },
      profile: { ship: [], databaseAdditions: [], commands: [] as string[], boundaryResource: "railway-deployment" },
      manifestBytesDigest: "abc",
      assertIntact: async () => { assertIntactCallCount++; },
    };
    const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const pi = { registerTool: (def: any) => calls.push(def) };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    const mockVault = { runTrusted: (fn: any) => fn(), runWithCapability: () => { throw new Error("unexpected"); } };
    registerShip(pi as any, new ApprovalRegistry(cwd), {
      binding: mockBinding as any,
      vault: mockVault as any,
      credentialSource: { get: () => undefined },
    });
    const execute = calls[0].execute;
    const result = await execute("id", { action: "validate" } as ShipInput, undefined, undefined, { cwd });
    expect(assertIntactCallCount).toBe(1);
    expect(result).toBeDefined();
  });

  it("executeApprovedOperation with explicit resourceOverride uses override not provider map", async () => {
    const { executeApprovedOperation } = await import("../../../src/tools/ship/index.js");
    const runWithCapabilityResources: string[] = [];
    const mockVault = {
      runWithCapability: (cap: { resource: string }, fn: () => unknown) => {
        runWithCapabilityResources.push(cap.resource);
        return fn();
      },
    };
    executeApprovedOperation(
      mockVault as any,
      { provider: "cloudflare", planId: "p-1", planDigest: "d-1" },
      () => "result",
      "custom-resource",
    );
    expect(runWithCapabilityResources).toEqual(["custom-resource"]);
  });

  it("legacy executeApprovedOperation without resourceOverride falls back to provider map", async () => {
    const { executeApprovedOperation } = await import("../../../src/tools/ship/index.js");
    const runWithCapabilityResources: string[] = [];
    const mockVault = {
      runWithCapability: (cap: { resource: string }, fn: () => unknown) => {
        runWithCapabilityResources.push(cap.resource);
        return fn();
      },
    };
    executeApprovedOperation(
      mockVault as any,
      { provider: "cloudflare", planId: "p-1", planDigest: "d-1" },
      () => "result",
    );
    expect(runWithCapabilityResources).toEqual(["cloudflare-deployment"]);
  });

  it("executeApprovedOperation throws for unknown provider (missing resource fails closed)", async () => {
    const { executeApprovedOperation } = await import("../../../src/tools/ship/index.js");
    const mockVault = { runWithCapability: () => { throw new Error("unexpected"); } };
    expect(() =>
      executeApprovedOperation(
        mockVault as any,
        { provider: "unknown", planId: "p-1", planDigest: "d-1" } as any,
        () => "result",
      )
    ).toThrow(/no boundary resource/);
  });

  it("bound runApprovedOperation rejects plan provider mismatch with selected package", async () => {
    // Use a fresh directory with .gitignore so plan files don't taint worktree hash.
    const mismatchCwd = await mkdtemp(join(tmpdir(), "pi-ship-mismatch-"));
    try {
      await promisify(execFile)("git", ["init"], { cwd: mismatchCwd });
      await promisify(execFile)("git", ["config", "user.email", "t@t.local"], { cwd: mismatchCwd });
      await promisify(execFile)("git", ["config", "user.name", "T"], { cwd: mismatchCwd });
      await writeFile(join(mismatchCwd, ".gitignore"), ".pi-ship\n");
      await writeFile(join(mismatchCwd, "index.js"), "module.exports = {};");
      await promisify(execFile)("git", ["add", "."], { cwd: mismatchCwd });
      await promisify(execFile)("git", ["commit", "-m", "init"], { cwd: mismatchCwd });
      await writeFile(join(mismatchCwd, "pi-ship.json"), JSON.stringify({
        name: "mismatch-test",
        provider: "railway",
        project: "mismatch-test",
        run: { command: ["node", "server.js"] },
      }));

      // Step 2: Create a Railway plan on disk (no binding, broad ship).
      const planCalls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
      const planPi = { registerTool: (def: any) => planCalls.push(def) };
      const { registerShip } = await import("../../../src/tools/ship/index.js");
      const { ApprovalRegistry } = await import("../../../src/core/approval.js");
      const sharedRegistry = new ApprovalRegistry(mismatchCwd);
      registerShip(planPi as any, sharedRegistry);
      const planExecute = planCalls[0].execute;
      const planResult = await planExecute(
        "id",
        { action: "plan", environment: "production" } as ShipInput,
        undefined,
        undefined,
        { cwd: mismatchCwd, hasUI: true, ui: { confirm: async () => true } },
      ) as any;
      expect(planResult.details.planId).toBeDefined();
      expect(planResult.details.planDigest).toBeDefined();
      const { planId, planDigest } = planResult.details;

      // Step 3: Bound registration with vercel package id (mismatch) + vault.
      let assertIntactCallCount = 0;
      const railManifest = { name: "mismatch-test", provider: "railway", project: "mismatch-test", run: { command: ["node", "server.js"] } };
      const mismatchBinding = {
        cwd: mismatchCwd,
        manifest: railManifest,
        package: { id: "vercel" },
        profile: { ship: [] as never[], databaseAdditions: [] as never[], commands: [] as string[], boundaryResource: "vercel-deployment" },
        manifestBytesDigest: "abc",
        assertIntact: async () => { assertIntactCallCount++; },
      };
      const boundCalls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
      const boundPi = { registerTool: (def: any) => boundCalls.push(def) };
      const throwVault = {
        runTrusted: (fn: any) => fn(),
        runWithCapability: () => { throw new Error("should not reach capability"); },
      };
      registerShip(boundPi as any, sharedRegistry, {
        binding: mismatchBinding as any,
        vault: throwVault as any,
        credentialSource: { get: () => undefined },
      });
      const boundExecute = boundCalls[0].execute;

      await expect(
        boundExecute(
          "id",
          { action: "apply_plan", planId, planDigest } as ShipInput,
          undefined,
          undefined,
          { cwd: mismatchCwd, hasUI: true, ui: { confirm: async () => true } },
        ),
      ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      expect(assertIntactCallCount).toBe(1);
    } finally {
      await rm(mismatchCwd, { recursive: true, force: true });
    }
  });

  it("non-mutating actions work without vault (backward compat)", async () => {
    const calls: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const pi = { registerTool: (def: any) => calls.push(def) };
    const { registerShip } = await import("../../../src/tools/ship/index.js");
    const { ApprovalRegistry } = await import("../../../src/core/approval.js");
    registerShip(pi as any, new ApprovalRegistry(cwd));

    const execute = calls[0].execute;
    const result = await execute("id", { action: "validate" } as ShipInput, undefined, undefined, { cwd });
    expect(result).toBeDefined();
    expect((result as any).details.missingSecrets).toContain("APP_SECRET");
  });
});

// ── Routing tests ─────────────────────────────────────────────────────────────
// Verify that Railway and Vercel ships ops are both registered and dispatched correctly

describe("ship routing", () => {
  it("Railway and Vercel packages are both registered in provider registry", async () => {
    const { providerRegistry } = await import("../../../src/providers/registry.js");
    const ids = providerRegistry.ids();
    expect(ids).toContain("railway");
    expect(ids).toContain("vercel");
  });

  it("Railway ship ops handler is available via package", async () => {
    const { railwayProviderPackage } = await import("../../../src/providers/railway/package.js");
    expect(railwayProviderPackage.getShipOpsHandler).toBeDefined();
    const handler = railwayProviderPackage.getShipOpsHandler!({ name: "x", provider: "railway", project: "x", run: { command: ["echo"] } });
    expect(handler).toBeDefined();
  });

  it("Vercel ship ops handler is available via package", async () => {
    const { vercelProviderPackage } = await import("../../../src/providers/vercel/package.js");
    expect(vercelProviderPackage.getShipOpsHandler).toBeDefined();
    const handler = vercelProviderPackage.getShipOpsHandler!({ version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x" } } });
    expect(handler).toBeDefined();
  });

  it("Railway database ops handler is available via package", async () => {
    const { railwayProviderPackage } = await import("../../../src/providers/railway/package.js");
    expect(railwayProviderPackage.getDatabaseOpsHandler).toBeDefined();
    const handler = railwayProviderPackage.getDatabaseOpsHandler!({ name: "x", provider: "railway", project: "x", run: { command: ["echo"] } });
    expect(handler).toBeDefined();
  });

  it("Vercel database ops handler throws E_PHASE_UNSUPPORTED", async () => {
    const { vercelProviderPackage } = await import("../../../src/providers/vercel/package.js");
    expect(vercelProviderPackage.getDatabaseOpsHandler).toBeDefined();
    const handler = vercelProviderPackage.getDatabaseOpsHandler!({ version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x" } } });
    expect(handler).toBeDefined();
    await expect(handler!({} as any, { manifest: { version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x" } } } } as any)).rejects.toMatchObject({ code: "E_PHASE_UNSUPPORTED" });
  });
});

describe("generic tool import locality", () => {
  it("ship/index.ts does not import railway or vercel modules directly", () => {
    const content = require("fs").readFileSync(
      new URL("../../../src/tools/ship/index.ts", import.meta.url),
      "utf8"
    );
    // Key assertion: no `from "..."` import targeting provider-specific paths
    expect(content).not.toMatch(/from\s+['"][^'"]*\/providers\/[^'"]+\/[^'"]*['"]/);
  });

  it("db/index.ts does not import railway or vercel modules directly", () => {
    const content = require("fs").readFileSync(
      new URL("../../../src/tools/db/index.ts", import.meta.url),
      "utf8"
    );
    expect(content).not.toContain("railway");
    expect(content).not.toContain("vercel");
  });
});
