import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { applyVercelPlan } from "../../../src/providers/vercel/engine.js";
import { appendOperationEntry, readOperationJournal } from "../../../src/providers/vercel/operation-journal.js";
import { buildVercelPlan, type VercelPlan, type VercelOperation } from "../../../src/providers/vercel/plan.js";
import type { VercelManifest } from "../../../src/providers/vercel/manifest.js";
import { unverified, verified, type OperationResult, type ReconciliationState, type Verification } from "../../../src/deployment/contracts.js";
import type { VercelRuntime } from "../../../src/providers/vercel/runtime.js";
import type { VercelReleaseStatus } from "../../../src/providers/vercel/engine.js";
import type { ApplyVercelPlanContext } from "../../../src/providers/vercel/engine.js";
import { loadVercelState } from "../../../src/providers/vercel/state.js";

const manifest = {
  version: 2 as const,
  name: "site",
  app: { provider: "vercel" as const, config: { projectName: "site" } },
};

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ship-engine-v2-"));
  const plan = await buildVercelPlan(cwd, manifest, "production", "deploy", {
    accountRef: { kind: "user", id: "u" },
    source: { kind: "local-files", rootDirectory: ".", fileCount: 0, totalBytes: 0, fingerprint: "src" },
    gitCommit: "g",
    worktreeHash: "w",
  });
  const registry = new ApprovalRegistry(cwd);
  registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });
  return { cwd, plan, registry };
}

function resourceRef(operation: VercelOperation): string {
  if (operation.kind === "ensure_project" || operation.kind === "upsert_secrets") return "project-1";
  return "release-1";
}

function runtime(overrides: {
  execute?: (operation: VercelOperation) => Promise<OperationResult<VercelReleaseStatus>>;
  reconcile?: (operation: VercelOperation, resourceRef?: string) => Promise<Verification<ReconciliationState<VercelReleaseStatus>>>;
} = {}): VercelRuntime {
  return {
    descriptor: { domain: "app", provider: "vercel", capabilities: ["discover", "write_secrets", "deploy", "status", "logs", "rollback"] },
    checkAuth: async () => verified({ kind: "user", id: "u" }),
    discover: async () => verified({ account: { kind: "user", id: "u" }, project: null, environment: "production" }),
    plan: async () => verified([]),
    execute: overrides.execute ?? (async (operation) => ({ status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: resourceRef(operation) })),
    reconcile: overrides.reconcile ?? (async () => verified({ outcome: "not_applied", observedStateFingerprint: "absent" })),
    status: async () => verified("ready"),
    logs: async () => verified("")
  };
}

function context(f: Awaited<ReturnType<typeof fixture>>, provider = runtime()) {
  return {
    ...f,
    manifest,
    suppliedDigest: f.plan.planDigest,
    createRuntime: () => provider,
    loadSecrets: () => ({}),
    currentSource: { gitCommit: "g", worktreeHash: "w", sourceFingerprint: "src" },
  };
}

async function appendStart(cwd: string, plan: VercelPlan, operation: VercelOperation): Promise<void> {
  await appendOperationEntry(cwd, {
    version: 2,
    ts: new Date().toISOString(),
    planId: plan.planId,
    planDigest: plan.planDigest,
    provider: "vercel",
    domain: "app",
    operationId: operation.operationId,
    kind: operation.kind,
    targetFingerprint: operation.targetFingerprint,
    requestFingerprint: operation.requestFingerprint,
    expectedStateFingerprint: operation.expectedStateFingerprint,
    attempt: 1,
    status: "start",
  });
}

describe("V2 engine", () => {
  it("denies execution without in-memory approval", async () => {
    const f = await fixture();
    await expect(applyVercelPlan({ ...context(f), registry: new ApprovalRegistry(f.cwd) })).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });

  it("persists project, release, environment, and history after success", async () => {
    const f = await fixture();
    const state = await applyVercelPlan(context(f));
    expect(state.app?.project.id).toBe("project-1");
    expect(state.app?.environments.production?.lastRelease?.id).toBe("release-1");
    expect(state.releases).toHaveLength(1);
    expect(state.history).toHaveLength(1);
    await expect(loadVercelState(f.cwd)).resolves.toEqual(state);
  });

  it("reconciles a persisted start and blocks conflict without executing", async () => {
    const f = await fixture();
    await appendStart(f.cwd, f.plan, f.plan.operations[0]);
    const execute = vi.fn(async () => ({ status: "failed", certainty: "not_applied", code: "E_PROVIDER", safeMessage: "not called", retryable: false } as const));
    const provider = runtime({ execute, reconcile: async () => verified({ outcome: "conflict", observedStateFingerprint: "other" }) });
    await expect(applyVercelPlan(context(f, provider))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(execute).not.toHaveBeenCalled();
    expect((await readOperationJournal(f.cwd)).at(-1)).toMatchObject({ status: "reconciled", outcome: "conflict" });
  });

  it("persists releaseStatus and releaseUrl when deploy returns queued", async () => {
    const f = await fixture();
    const deployOp = f.plan.operations[2];
    const execute = vi.fn(async (operation: VercelOperation): Promise<OperationResult<VercelReleaseStatus>> => {
      if (operation.operationId === deployOp.operationId) {
        return {
          status: "succeeded",
          observedStateFingerprint: operation.expectedStateFingerprint,
          resourceRef: "release-queued-1",
          providerRequestId: "req-1",
          releaseStatus: "queued",
          releaseUrl: "https://site.vercel.app",
        };
      }
      return { status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: "project-1" };
    });
    const provider = runtime({ execute });
    const state = await applyVercelPlan(context(f, provider));
    // Check state has building status (queued mapped to building) and URL
    expect(state.app?.environments.production?.lastRelease?.status).toBe("building");
    expect(state.app?.environments.production?.lastRelease?.url).toBe("https://site.vercel.app");
    // Check journal round-trips with releaseStatus/releaseUrl
    const entries = await readOperationJournal(f.cwd);
    const deployEntries = entries.filter((e) => e.operationId === deployOp.operationId && e.status === "ok");
    expect(deployEntries.length).toBeGreaterThan(0);
    const okEntry = deployEntries[0];
    expect(okEntry).toHaveProperty("releaseStatus");
    expect(okEntry).toHaveProperty("releaseUrl");
    if (okEntry?.status === "ok") {
      expect(okEntry.releaseStatus).toBe("queued");
      expect(okEntry.releaseUrl).toBe("https://site.vercel.app");
    }
  });

  it("persists READY metadata when a pre-existing deploy start reconciles", async () => {
    const f = await fixture();
    const deploy = f.plan.operations.find((operation) => operation.kind === "deploy");
    if (!deploy) throw new Error("deploy operation missing");
    await appendStart(f.cwd, f.plan, deploy);
    const execute = vi.fn(async (operation: VercelOperation): Promise<OperationResult<VercelReleaseStatus>> => {
      if (operation.kind === "deploy") throw new Error("deploy must not execute after reconciliation");
      return { status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: "project-1" };
    });
    const provider = runtime({
      execute,
      reconcile: async (operation) => verified({
        outcome: "matches_expected",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: "release-ready-1",
        releaseStatus: "ready",
        releaseUrl: "https://ready.vercel.app",
      }),
    });

    const state = await applyVercelPlan(context(f, provider));
    expect(execute.mock.calls.some(([operation]) => operation.kind === "deploy")).toBe(false);
    expect(state.app?.environments.production?.lastRelease).toMatchObject({
      id: "release-ready-1",
      status: "ready",
      url: "https://ready.vercel.app",
    });
    const reconciled = (await readOperationJournal(f.cwd)).find(
      (entry) => entry.operationId === deploy.operationId && entry.status === "reconciled" && entry.outcome === "matches_expected",
    );
    if (reconciled?.status !== "reconciled" || reconciled.outcome !== "matches_expected") {
      throw new Error("matched reconciliation entry missing");
    }
    expect(reconciled.releaseStatus).toBe("ready");
    expect(reconciled.releaseUrl).toBe("https://ready.vercel.app");
  });

  it("persists queued metadata after immediate ambiguous deploy reconciliation", async () => {
    const f = await fixture();
    const execute = vi.fn(async (operation: VercelOperation): Promise<OperationResult<VercelReleaseStatus>> => operation.kind === "deploy"
      ? { status: "ambiguous", reason: "transport", safeMessage: "deployment result unknown" }
      : { status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: "project-1" });
    const provider = runtime({
      execute,
      reconcile: async (operation) => verified({
        outcome: "matches_expected",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: "release-queued-2",
        releaseStatus: "queued",
        releaseUrl: "https://queued.vercel.app",
      }),
    });

    const state = await applyVercelPlan(context(f, provider));
    expect(state.app?.environments.production?.lastRelease).toMatchObject({
      id: "release-queued-2",
      status: "building",
      url: "https://queued.vercel.app",
    });
  });

  it.each(["404", "500"])("does not execute after an unverified %s project reconciliation", async (status) => {
    const f = await fixture();
    const ensure = f.plan.operations[0];
    await appendStart(f.cwd, f.plan, ensure);
    const execute = vi.fn(async (): Promise<OperationResult<VercelReleaseStatus>> => ({
      status: "failed",
      certainty: "not_applied",
      code: "E_PROVIDER",
      safeMessage: "must not execute",
      retryable: false,
    }));
    const provider = runtime({
      execute,
      reconcile: async () => unverified("transport", `project lookup ${status} unverified`, status === "500"),
    });

    await expect(applyVercelPlan(context(f, provider))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries once only after verified not_applied reconciliation", async () => {
    const f = await fixture();
    const first = f.plan.operations[0];
    let firstCalls = 0;
    const execute = vi.fn(async (operation: VercelOperation): Promise<OperationResult<VercelReleaseStatus>> => {
      if (operation.operationId !== first.operationId) return { status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: resourceRef(operation) };
      firstCalls += 1;
      if (firstCalls === 1) return { status: "ambiguous", reason: "transport", safeMessage: "unknown" };
      return { status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: "project-1" };
    });
    const state = await applyVercelPlan(context(f, runtime({ execute, reconcile: async () => verified({ outcome: "not_applied", observedStateFingerprint: "absent" }) })));
    expect(firstCalls).toBe(2);
    expect(state.history).toHaveLength(1);
    expect((await readOperationJournal(f.cwd)).filter((entry) => entry.operationId === first.operationId).map((entry) => entry.status)).toEqual(["start", "ambiguous", "reconciled", "start", "ok"]);
  });

  it("journals ambiguous with resourceRef and blocks without retry on mutation mismatch", async () => {
    const f = await fixture();
    const ensureOp = f.plan.operations[0];
    let executeCalls = 0;
    const execute = vi.fn(async (operation: VercelOperation): Promise<OperationResult<VercelReleaseStatus>> => {
      if (operation.operationId === ensureOp.operationId) {
        executeCalls++;
        return { status: "ambiguous", reason: "conflict", safeMessage: `created project name mismatch`, resourceRef: "project-created-1" };
      }
      return { status: "succeeded", observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: resourceRef(operation) };
    });
    const reconcile = vi.fn(async (operation: VercelOperation, ref?: string): Promise<Verification<ReconciliationState<VercelReleaseStatus>>> => {
      if (operation.operationId === ensureOp.operationId) {
        return verified({ outcome: "conflict" as const, observedStateFingerprint: ref ?? "unknown" });
      }
      return verified({ outcome: "matches_expected" as const, observedStateFingerprint: operation.expectedStateFingerprint, resourceRef: resourceRef(operation) });
    });
    const provider = runtime({ execute, reconcile });
    await expect(applyVercelPlan(context(f, provider))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(executeCalls).toBe(1);
    const entries = await readOperationJournal(f.cwd);
    const ambiguousEntries = entries.filter((e) => e.operationId === ensureOp.operationId && e.status === "ambiguous");
    expect(ambiguousEntries).toHaveLength(1);
    const ae = ambiguousEntries[0];
    if (ae.status === "ambiguous") {
      expect(ae.resourceRef).toBe("project-created-1");
      expect(ae.reason).toBe("conflict");
    }
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: ensureOp.operationId }),
      "project-created-1",
      undefined,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("regression: upsert secrets with failed entries blocks deployment and never journals ok", async () => {
    const { createVercelClient } = await import("../../../src/providers/vercel/client.js");
    const { createVercelRuntime } = await import("../../../src/providers/vercel/runtime.js");
    // Build a plan with secrets so upsert loop runs
    const secretManifest: VercelManifest = {
      version: 2 as const,
      name: "secrets-test",
      app: { provider: "vercel" as const, config: { projectName: "secrets-test" } },
      secrets: ["MY_SECRET"],
    };
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-engine-secretfail-"));
    const plan = await buildVercelPlan(cwd, secretManifest, "production", "deploy", {
      accountRef: { kind: "user", id: "u" },
      source: { kind: "local-files", rootDirectory: ".", fileCount: 0, totalBytes: 0, fingerprint: "src" },
      gitCommit: "g",
      worktreeHash: "w",
    });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "destructive" });
    let upsertCalls = 0;
    let projectExists = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/v2/user")) {
        return new Response(JSON.stringify({ user: { id: "u", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v10/projects") && method === "GET") {
        return new Response(JSON.stringify({ projects: projectExists ? [{ id: "p1", name: "secrets-test" }] : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v11/projects") && method === "POST") {
        projectExists = true;
        return new Response(JSON.stringify({ id: "p1", name: "secrets-test" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/env") && method === "POST") {
        upsertCalls++;
        return new Response(JSON.stringify({ created: {}, failed: [{ error: { code: "limit", message: "rate limit exceeded" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v2/files") && method === "POST") {
        return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v13/deployments") && method === "POST") {
        deploymentAttempts++;
        throw new Error("must not reach deployment");
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    };
    let deploymentAttempts = 0;
    const client = createVercelClient({ token: "tok_test" }, fetchImpl);
    const runtime = createVercelRuntime({ client, cwd });
    const ctx: ApplyVercelPlanContext = {
      cwd,
      plan,
      manifest: secretManifest,
      suppliedDigest: plan.planDigest,
      createRuntime: () => runtime,
      loadSecrets: () => ({ MY_SECRET: "v1" }),
      currentSource: { gitCommit: "g", worktreeHash: "w", sourceFingerprint: "src" },
      registry,
    };
    await expect(applyVercelPlan(ctx)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(upsertCalls).toBeGreaterThan(0);
    expect(deploymentAttempts).toBe(0);
    const journal = await readOperationJournal(cwd);
    const upsertEntries = journal.filter((e) => e.kind === "upsert_secrets");
    expect(upsertEntries.some((e) => e.status === "ok")).toBe(false);
    const ambiguousEntries = upsertEntries.filter((e) => e.status === "ambiguous");
    expect(ambiguousEntries.length).toBeGreaterThan(0);
    if (ambiguousEntries[0]?.status === "ambiguous") {
      expect(ambiguousEntries[0].safeMessage).not.toContain("rate limit exceeded");
      expect(ambiguousEntries[0].safeMessage).not.toContain("tok_test");
    }
  });

  it("regression: real runtime blocks ensure_project retry when createProject name mismatch produces resourceRef", async () => {
    const { createVercelClient } = await import("../../../src/providers/vercel/client.js");
    const { createVercelRuntime } = await import("../../../src/providers/vercel/runtime.js");
    const f = await fixture();

    let createCalls = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      // Must match fixture plan identity { kind: "user", id: "u" }
      if (url.includes("/v2/user")) {
        return new Response(JSON.stringify({ user: { id: "u", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v10/projects") && method === "GET") {
        return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v11/projects") && method === "POST") {
        createCalls++;
        // createProject returns a project with a different name — ambiguous conflict
        return new Response(JSON.stringify({ id: "p_conflict", name: "other-name" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fake request: ${method} ${url}`);
    };

    const client = createVercelClient({ token: "tok_test" }, fetchImpl);
    const runtime = createVercelRuntime({ client, cwd: f.cwd });

    // Current apply: one create POST, then conflict blocks
    await expect(applyVercelPlan(context(f, runtime))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(createCalls).toBe(1);

    // Resumed apply: prior journal entry with resourceRef causes immediate conflict, no API calls
    await expect(applyVercelPlan(context(f, runtime))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(createCalls).toBe(1);
  });
});
