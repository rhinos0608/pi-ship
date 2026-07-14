import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalRegistry,
  requestApproval,
} from "../../src/core/approval.js";
import {
  approvalSidecarPath,
  writeApprovalSidecar,
} from "../../src/core/approval-store.js";
import { buildPlan } from "../../src/core/plan.js";
import { persistPlan } from "../../src/core/plan-store.js";

let tmp: string;
let registry: ApprovalRegistry;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-approval-"));
  registry = new ApprovalRegistry(tmp);
});

async function makePlan() {
  return buildPlan(tmp, {
    name: "app",
    provider: "railway",
    project: "my-project",
    run: { command: ["node", "server.js"] },
  }, "production");
}

describe("approval registry", () => {
  it("confirms after approve", () => {
    registry.approve("p1", "d1");
    expect(registry.isApproved("p1", "d1")).toBe(true);
  });

  it("revoke removes approval", () => {
    registry.approve("p1", "d1");
    expect(registry.revoke("p1", "d1")).toBe(true);
    expect(registry.isApproved("p1", "d1")).toBe(false);
  });

  it("approval keys combine planId and digest", () => {
    registry.approve("p1", "d1");
    expect(registry.isApproved("p1", "d2")).toBe(false);
  });
});

describe("requestApproval", () => {
  it("returns approvedAt when user confirms", async () => {
    const plan = await makePlan();
    const ctx = {
      hasUI: true,
      ui: { confirm: async () => true },
    } as unknown as Parameters<typeof requestApproval>[0];
    const result = await requestApproval(ctx, plan, registry);
    expect(result.approved).toBe(true);
    expect(result.approvedAt).toBeDefined();
    expect(registry.isApproved(plan.planId, plan.planDigest)).toBe(true);
  });

  it("returns false when user denies", async () => {
    const plan = await makePlan();
    const ctx = {
      hasUI: true,
      ui: { confirm: async () => false },
    } as unknown as Parameters<typeof requestApproval>[0];
    const result = await requestApproval(ctx, plan, registry);
    expect(result.approved).toBe(false);
  });

  it("returns false in headless context", async () => {
    const plan = await makePlan();
    const ctx = {
      hasUI: false,
      ui: { confirm: async () => true },
    } as unknown as Parameters<typeof requestApproval>[0];
    const result = await requestApproval(ctx, plan, registry);
    expect(result.approved).toBe(false);
  });
});

describe("approval sidecar", () => {
  it("plan file is byte-identical before/after writing sidecar", async () => {
    const plan = await makePlan();
    await persistPlan(tmp, plan);
    const before = await readFile(join(tmp, ".pi-ship", "plans", `${plan.planId}.json`), "utf8");
    await writeApprovalSidecar(tmp, plan.planId, plan.planDigest, new Date().toISOString(), "production");
    const after = await readFile(join(tmp, ".pi-ship", "plans", `${plan.planId}.json`), "utf8");
    expect(after).toBe(before);
  });

  it("sidecar path matches plan id", () => {
    expect(approvalSidecarPath(tmp, "abc")).toBe(join(tmp, ".pi-ship", "plans", "abc.approval.json"));
  });
});
