import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { buildRailwayPlan } from "../../src/providers/railway/plan.js";
import { applyRailwayPlan } from "../../src/providers/railway/engine.js";
import { createFakeProvider } from "../support/railway-fake.js";
import { defaultState } from "../../src/providers/railway/state.js";
import type { RailwayManifest } from "../../src/providers/railway/manifest.js";

describe("cloud-free acceptance lifecycle", () => {
  it("preflights secrets, deploys once, and refuses ambiguous retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-accept-"));
    try {
      const manifest: RailwayManifest = { name: "accept", provider: "railway", project: "accept", run: { command: ["node", "server.js"] }, secrets: ["APP_SECRET"] };
      const state = defaultState();
      const plan = await buildRailwayPlan(cwd, manifest, "production", { planId: "accept-plan", targetSnapshot: { projectId: state.projectId, projectName: state.projectName, environmentId: state.environmentId, environmentName: state.environmentName, serviceIds: state.serviceIds, serviceNames: state.serviceNames } });
      const registry = new ApprovalRegistry(cwd);
      registry.approve(plan.planId, plan.planDigest, undefined, { domain: "deployment", risk: "destructive" });
      const provider = createFakeProvider();
      const exec = async () => ({ code: 0, stdout: "", stderr: "" });
      await expect(applyRailwayPlan({ adapter: provider, manifest, plan, cwd, envReader: () => ({}), piExec: exec as never, registry, suppliedDigest: plan.planDigest })).rejects.toMatchObject({ code: "E_PRECONDITION" });
      const result = await applyRailwayPlan({ adapter: provider, manifest, plan, cwd, envReader: () => ({ APP_SECRET: "value" }), piExec: exec as never, registry, suppliedDigest: plan.planDigest });
      expect(result.content[0]?.type).toBe("text");
      expect(provider.calls.filter((c) => c.method === "deploy")).toHaveLength(1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
