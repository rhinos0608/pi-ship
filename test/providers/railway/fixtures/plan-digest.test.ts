import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRailwayPlan, computeDigest, persistRailwayPlan as persistPlan, loadRailwayPlan as loadPlan, type RailwayPlan } from "../../../../src/providers/railway/plan.js";

const exec = promisify(execFile);

const fixtureManifest: {
  name: string;
  provider: "railway";
  project: string;
  run: { command: [string, string] };
  secrets: string[];
} = {
  name: "fixture-app",
  provider: "railway",
  project: "fixture-project",
  run: { command: ["node", "server.js"] },
  secrets: ["DATABASE_URL"],
};

// Hardcoded V1 plan digest. If this ever changes, the V1 canonicalization or
// the RailwayPlan shape has been perturbed. Any refactor that breaks this constant
// breaks the V1 Railway contract and is a blocker.
const V1_PLAN_DIGEST = "0db6e88fb36d652b454b3a3c2983cae6b1ddea6bcd48ac768ad7024c5b17bf22";

describe("V1 plan digest fixture", () => {
  let cwd: string;
  let plan: RailwayPlan;

  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-fixture-"));
    await exec("git", ["init"], { cwd, env });
    await exec("git", ["config", "user.email", "fixture@test.local"], { cwd, env });
    await exec("git", ["config", "user.name", "Fixture"], { cwd, env });
    await writeFile(join(cwd, "init.txt"), "fixture-content\n");
    await exec("git", ["add", "."], { cwd, env });
    await exec("git", ["commit", "-m", "fixture commit"], { cwd, env });
  });

  afterAll(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("produces a deterministic 64-char hex digest for fixed inputs", async () => {
    plan = await buildRailwayPlan(cwd, fixtureManifest, "production", {
      planId: "00000000-0000-0000-0000-000000000001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
    // Recomputing must yield the same digest.
    expect(computeDigest(plan)).toBe(plan.planDigest);
  });

  it("hardcoded V1 digest regression", async () => {
    // The contract is byte-stable: any change to the canonicalization,
    // RailwayPlan shape, or plan fields must fail this test.
    const p = await buildRailwayPlan(cwd, fixtureManifest, "production", {
      planId: "00000000-0000-0000-0000-000000000001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(p.planDigest).toBe(V1_PLAN_DIGEST);
  });

  it("re-running buildPlan with identical inputs yields the same digest", async () => {
    const second = await buildRailwayPlan(cwd, fixtureManifest, "production", {
      planId: "00000000-0000-0000-0000-000000000001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(second.planDigest).toBe(plan.planDigest);
  });

  it("persists and re-loads with the same digest", async () => {
    // Re-init the git history inside cwd so persistPlan doesn't perturb
    // the worktree hash for the next test.
    const tmp = await mkdtemp(join(tmpdir(), "pi-ship-fixture-load-"));
    try {
      await exec("git", ["init"], { cwd: tmp });
      await exec("git", ["config", "user.email", "fixture@test.local"], { cwd: tmp });
      await exec("git", ["config", "user.name", "Fixture"], { cwd: tmp });
      await writeFile(join(tmp, ".gitignore"), ".pi-ship/\n");
      await writeFile(join(tmp, "init.txt"), "fixture-content\n");
      await exec("git", ["add", "."], { cwd: tmp });
      await exec("git", ["commit", "-m", "fixture commit"], { cwd: tmp });
      const p = await buildRailwayPlan(tmp, fixtureManifest, "production", {
        planId: "00000000-0000-0000-0000-000000000001",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await persistPlan(tmp, p);
      const loaded = await loadPlan(tmp, p.planId);
      expect(loaded.planDigest).toBe(p.planDigest);
      expect(loaded.planId).toBe(p.planId);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
