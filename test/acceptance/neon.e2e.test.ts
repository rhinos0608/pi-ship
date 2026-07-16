import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { buildNeonPlan } from "../../src/providers/neon/plan.js";
import { applyNeonPlan } from "../../src/providers/neon/engine.js";
import type { NeonAdapter } from "../../src/providers/neon/adapter.js";
import { defaultNeonState, type NeonState } from "../../src/providers/neon/state.js";

const manifest = { provider: "neon" as const, version: 1 as const, project: "acceptance-neon" };

function fakeAdapter(calls: string[]): NeonAdapter {
  return {
    async checkAuth() { return { ok: true }; },
    async ensureProject(name) { calls.push("ensureProject"); return { projectId: "project-1", projectName: name, created: true }; },
    async ensureBranch() { calls.push("ensureBranch"); return { branchId: "branch-1", branchName: "acceptance-neon", connectionUri: "postgresql://user:[REDACTED]@fake/db", created: true }; },
    async getConnectionUri() { calls.push("getConnectionUri"); return "postgresql://user:[REDACTED]@fake/db"; },
    async createPreviewBranch() { calls.push("createPreviewBranch"); return { branchId: "preview-1", connectionUri: "postgresql://user:[REDACTED]@fake/db" }; },
    async restoreBranch() { calls.push("restoreBranch"); },
  } as NeonAdapter;
}

describe("Neon cloud-free acceptance", () => {
  it("applies through fake adapter and rejects changed manifest before mutation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-acceptance-"));
    const calls: string[] = [];
    let state: NeonState = defaultNeonState();
    const stateStore = { load: async () => state, save: async (next: NeonState) => { state = next; } };
    const registry = new ApprovalRegistry(cwd);
    const plan = buildNeonPlan(manifest, "production", "provision", { planId: "acceptance-plan", createdAt: new Date().toISOString() });
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    await applyNeonPlan({ adapter: fakeAdapter(calls), manifest, plan, cwd, stateStore, registry, suppliedDigest: plan.planDigest, envReader: () => ({}), piExec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }) });
    expect(calls).toContain("ensureProject");

    const before = calls.length;
    const changed = { ...manifest, project: "different-project" };
    const mismatch = buildNeonPlan(changed, "production", "migration", { planId: "changed-plan", createdAt: new Date().toISOString(), migrationCommand: ["echo", "migration"] });
    registry.approve(mismatch.planId, mismatch.planDigest, cwd, { domain: "database", risk: "destructive" });
    await expect(applyNeonPlan({ adapter: fakeAdapter(calls), manifest, plan: mismatch, cwd, stateStore, registry, suppliedDigest: mismatch.planDigest, envReader: () => ({}), piExec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false }) })).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(calls).toHaveLength(before);
  });
});
