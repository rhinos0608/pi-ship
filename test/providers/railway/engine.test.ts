import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { applyRailwayPlan } from "../../../src/providers/railway/engine.js";
import { err } from "../../../src/core/errors.js";
import { appendJournal } from "../../../src/providers/railway/journal.js";
import type { RailwayManifest } from "../../../src/providers/railway/manifest.js";
import { buildRailwayPlan } from "../../../src/providers/railway/plan.js";
import { defaultState, saveRailwayState } from "../../../src/providers/railway/state.js";
import { createFakeProvider } from "../../support/railway-fake.js";

const exec = promisify(execFile);

let cwd: string;
let registry: ApprovalRegistry;
const manifest: RailwayManifest = {
  name: "eng-test",
  provider: "railway",
  project: "eng-proj",
  run: { command: ["node", "server.js"] },
  secrets: ["APP_SECRET"],
};

async function initGit(repo: string): Promise<void> {
  await exec("git", ["init"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@test.local"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, ".gitignore"), ".pi-ship/\n");
  await writeFile(join(repo, "x"), "y");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "init"], { cwd: repo });
}

async function makeApprovedPlan() {
  const state = defaultState();
  const plan = await buildRailwayPlan(cwd, manifest, "production", {
    planId: "eng-plan-1",
    targetSnapshot: {
      projectId: state.projectId,
      projectName: state.projectName,
      environmentId: state.environmentId,
      environmentName: state.environmentName,
      serviceIds: state.serviceIds,
      serviceNames: state.serviceNames,
    },
  });
  registry.approve(plan.planId, plan.planDigest, undefined, { domain: "deployment", risk: "destructive" });
  return plan;
}

type ApplyContext = Parameters<typeof applyRailwayPlan>[0];
function baseCtx(
  plan: Awaited<ReturnType<typeof makeApprovedPlan>>,
  overrides: Partial<ApplyContext> = {}
): ApplyContext {
  return {
    adapter: createFakeProvider(),
    manifest,
    plan,
    cwd,
    envReader: () => ({ APP_SECRET: "val" }),
    piExec: async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      killed: false,
      cancelled: false,
      truncated: false,
    }),
    registry,
    suppliedDigest: plan.planDigest,
    ...overrides,
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-ship-engine-"));
  await initGit(cwd);
  registry = new ApprovalRegistry(cwd);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("applyPlan preflight", () => {
  it("rejects digest mismatch", async () => {
    const plan = await makeApprovedPlan();
    await expect(applyRailwayPlan(baseCtx(plan, { suppliedDigest: "bad" }))).rejects.toMatchObject({
      code: "E_DIGEST_MISMATCH",
    });
  });

  it("rejects unapproved plan", async () => {
    const state = defaultState();
    const plan = await buildRailwayPlan(cwd, manifest, "production", {
      planId: "unapproved",
      targetSnapshot: {
        projectId: state.projectId,
        projectName: state.projectName,
        environmentId: state.environmentId,
        environmentName: state.environmentName,
        serviceIds: state.serviceIds,
        serviceNames: state.serviceNames,
      },
    });
    await expect(applyRailwayPlan(baseCtx(plan))).rejects.toMatchObject({
      code: "E_APPROVAL_REQUIRED",
    });
  });

  it("rejects stale plan (createdAt > 30 min ago)", async () => {
    const state = defaultState();
    const plan = await buildRailwayPlan(cwd, manifest, "production", {
      planId: "stale-plan",
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      targetSnapshot: {
        projectId: state.projectId,
        projectName: state.projectName,
        environmentId: state.environmentId,
        environmentName: state.environmentName,
        serviceIds: state.serviceIds,
        serviceNames: state.serviceNames,
      },
    });
    registry.approve(plan.planId, plan.planDigest, undefined, { domain: "deployment", risk: "destructive" });
    await expect(applyRailwayPlan(baseCtx(plan))).rejects.toMatchObject({
      code: "E_PLAN_STALE",
    });
  });

  it("rejects missing secrets", async () => {
    const plan = await makeApprovedPlan();
    await expect(
      applyRailwayPlan(baseCtx(plan, { envReader: () => ({}) }))
    ).rejects.toMatchObject({ code: "E_PRECONDITION" });
  });

  it("rejects dangling non-idempotent journal", async () => {
    const plan = await makeApprovedPlan();
    await appendJournal(cwd, {
      ts: "t1",
      planId: plan.planId,
      step: "deploy",
      status: "start",
    });
    await expect(applyRailwayPlan(baseCtx(plan))).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
    });
  });

  it("skips already-applied plan", async () => {
    const plan = await makeApprovedPlan();
    const state = defaultState();
    state.history.push({
      planId: plan.planId,
      digest: plan.planDigest,
      at: new Date().toISOString(),
      status: "ok",
    });
    await saveRailwayState(cwd, state);
    const result = await applyRailwayPlan(baseCtx(plan));
    expect(result.content[0]?.text).toContain("already applied");
  });

  it("throws on aborted signal before adapter call", async () => {
    const plan = await makeApprovedPlan();
    const ac = new AbortController();
    ac.abort();
    // Current V1 behavior: authorizePlanApply propagates AbortError when the
    // signal is already aborted. The engine does not yet translate it to E_CANCELLED.
    await expect(
      applyRailwayPlan(baseCtx(plan, { signal: ac.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps auth failure to E_AUTH_MISSING", async () => {
    const plan = await makeApprovedPlan();
    const provider = createFakeProvider();
    provider.injectFailure("checkAuth", err("E_AUTH_MISSING", "no token"));
    await expect(
      applyRailwayPlan(baseCtx(plan, { adapter: provider }))
    ).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
  });
});
