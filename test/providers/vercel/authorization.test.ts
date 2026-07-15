import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVercelPlan } from "../../../src/providers/vercel/plan.js";
import { authorizeVercelPlanApply } from "../../../src/providers/vercel/authorization.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { defaultVercelState } from "../../../src/providers/vercel/state.js";

describe("V2 authorization", () => {
  it("permits initial deploy without observed project and requires source identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-auth-v2-"));
    const manifest = { version: 2 as const, name: "site", app: { provider: "vercel" as const, config: { projectName: "site" } } };
    const plan = await buildVercelPlan(cwd, manifest, "production", "deploy", { accountRef: { kind: "user", id: "u" }, source: { kind: "local-files", rootDirectory: ".", fileCount: 0, totalBytes: 0, fingerprint: "src" }, gitCommit: "g", worktreeHash: "w", createdAt: new Date().toISOString() });
    const registry = new ApprovalRegistry(cwd); registry.approve(plan.planId, plan.planDigest, cwd);
    await expect(authorizeVercelPlanApply({ cwd, plan, suppliedDigest: plan.planDigest, manifest, registry, state: defaultVercelState() })).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    await expect(authorizeVercelPlanApply({ cwd, plan, suppliedDigest: plan.planDigest, manifest, registry, state: defaultVercelState(), currentSource: { gitCommit: "g", worktreeHash: "w", sourceFingerprint: "src" } })).resolves.toBeUndefined();
  });
});
