import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(content).not.toContain("railway");
    expect(content).not.toContain("vercel");
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
