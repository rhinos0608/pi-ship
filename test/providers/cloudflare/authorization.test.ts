import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildCloudflareOperations,
  computeCloudflarePlanDigest,
  type CloudflarePlan,
} from "../../../src/providers/cloudflare/plan.js";
import { authorizeCloudflarePlanApply } from "../../../src/providers/cloudflare/authorization.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { defaultCloudflareState } from "../../../src/providers/cloudflare/state.js";

let cwd: string;
let registry: ApprovalRegistry;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-auth-"));
  registry = new ApprovalRegistry(cwd);
});

function makePlan(overrides: Partial<CloudflarePlan> = {}): CloudflarePlan {
  const ops = buildCloudflareOperations("deploy", "production", {
    workerName: "my-worker",
    accountId: "acc-123",
    secretNames: ["API_KEY"],
  });

  const now = new Date().toISOString();
  const plan: CloudflarePlan = {
    version: 1,
    planId: "plan-1",
    planDigest: "",
    provider: "cloudflare",
    environment: "production",
    intent: "deploy",
    identity: {
      account: { kind: "user", id: "acc-123" },
      worker: { name: "my-worker" },
    },
    accountFingerprint: computeCloudflarePlanDigest({ account: { kind: "user", id: "acc-123" } }),
    targetFingerprint: computeCloudflarePlanDigest({ worker: "my-worker", accountId: "acc-123" }),
    secretNames: ["API_KEY"],
    operations: ops,
    createdAt: now,
    ...overrides,
  };
  plan.planDigest = computeCloudflarePlanDigest(plan);
  return plan;
}

const validManifest = {
  provider: "cloudflare",
  version: 1,
  accountId: "acc-123",
  name: "my-worker",
  mainModule: "src/index.ts",
  compatibilityDate: "2024-01-01",
};

describe("authorizeCloudflarePlanApply", () => {
  it("passes for valid plan with matching digest and approved registry", async () => {
    const plan = makePlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
      })
    ).resolves.toBeUndefined();
  });

  it("rejects when supplied digest does not match plan digest", async () => {
    const plan = makePlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: "wrong-digest",
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
  });

  it("rejects when planDigest does not match computed digest", async () => {
    const plan = makePlan({ planDigest: "tampered-digest" });
    registry.approve(plan.planId, "tampered-digest", cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: "tampered-digest",
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
  });

  it("rejects when plan is not approved", async () => {
    const plan = makePlan();

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });

  it("rejects stale plan (older than 30 minutes)", async () => {
    const oldDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const plan = makePlan({ createdAt: oldDate });
    // Recompute digest with old date embedded
    (plan as Record<string, unknown>).planDigest = "";
    plan.planDigest = computeCloudflarePlanDigest(plan);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  it("rejects plan with future timestamp", async () => {
    const futureDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const plan = makePlan({ createdAt: futureDate });
    (plan as Record<string, unknown>).planDigest = "";
    plan.planDigest = computeCloudflarePlanDigest(plan);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
        now: Date.now(),
      })
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  it("rejects manifest with mismatched accountId", async () => {
    const plan = makePlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: { ...validManifest, accountId: "wrong-account" },
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects manifest with mismatched worker name", async () => {
    const plan = makePlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: { ...validManifest, name: "different-worker" },
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects when state accountId conflicts with plan", async () => {
    const plan = makePlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: validManifest,
        registry,
        state: { ...defaultCloudflareState(), accountId: "different-account" },
      })
    ).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects when state worker name conflicts with plan", async () => {
    const plan = makePlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan,
        suppliedDigest: plan.planDigest,
        manifest: validManifest,
        registry,
        state: {
          ...defaultCloudflareState(),
          worker: { name: "different-worker" },
        },
      })
    ).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects invalid plan object", async () => {
    const invalidPlan = { version: 1, provider: "cloudflare" } as CloudflarePlan;

    await expect(
      authorizeCloudflarePlanApply({
        cwd,
        plan: invalidPlan,
        suppliedDigest: "x",
        manifest: validManifest,
        registry,
        state: defaultCloudflareState(),
      })
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  describe("operation sequence validation", () => {
    it("rejects deploy plan with wrong operation count", async () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });
      // Remove last operation to make sequence invalid
      const badPlan = makePlan({ operations: ops.slice(0, 2) });
      registry.approve(badPlan.planId, badPlan.planDigest, cwd, { domain: "deployment", risk: "destructive" });

      await expect(
        authorizeCloudflarePlanApply({
          cwd,
          plan: badPlan,
          suppliedDigest: badPlan.planDigest,
          manifest: validManifest,
          registry,
          state: defaultCloudflareState(),
        })
      ).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    });
  });
});
