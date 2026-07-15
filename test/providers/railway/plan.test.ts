import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildRailwayPlan, computeDigest, isRailwayPlanStale } from "../../../src/providers/railway/plan.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-plan-"));
  await initGit(tmp);
});

async function initGit(cwd: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "init.txt"), "x");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "init"], { cwd });
}

function baseManifest() {
  return {
    name: "app",
    provider: "railway" as const,
    project: "my-project",
    run: { command: ["node", "server.js"] as [string, string] },
  };
}

describe("buildRailwayPlan", () => {
  it("digest is deterministic", async () => {
    const m = baseManifest();
    const opts = { planId: "pid-1", createdAt: "2026-01-01T00:00:00.000Z" };
    const p1 = await buildRailwayPlan(tmp, m, "production", opts);
    const p2 = await buildRailwayPlan(tmp, m, "production", opts);
    expect(p1.planDigest).toBe(p2.planDigest);
  });

  it("changing manifest changes digest", async () => {
    const m1 = baseManifest();
    const opts = { planId: "pid-1", createdAt: "2026-01-01T00:00:00.000Z" };
    const p1 = await buildRailwayPlan(tmp, m1, "production", opts);
    const p2 = await buildRailwayPlan(tmp, { ...m1, project: "other-project" }, "production", opts);
    expect(p1.planDigest).not.toBe(p2.planDigest);
  });

  it("dirty worktree is flagged and included in hash", async () => {
    await writeFile(join(tmp, "dirty.txt"), "x");
    const p = await buildRailwayPlan(tmp, baseManifest(), "production");
    expect(p.gitDirty).toBe(true);
    expect(p.worktreeHash.length).toBeGreaterThan(0);
  });

  it("plan older than 30 minutes is stale", async () => {
    const p = await buildRailwayPlan(tmp, baseManifest(), "production");
    p.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    expect(await isRailwayPlanStale(p, tmp)).toBe(true);
  });

  it("plan is stale when worktree hash changes", async () => {
    const p = await buildRailwayPlan(tmp, baseManifest(), "production");
    await writeFile(join(tmp, "dirty.txt"), "x");
    expect(await isRailwayPlanStale(p, tmp)).toBe(true);
  });

  it("embedded digest matches recomputed digest", async () => {
    const p = await buildRailwayPlan(tmp, baseManifest(), "production");
    expect(computeDigest(p)).toBe(p.planDigest);
  });

  it("rollback plan includes intent and target release", async () => {
    const p = await buildRailwayPlan(tmp, baseManifest(), "production", {
      intent: "rollback",
      targetReleaseId: "rel-abc",
    });
    expect(p.intent).toBe("rollback");
    expect(p.targetReleaseId).toBe("rel-abc");
    expect(p.resourceActions).toEqual([
      { action: "rollback", resource: "deployment", name: "rel-abc" },
    ]);
    expect(p.secretNames).toEqual([]);
    expect(p.migrationCommand).toBeUndefined();
  });
});
