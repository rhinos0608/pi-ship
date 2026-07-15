import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { applyNeonPlan, type ApplyNeonContext } from "../../../src/providers/neon/engine.js";
import { buildNeonPlan } from "../../../src/providers/neon/plan.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { defaultNeonState, saveNeonState, type NeonState } from "../../../src/providers/neon/state.js";
import type { NeonManifest } from "../../../src/providers/neon/manifest.js";
import type { NeonAdapter, EnsureProjectResult, EnsureBranchResult, CreatePreviewBranchResult } from "../../../src/providers/neon/adapter.js";

// ── Fake adapter ──────────────────────────────────────────────────────────

function createFakeAdapter(): NeonAdapter & {
  calls: Array<{ method: string; args: unknown[] }>;
  injectFailure(method: string, error: Error): void;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const failures = new Map<string, Error>();
  let projectCounter = 0;
  let branchCounter = 0;
  const projects = new Map<string, string>(); // name -> id
  const branches = new Map<string, string>(); // projectId/name -> id

  function maybeFail(method: string) {
    const err = failures.get(method);
    if (err) throw err;
  }

  return {
    calls,
    injectFailure(method, error) {
      failures.set(method, error);
    },
    async checkAuth() {
      calls.push({ method: "checkAuth", args: [] });
      maybeFail("checkAuth");
      return { ok: true };
    },
    async ensureProject(name, config) {
      calls.push({ method: "ensureProject", args: [name, config] });
      maybeFail("ensureProject");
      const existing = projects.get(name);
      if (existing) return { projectId: existing, projectName: name, created: false };
      projectCounter++;
      const id = `proj-${projectCounter}`;
      projects.set(name, id);
      return { projectId: id, projectName: name, created: true };
    },
    async ensureBranch(projectId, name, parentId, config) {
      calls.push({ method: "ensureBranch", args: [projectId, name, parentId, config] });
      maybeFail("ensureBranch");
      const key = `${projectId}/${name}`;
      const existing = branches.get(key);
      if (existing) {
        return { branchId: existing, branchName: name, created: false, connectionUri: `postgresql://user:pass@${existing}.neon.tech/db` };
      }
      branchCounter++;
      const id = `br-${branchCounter}`;
      branches.set(key, id);
      return { branchId: id, branchName: name, created: true, connectionUri: `postgresql://user:pass@${id}.neon.tech/db` };
    },
    async getConnectionUri(_projectId, _branchId, databaseName, _roleName) {
      calls.push({ method: "getConnectionUri", args: [_projectId, _branchId, databaseName, _roleName] });
      maybeFail("getConnectionUri");
      return `postgresql://user:pass@host.neon.tech/${databaseName}`;
    },
    async createPreviewBranch(projectId, parentId, name, expiresAt) {
      calls.push({ method: "createPreviewBranch", args: [projectId, parentId, name, expiresAt] });
      maybeFail("createPreviewBranch");
      branchCounter++;
      const id = `br-${branchCounter}`;
      return { branchId: id, connectionUri: `postgresql://user:pass@${id}.neon.tech/db` };
    },
  };
}

// ── Fixture helpers ───────────────────────────────────────────────────────

const manifest: NeonManifest = {
  provider: "neon",
  version: 1,
  project: "test-project",
};

async function makeFixture(overrides: Partial<ApplyNeonContext> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-engine-"));
  cleanupDirs.push(cwd);
  const plan = buildNeonPlan(manifest, "production", "provision", {
    planId: "engine-plan-1",
    createdAt: new Date().toISOString(),
  });
  const registry = new ApprovalRegistry(cwd);
  registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
  const adapter = createFakeAdapter();

  const baseCtx: ApplyNeonContext = {
    adapter,
    manifest,
    plan,
    cwd,
    envReader: () => ({}),
    piExec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }),
    registry,
    suppliedDigest: plan.planDigest,
    ...overrides,
  };

  return { cwd, plan, registry, adapter, ctx: baseCtx };
}

let cleanupDirs: string[] = [];

beforeEach(() => {
  cleanupDirs = [];
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("applyNeonPlan", () => {
  describe("provision intent", () => {
    it("executes ensureProject, ensureBranch, getConnectionUri steps", async () => {
      const { ctx, adapter } = await makeFixture();
      const result = await applyNeonPlan(ctx);
      expect(result.content[0]?.text).toContain("Applied provision plan");
      expect(adapter.calls.some((c) => c.method === "ensureProject")).toBe(true);
      expect(adapter.calls.some((c) => c.method === "ensureBranch")).toBe(true);
      expect(adapter.calls.some((c) => c.method === "getConnectionUri")).toBe(true);
    });

    it("updates state after each step", async () => {
      const { ctx, cwd } = await makeFixture();
      await applyNeonPlan(ctx);
      // Reload state
      const { loadNeonState } = await import("../../../src/providers/neon/state.js");
      const state = await loadNeonState(cwd);
      expect(state.projectId).toBeDefined();
      expect(state.projectName).toBe("test-project");
      expect(Object.keys(state.branchIds).length).toBeGreaterThan(0);
      expect(Object.keys(state.connectionUris).length).toBeGreaterThan(0);
      expect(state.history).toHaveLength(1);
      expect(state.history[0].planId).toBe(ctx.plan.planId);
      expect(state.history[0].status).toBe("ok");
    });

    it("is idempotent on re-run (plan already applied)", async () => {
      const { ctx, cwd, adapter } = await makeFixture();
      await applyNeonPlan(ctx);
      const callCount = adapter.calls.length;

      const result = await applyNeonPlan(ctx);
      expect(result.content[0]?.text).toContain("already applied");
      // No new adapter calls
      expect(adapter.calls.length).toBe(callCount);
    });
  });

  describe("migration intent", () => {
    it("executes ensureBranch, migrate, getConnectionUri steps", async () => {
      const { registry, cwd } = await makeFixture();
      // First provision the project manually
      const adapter = createFakeAdapter();
      const provPlan = buildNeonPlan(manifest, "production", "provision", {
        planId: "prov-plan",
        createdAt: new Date().toISOString(),
      });
      registry.approve(provPlan.planId, provPlan.planDigest, cwd, { domain: "database", risk: "destructive" });
      await applyNeonPlan({
        adapter,
        manifest,
        plan: provPlan,
        cwd,
        envReader: () => ({}),
        piExec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }),
        registry,
        suppliedDigest: provPlan.planDigest,
      });

      // Now migration plan
      const migratePlan = buildNeonPlan(manifest, "production", "migration", {
        planId: "migrate-plan",
        createdAt: new Date().toISOString(),
        migrationCommand: ["npx", "prisma", "migrate", "deploy"],
      });
      registry.approve(migratePlan.planId, migratePlan.planDigest, cwd, { domain: "database", risk: "destructive" });

      const migAdapter = createFakeAdapter();
      const execFn = vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }));
      const result = await applyNeonPlan({
        adapter: migAdapter,
        manifest,
        plan: migratePlan,
        cwd,
        envReader: () => ({}),
        piExec: execFn,
        registry,
        suppliedDigest: migratePlan.planDigest,
      });
      expect(result.content[0]?.text).toContain("Applied migration plan");
      expect(migAdapter.calls.some((c) => c.method === "ensureBranch")).toBe(true);
      expect(migAdapter.calls.some((c) => c.method === "getConnectionUri")).toBe(true);
      expect(execFn).toHaveBeenCalled();
    });

    it("throws if migration plan missing migrationCommand", async () => {
      const { ctx } = await makeFixture();
      const badPlan = buildNeonPlan(manifest, "production", "migration", {
        planId: "bad-mig",
        createdAt: new Date().toISOString(),
        // no migrationCommand
      });
      ctx.plan = badPlan;
      ctx.suppliedDigest = badPlan.planDigest;
      ctx.registry.approve(badPlan.planId, badPlan.planDigest, ctx.cwd, { domain: "database", risk: "destructive" });
      await expect(applyNeonPlan(ctx)).rejects.toMatchObject({ code: "E_PRECONDITION" });
    });
  });

  describe("preview intent", () => {
    it("creates preview branch from existing state", async () => {
      const { registry, cwd } = await makeFixture();
      // First provision
      const adapter = createFakeAdapter();
      const provPlan = buildNeonPlan(manifest, "production", "provision", {
        planId: "prov-plan-2",
        createdAt: new Date().toISOString(),
      });
      registry.approve(provPlan.planId, provPlan.planDigest, cwd, { domain: "database", risk: "destructive" });
      await applyNeonPlan({
        adapter,
        manifest,
        plan: provPlan,
        cwd,
        envReader: () => ({}),
        piExec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }),
        registry,
        suppliedDigest: provPlan.planDigest,
      });

      // Preview plan
      const previewPlan = buildNeonPlan(manifest, "preview", "preview", {
        planId: "preview-plan",
        createdAt: new Date().toISOString(),
        previewExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        sourceBranchId: undefined, // rely on state branchIds
      });
      registry.approve(previewPlan.planId, previewPlan.planDigest, cwd, { domain: "database", risk: "destructive" });

      const prevAdapter = createFakeAdapter();
      const result = await applyNeonPlan({
        adapter: prevAdapter,
        manifest,
        plan: previewPlan,
        cwd,
        envReader: () => ({}),
        piExec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }),
        registry,
        suppliedDigest: previewPlan.planDigest,
      });
      expect(result.content[0]?.text).toContain("Applied preview plan");
      expect(prevAdapter.calls.some((c) => c.method === "createPreviewBranch")).toBe(true);
    });

    it("throws if no parent branch available", async () => {
      const { ctx } = await makeFixture();
      const previewPlan = buildNeonPlan(manifest, "preview", "preview", {
        planId: "preview-fail",
        createdAt: new Date().toISOString(),
      });
      ctx.plan = previewPlan;
      ctx.suppliedDigest = previewPlan.planDigest;
      ctx.registry.approve(previewPlan.planId, previewPlan.planDigest, ctx.cwd, { domain: "database", risk: "destructive" });
      await expect(applyNeonPlan(ctx)).rejects.toMatchObject({ code: "E_PRECONDITION" });
    });
  });

  describe("error handling", () => {
    it("rejects digest mismatch", async () => {
      const { ctx } = await makeFixture();
      await expect(applyNeonPlan({ ...ctx, suppliedDigest: "bad-digest" })).rejects.toMatchObject({
        code: "E_DIGEST_MISMATCH",
      });
    });

    it("rejects unapproved plan", async () => {
      const { ctx, registry } = await makeFixture();
      registry.clear();
      await expect(applyNeonPlan(ctx)).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    });

    it("rejects stale plan", async () => {
      const { ctx, cwd } = await makeFixture();
      const stalePlan = buildNeonPlan(manifest, "production", "provision", {
        planId: "stale",
        createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      });
      ctx.plan = stalePlan;
      ctx.suppliedDigest = stalePlan.planDigest;
      ctx.registry.approve(stalePlan.planId, stalePlan.planDigest, cwd, { domain: "database", risk: "destructive" });
      await expect(applyNeonPlan(ctx)).rejects.toMatchObject({ code: "E_PLAN_STALE" });
    });

    it("maps auth failure to E_AUTH_MISSING", async () => {
      const { ctx, adapter } = await makeFixture();
      adapter.injectFailure("checkAuth", Object.assign(new Error("no token"), { code: "E_AUTH_MISSING" }));
      await expect(applyNeonPlan(ctx)).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    });

    it("journals failure on step error and rethrows", async () => {
      const { ctx, adapter } = await makeFixture();
      adapter.injectFailure("ensureProject", Object.assign(new Error("creation failed"), { code: "E_PROVIDER" }));
      await expect(applyNeonPlan(ctx)).rejects.toThrow();
      // Journal should have a fail entry
      const { readJournal } = await import("../../../src/providers/neon/journal.js");
      const entries = await readJournal(ctx.cwd, ctx.plan.planId);
      const failEntries = entries.filter((e) => e.status === "fail");
      expect(failEntries.length).toBeGreaterThan(0);
    });
  });

  describe("journal-based idempotency", () => {
    it("skips already completed steps", async () => {
      const { ctx, adapter, cwd } = await makeFixture();
      const { appendJournal } = await import("../../../src/providers/neon/journal.js");
      const { saveNeonState, defaultNeonState } = await import("../../../src/providers/neon/state.js");

      // Pre-populate state as if a previous run completed the provision steps
      await saveNeonState(cwd, {
        ...defaultNeonState(),
        projectId: "proj-1",
        projectName: "test-project",
        branchIds: { "test-project": "br-1" },
        connectionUris: { "test-project": "postgresql://user:[REDACTED]@host:5432/db" },
      });

      // Pre-populate journal with completed steps
      await appendJournal(cwd, { ts: "t1", planId: ctx.plan.planId, step: "ensureProject", status: "ok" });
      await appendJournal(cwd, { ts: "t2", planId: ctx.plan.planId, step: "ensureBranch", status: "ok" });
      await appendJournal(cwd, { ts: "t3", planId: ctx.plan.planId, step: "getConnectionUri", status: "ok" });

      // Run — should skip all steps but still succeed
      const result = await applyNeonPlan(ctx);
      expect(result.content[0]?.text).toContain("Applied provision plan");
      // No new adapter calls for completed steps
      const ensureProjectCalls = adapter.calls.filter((c) => c.method === "ensureProject");
      const ensureBranchCalls = adapter.calls.filter((c) => c.method === "ensureBranch");
      const getConnUriCalls = adapter.calls.filter((c) => c.method === "getConnectionUri");
      expect(ensureProjectCalls).toHaveLength(0);
      expect(ensureBranchCalls).toHaveLength(0);
      expect(getConnUriCalls).toHaveLength(0);

      // Verify state preserved existing fields after apply
      const { loadNeonState } = await import("../../../src/providers/neon/state.js");
      const state = await loadNeonState(cwd);
      expect(state.projectId).toBe("proj-1");
      expect(Object.keys(state.branchIds).length).toBeGreaterThan(0);
      expect(Object.keys(state.connectionUris).length).toBeGreaterThan(0);
    });

    it("blocks on dangling non-idempotent step", async () => {
      const { ctx, cwd } = await makeFixture();
      const { appendJournal } = await import("../../../src/providers/neon/journal.js");

      // Migration with dangling start
      const migPlan = buildNeonPlan(manifest, "production", "migration", {
        planId: "dangling-mig",
        createdAt: new Date().toISOString(),
        migrationCommand: ["npx", "prisma", "migrate", "deploy"],
      });
      ctx.plan = migPlan;
      ctx.suppliedDigest = migPlan.planDigest;
      ctx.registry.approve(migPlan.planId, migPlan.planDigest, cwd, { domain: "database", risk: "destructive" });

      // Pre-populate journal with dangling migrate step
      await appendJournal(cwd, { ts: "t1", planId: migPlan.planId, step: "migrate", status: "start" });

      await expect(applyNeonPlan(ctx)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    });
  });

  describe("abort signal", () => {
    it("throws on aborted signal", async () => {
      const { ctx } = await makeFixture();
      const ac = new AbortController();
      ac.abort();
      ctx.signal = ac.signal;
      await expect(applyNeonPlan(ctx)).rejects.toThrow();
    });
  });
});
