import { describe, expect, it } from "vitest";
import { buildNeonPlan, computeDigest, computePlanDigest } from "../../../src/providers/neon/plan.js";
import type { NeonManifest } from "../../../src/providers/neon/manifest.js";

const baseManifest: NeonManifest = {
  provider: "neon",
  version: 1,
  project: "my-project",
};

function fixedOpts(overrides: Record<string, unknown> = {}) {
  return {
    planId: "plan-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildNeonPlan", () => {
  it("produces correct plan for provision intent", () => {
    const plan = buildNeonPlan(baseManifest, "production", "provision", fixedOpts());
    expect(plan.provider).toBe("neon");
    expect(plan.intent).toBe("provision");
    expect(plan.environment).toBe("production");
    expect(plan.manifest).toEqual(baseManifest);
    expect(plan.planId).toBe("plan-1");
    expect(plan.planDigest).toBeDefined();
    expect(plan.planDigest.length).toBeGreaterThan(0);
    expect(plan.migrationCommand).toBeUndefined();
    expect(plan.previewExpiresAt).toBeUndefined();
    expect(plan.sourceBranchId).toBeUndefined();
    expect(plan.secretNames).toEqual(["NEON_API_KEY"]);
  });

  it("produces correct plan for migration intent with migrationCommand", () => {
    const plan = buildNeonPlan(baseManifest, "development", "migration", fixedOpts({
      migrationCommand: ["npx", "prisma", "migrate", "deploy"],
    }));
    expect(plan.intent).toBe("migration");
    expect(plan.environment).toBe("development");
    expect(plan.migrationCommand).toEqual(["npx", "prisma", "migrate", "deploy"]);
    expect(plan.previewExpiresAt).toBeUndefined();
  });

  it("produces correct plan for preview intent with previewExpiresAt", () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const plan = buildNeonPlan(baseManifest, "preview", "preview", fixedOpts({
      previewExpiresAt: expiresAt,
      sourceBranchId: "branch-main-id",
    }));
    expect(plan.intent).toBe("preview");
    expect(plan.environment).toBe("preview");
    expect(plan.previewExpiresAt).toBe(expiresAt);
    expect(plan.sourceBranchId).toBe("branch-main-id");
    expect(plan.migrationCommand).toBeUndefined();
  });

  it("plan digest is deterministic", () => {
    const opts = { planId: "det-1", createdAt: "2026-01-01T00:00:00.000Z" };
    const p1 = buildNeonPlan(baseManifest, "production", "provision", opts);
    const p2 = buildNeonPlan(baseManifest, "production", "provision", opts);
    expect(p1.planDigest).toBe(p2.planDigest);
  });

  it("plan digest changes when manifest changes", () => {
    const opts = { planId: "dig-1", createdAt: "2026-01-01T00:00:00.000Z" };
    const p1 = buildNeonPlan(baseManifest, "production", "provision", opts);
    const alteredManifest: NeonManifest = { ...baseManifest, project: "other-project" };
    const p2 = buildNeonPlan(alteredManifest, "production", "provision", opts);
    expect(p1.planDigest).not.toBe(p2.planDigest);
  });

  it("plan digest changes when environment changes", () => {
    const opts = { planId: "env-1", createdAt: "2026-01-01T00:00:00.000Z" };
    const p1 = buildNeonPlan(baseManifest, "production", "provision", opts);
    const p2 = buildNeonPlan(baseManifest, "development", "provision", opts);
    expect(p1.planDigest).not.toBe(p2.planDigest);
  });

  it("computeDigest matches computePlanDigest for same input", () => {
    const plan = buildNeonPlan(baseManifest, "production", "provision", { planId: "cmp-1", createdAt: "2026-01-01T00:00:00.000Z" });
    const recomputed = computeDigest(plan);
    expect(recomputed).toBe(plan.planDigest);
    expect(computePlanDigest(plan)).toBe(plan.planDigest);
  });

  it("generates random planId when not provided", () => {
    const p1 = buildNeonPlan(baseManifest, "production", "provision");
    const p2 = buildNeonPlan(baseManifest, "production", "provision");
    expect(p1.planId).not.toBe(p2.planId);
  });

  it("generates createdAt when not provided", () => {
    const plan = buildNeonPlan(baseManifest, "production", "provision");
    expect(plan.createdAt).toBeDefined();
    expect(() => new Date(plan.createdAt)).not.toThrow();
  });
});
