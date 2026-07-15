import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planPath, readPlanFile } from "../../src/persistence/plan-store.js";
import { readManifestRaw } from "../../src/persistence/manifest-store.js";
import { buildVercelPlan, persistVercelPlan, loadVercelPlan } from "../../src/providers/vercel/plan.js";
import { computeDigest, persistRailwayPlan, loadRailwayPlan, type RailwayPlan } from "../../src/providers/railway/plan.js";

describe("plan store validation", () => {
  it("rejects plan IDs that escape the plans directory", () => {
    expect(() => planPath("/workspace", "../../outside")).toThrow(expect.objectContaining({
      code: "E_CONFIG_INVALID",
      message: "plan ID contains invalid path characters",
    }));
    expect(() => planPath("/workspace", "nested/plan")).toThrow(expect.objectContaining({
      code: "E_CONFIG_INVALID",
      message: "plan ID contains invalid path characters",
    }));
  });

  const base: Omit<RailwayPlan, "planDigest"> = {
    planId: "p",
    manifest: { name: "x", provider: "railway", project: "x", run: { command: ["node", "x"] } },
    gitCommit: "g",
    gitDirty: false,
    worktreeHash: "w",
    provider: "railway",
    environment: "preview",
    resourceActions: [],
    secretNames: [],
    estimatedImpact: "none",
    createdAt: "2026-01-01",
    intent: "deploy",
  };

  it("does not expose filesystem paths or parser errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-sensitive-path-"));

    await expect(readPlanFile(cwd, "missing-plan")).rejects.toMatchObject({
      code: "E_PLAN_NOT_FOUND",
      message: "plan missing-plan not found",
    });
    await expect(readManifestRaw(cwd)).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      message: "manifest could not be read",
    });

    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    await writeFile(planPath(cwd, "bad-plan"), "{not-json");
    await writeFile(join(cwd, "pi-ship.json"), "{not-json");
    await expect(readPlanFile(cwd, "bad-plan")).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      message: "plan bad-plan is invalid JSON",
    });
    await expect(readManifestRaw(cwd)).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      message: "manifest is invalid JSON",
    });
  });

  it("validates digest before persistence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-plan-store-"));
    await expect(persistRailwayPlan(cwd, { ...base, planDigest: "tampered" })).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
    await persistRailwayPlan(cwd, { ...base, planDigest: computeDigest(base) });
    await expect(loadRailwayPlan(cwd, "other")).rejects.toMatchObject({ code: "E_PLAN_NOT_FOUND" });
  });

  it("rejects requested plan ID mismatch and nested unknown fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-plan-store-"));
    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    const other = { ...base, planId: "other" };
    await writeFile(planPath(cwd, "requested"), JSON.stringify({ ...other, planDigest: computeDigest(other) }));
    await expect(loadRailwayPlan(cwd, "requested")).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });

    const nestedUnknown = {
      ...base,
      manifest: { ...base.manifest, run: { ...base.manifest.run, unexpected: true } },
      planDigest: "irrelevant",
    };
    await writeFile(planPath(cwd, "p"), JSON.stringify(nestedUnknown));
    // isRailwayPlan (strict RailwayPlanSchema with additionalProperties:false) rejects nested unknown key
    await expect(loadRailwayPlan(cwd, "p")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects malformed plan with correct digest via shape validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-plan-store-"));
    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    // Malformed manifest (extra key in run) but computed digest matches its own content
    const malformed = {
      ...base,
      manifest: { ...base.manifest, run: { ...base.manifest.run, extraField: true } },
    };
    const digest = computeDigest(malformed);
    const full = { ...malformed, planDigest: digest };
    await writeFile(planPath(cwd, "malformed"), JSON.stringify(full));
    // isRailwayPlan rejects the shape before digest check
    await expect(loadRailwayPlan(cwd, "malformed")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects tampered persisted V2 digest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-plan-store-"));
    const manifest = { version: 2 as const, name: "x", app: { provider: "vercel" as const, config: { projectName: "x" } } };
    const plan = await buildVercelPlan(cwd, manifest, "production", "deploy", {
      accountRef: { kind: "user", id: "u" },
      source: { kind: "local-files", rootDirectory: ".", fileCount: 0, totalBytes: 0, fingerprint: "src" },
    });
    await persistVercelPlan(cwd, plan);
    const path = planPath(cwd, plan.planId);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    stored.estimatedImpact = "tampered";
    await writeFile(path, JSON.stringify(stored));
    await expect(loadVercelPlan(cwd, plan.planId)).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
  });
});
