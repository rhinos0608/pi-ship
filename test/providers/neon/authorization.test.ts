import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNeonPlan, computePlanDigest } from "../../../src/providers/neon/plan.js";
import { authorizeNeonPlanApply } from "../../../src/providers/neon/authorization.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";

const baseManifest = {
  provider: "neon" as const,
  version: 1 as const,
  project: "my-project",
};

function makeApprovedPlan(overrides: Record<string, unknown> = {}) {
  const opts = {
    planId: "test-plan-id",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  const plan = buildNeonPlan(baseManifest, "production", "provision", opts);
  return plan;
}

describe("authorizeNeonPlanApply", () => {
  it("valid plan passes authorization", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    const plan = makeApprovedPlan();
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });

    await expect(
      authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: plan.planDigest }),
    ).resolves.toBeUndefined();
  });

  it("rejects plan with wrong digest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    const plan = makeApprovedPlan();
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });

    await expect(
      authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: "wrong-digest" }),
    ).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
  });

  it("rejects unapproved plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    const plan = makeApprovedPlan();

    await expect(
      authorizeNeonPlanApply({ registry: new ApprovalRegistry(cwd), cwd, plan, suppliedDigest: plan.planDigest }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });

  it("rejects stale plan older than 30 minutes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    const plan = makeApprovedPlan({ createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });

    await expect(
      authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: plan.planDigest }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  it("rejects future-dated plan (> 1 minute ahead)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    const plan = makeApprovedPlan({ createdAt: new Date(Date.now() + 120_000).toISOString() });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });

    await expect(
      authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: plan.planDigest }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  it("tolerates plan within valid time window", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    // 5 minutes old — should be within 30 min window
    const plan = makeApprovedPlan({ createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });

    await expect(
      authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: plan.planDigest }),
    ).resolves.toBeUndefined();
  });

  it("aborted signal before validation throws", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-auth-"));
    const plan = makeApprovedPlan();
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    const ac = new AbortController();
    ac.abort();

    await expect(
      authorizeNeonPlanApply({ registry, cwd, plan, suppliedDigest: plan.planDigest, signal: ac.signal }),
    ).rejects.toThrow();
  });
});
