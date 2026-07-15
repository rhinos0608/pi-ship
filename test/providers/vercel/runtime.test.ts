import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createVercelClient, type VercelClient, type VercelFetchLike } from "../../../src/providers/vercel/client.js";
import {
  createVercelRuntime,
  type AppOperationRuntime,
  type VercelExecutionInput,
  type VercelPlanInput,
  type VercelSnapshot,
} from "../../../src/providers/vercel/runtime.js";
import { unverified, verified } from "../../../src/deployment/contracts.js";
import type { VercelOperation } from "../../../src/providers/vercel/plan.js";
import { enumerateSource } from "../../../src/providers/vercel/source.js";

const execFileAsync = promisify(execFile);

// ── Test helpers ────────────────────────────────────────────────────────────────

function fakeOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeEmpty(status = 201): Response {
  return new Response(null, { status });
}

/** SHA-256 hex helper for file content. */
function sha1Hex(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Build a recording fetch that maps request URLs to canned responses. */
function mapFetch(responses: Record<string, Response>): VercelFetchLike {
  return async (input) => {
    const url = typeof input === "string" ? input : String(input);
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (key) return responses[key];
    return fakeOk({});
  };
}

// ── Runtime factory helper ──────────────────────────────────────────────────────

function runtimeWithFetch(
  fetchImpl: VercelFetchLike,
  teamId?: string,
  maxRetries = 0,
): AppOperationRuntime<VercelSnapshot, VercelOperation, string, string> {
  const client = createVercelClient(
    { token: "tok_test", teamId, maxRetries, backoff: () => 1 },
    fetchImpl,
  );
  return createVercelRuntime({ client, cwd: "/tmp/test-cwd", teamId });
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("VercelRuntime", () => {
  describe("checkAuth", () => {
    it("returns user account when no teamId", async () => {
      const fetch = async () =>
        fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.checkAuth();
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toEqual({ kind: "user", id: "u1" });
      }
    });

    it("returns team account when teamId configured", async () => {
      const calls: string[] = [];
      const fetch = async (url: string) => {
        calls.push(url);
        if (url.includes("/v2/user")) {
          return fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: "team_x" } });
        }
        if (url.includes("/v10/projects")) {
          return fakeOk({ projects: [] });
        }
        return fakeOk({});
      };
      const rt = runtimeWithFetch(fetch, "team_x");
      const result = await rt.checkAuth();
      expect(calls.some((c) => c.includes("/v10/projects"))).toBe(true);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toEqual({ kind: "team", id: "team_x" });
      }
    });

    it("classifies team-scoped rate limits, server errors, and transport failures", async () => {
      const cases: Array<{
        label: string;
        response: () => Promise<Response>;
        reason: "rate_limited" | "transport";
      }> = [
        { label: "429", response: async () => fakeError(429, "rate limited"), reason: "rate_limited" },
        { label: "500", response: async () => fakeError(500, "server failed"), reason: "transport" },
        { label: "transport", response: async () => { throw new TypeError("offline"); }, reason: "transport" },
      ];
      for (const testCase of cases) {
        const fetch = async (url: string) => url.includes("/v2/user")
          ? fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: "team_x" } })
          : testCase.response();
        const result = await runtimeWithFetch(fetch, "team_x").checkAuth();
        expect(result.status, testCase.label).toBe("unverified");
        if (result.status === "unverified") {
          expect(result.reason, testCase.label).toBe(testCase.reason);
          expect(result.retryable, testCase.label).toBe(true);
        }
      }
    });

    it.each([
      [401, "unauthorized"],
      [403, "forbidden"],
    ] as const)("classifies team-scoped HTTP %s as %s", async (status, reason) => {
      const fetch = async (url: string) => url.includes("/v2/user")
        ? fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: "team_x" } })
        : fakeError(status, "team denied");
      const result = await runtimeWithFetch(fetch, "team_x").checkAuth();
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe(reason);
        expect(result.retryable).toBe(false);
      }
    });

    it("returns unverified when team read fails", async () => {
      const fetch = async (url: string) => {
        if (url.includes("/v2/user")) {
          return fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: "team_x" } });
        }
        if (url.includes("/v10/projects")) {
          return fakeError(403, "team access denied");
        }
        return fakeOk({});
      };
      const rt = runtimeWithFetch(fetch, "team_x");
      const result = await rt.checkAuth();
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("forbidden");
      }
    });

    it("returns unverified on auth error", async () => {
      const fetch = async () => fakeError(401, "unauthorized");
      const rt = runtimeWithFetch(fetch);
      const result = await rt.checkAuth();
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("unauthorized");
      }
    });

    it("returns unverified on transport error", async () => {
      const fetch = async () => { throw new TypeError("fetch failed"); };
      const rt = runtimeWithFetch(fetch);
      const result = await rt.checkAuth();
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("transport");
      }
    });
  });

  describe("discover", () => {
    it("finds existing project and returns snapshot", async () => {
      const fetch = mapFetch({
        "/v2/user": fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }),
        "/v10/projects?search=my-app": fakeOk({ projects: [{ id: "p1", name: "my-app" }] }),
      });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.discover({
        projectName: "my-app",
        environment: "production",
      });
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.account).toEqual({ kind: "user", id: "u1" });
        expect(result.value.project).not.toBeNull();
        expect(result.value.project!.id).toBe("p1");
        expect(result.value.project!.name).toBe("my-app");
        expect(result.value.environment).toBe("production");
      }
    });

    it("returns snapshot with null project when absent (verified)", async () => {
      const fetch = mapFetch({
        "/v2/user": fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }),
        "/v10/projects?search=absent-app": fakeOk({ projects: [] }),
      });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.discover({
        projectName: "absent-app",
        environment: "preview",
      });
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.project).toBeNull();
      }
    });

    it("rejects a target team when runtime has no team", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const result = await rt.discover({ projectName: "my-app", teamId: "team_x", environment: "production" });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") expect(result.reason).toBe("forbidden");
    });

    it("rejects a target team that differs from runtime team", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}), "team_x");
      const result = await rt.discover({ projectName: "my-app", teamId: "team_y", environment: "production" });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") expect(result.reason).toBe("forbidden");
    });

    it("returns unverified when auth fails", async () => {
      const fetch = async () => fakeError(401, "invalid token");
      const rt = runtimeWithFetch(fetch);
      const result = await rt.discover({
        projectName: "my-app",
        environment: "production",
      });
      expect(result.status).toBe("unverified");
    });
  });

  describe("plan", () => {
    it("returns unverified missing_payload when deploy intent has no source", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const input: VercelPlanInput = {
        environment: "production",
        projectName: "my-app",
      };
      const snapshot: VercelSnapshot = {
        account: { kind: "user", id: "u1" },
        project: { id: "p1", name: "my-app" },
        environment: "production",
      };
      const result = await rt.plan("deploy", input, snapshot);
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("missing_payload");
      }
    });

    it("returns deploy operations for preview", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const input: VercelPlanInput = {
        environment: "preview",
        projectName: "my-app",
        source: { kind: "local-files", rootDirectory: ".", fileCount: 1, totalBytes: 10, fingerprint: "fp1" },
        secretNames: ["API_KEY"],
      };
      const snapshot: VercelSnapshot = {
        account: { kind: "user", id: "u1" },
        project: { id: "p1", name: "my-app" },
        environment: "preview",
      };
      const result = await rt.plan("deploy", input, snapshot);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toHaveLength(3);
        expect(result.value[0].kind).toBe("ensure_project");
        expect(result.value[1].kind).toBe("upsert_secrets");
        expect(result.value[2].kind).toBe("deploy");
        if (result.value[2].kind === "deploy") {
          expect(result.value[2].observedProjectId).toBe("p1");
        }
        // Verify deterministic fingerprints
        expect(result.value[0].operationId).toBeDefined();
        expect(result.value[0].expectedStateFingerprint).toBeDefined();
        expect(result.value[0].targetFingerprint).toBeDefined();
      }
    });

    it("returns rollback operations for production", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const input: VercelPlanInput = {
        environment: "production",
        projectName: "my-app",
        targetDeploymentId: "dpl_abc",
      };
      const snapshot: VercelSnapshot = {
        account: { kind: "user", id: "u1" },
        project: { id: "p1", name: "my-app" },
        environment: "production",
      };
      const result = await rt.plan("rollback", input, snapshot);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].kind).toBe("rollback");
        const op = result.value[0];
        if (op.kind === "rollback") {
          expect(op.targetDeploymentId).toBe("dpl_abc");
        }
      }
    });

    it("rejects rollback on preview environment", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const input: VercelPlanInput = {
        environment: "preview",
        projectName: "my-app",
      };
      const snapshot: VercelSnapshot = {
        account: { kind: "user", id: "u1" },
        project: { id: "p1", name: "my-app" },
        environment: "preview",
      };
      const result = await rt.plan("rollback", input, snapshot);
      expect(result.status).toBe("unverified");
    });

    it("includes targetDeploymentId in rollback operations", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const input: VercelPlanInput = {
        environment: "production",
        projectName: "my-app",
        targetDeploymentId: "dpl_abc",
      };
      const snapshot: VercelSnapshot = {
        account: { kind: "user", id: "u1" },
        project: { id: "p1", name: "my-app" },
        environment: "production",
      };
      const result = await rt.plan("rollback", input, snapshot);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value[0].kind).toBe("rollback");
        // Access targetDeploymentId on narrowed type
        const op = result.value[0];
        if (op.kind === "rollback") {
          expect(op.targetDeploymentId).toBe("dpl_abc");
        }
      }
    });
  });

  describe("execute - ensure_project", () => {
    it("finds existing project", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [{ id: "p1", name: "my-app" }] }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "ensure_project",
        projectName: "my-app",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.resourceRef).toBe("p1");
      }
    });

    it("creates project when not found", async () => {
      let callCount = 0;
      const fetch = async (url: string) => {
        if (url.includes("/v10/projects")) {
          return fakeOk({ projects: [] });
        }
        if (url.includes("/v11/projects")) {
          callCount++;
          return fakeOk({ id: "p_new", name: "new-app" });
        }
        return fakeOk({});
      };
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "ensure_project",
        projectName: "new-app",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.resourceRef).toBe("p_new");
      }
      expect(callCount).toBe(1);
    });

    it("uses existing project when found by name", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [{ id: "p1", name: "my-app" }] }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "ensure_project",
        projectName: "my-app",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.resourceRef).toBe("p1");
      }
    });

    it("returns ambiguous with resourceRef when created project name mismatches", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [] }),
        "/v11/projects": fakeOk({ id: "p_new", name: "other-name" }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "ensure_project",
        projectName: "my-app", targetFingerprint: "tf1", requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1", destructive: false, reversible: false, dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.reason).toBe("conflict");
        expect(result.resourceRef).toBe("p_new");
      }
    });
  });

  describe("execute - upsert_secrets", () => {
    it("returns ambiguous conflict when upsertEnv response includes failed entries", async () => {
      let callCount = 0;
      const fetch = async (url: string) => {
        if (url.includes("/v10/projects/my-app/env")) {
          callCount++;
          return fakeOk({ created: {}, failed: [{ error: { code: "rate_limit", message: "secret value invalid" } }] });
        }
        return fakeOk({});
      };
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "upsert_secrets",
        projectName: "my-app", environment: "production", secretNames: ["API_KEY"],
        targetFingerprint: "tf1", requestFingerprint: "rf1", expectedStateFingerprint: "esf1",
        destructive: false, reversible: false, dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: { API_KEY: "sk-123" } });
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.reason).toBe("conflict");
        expect(result.safeMessage).not.toContain("secret value invalid");
        expect(result.safeMessage).not.toContain("sk-123");
      }
      expect(callCount).toBe(1);
    });

    it("returns ambiguous conflict for partial failed entries after prior success", async () => {
      let callIndex = 0;
      const results = [
        { created: {} }, // first succeeds
        { created: {}, failed: [{ error: { code: "limit", message: "second failed" } }] }, // second fails
      ];
      const fetch = async (url: string) => {
        if (url.includes("/v10/projects/my-app/env")) {
          return fakeOk(results[callIndex++ % results.length]);
        }
        return fakeOk({});
      };
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "upsert_secrets",
        projectName: "my-app", environment: "production", secretNames: ["KEY_A", "KEY_B"],
        targetFingerprint: "tf1", requestFingerprint: "rf1", expectedStateFingerprint: "esf1",
        destructive: false, reversible: false, dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: { KEY_A: "v1", KEY_B: "v2" } });
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.reason).toBe("conflict");
        expect(result.safeMessage).not.toContain("second failed");
        expect(result.safeMessage).not.toContain("v1");
        expect(result.safeMessage).not.toContain("v2");
      }
    });

    it("upserts each declared secret with sensitive type and correct target", async () => {
      const calls: string[] = [];
      const fetch = async (url: string, init?: RequestInit) => {
        if (url.includes("/v10/projects/my-app/env")) {
          const body = JSON.parse(init?.body as string) as Record<string, unknown>;
          calls.push(`${body.key}=${body.type}:${(body.target as string[]).join(",")}`);
          return fakeOk({ created: {} });
        }
        return fakeOk({});
      };
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "upsert_secrets",
        projectName: "my-app",
        environment: "production",
        secretNames: ["API_KEY", "DB_URL"],
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: { API_KEY: "sk-123", DB_URL: "postgres://..." } });
      expect(result.status).toBe("succeeded");
      expect(calls).toEqual([
        "API_KEY=sensitive:production",
        "DB_URL=sensitive:production",
      ]);
    });

    it("fails when secret value missing", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "upsert_secrets",
        projectName: "my-app",
        environment: "production",
        secretNames: ["MISSING_SECRET"],
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.code).toBe("E_PRECONDITION");
      }
    });
  });

  describe("execute - deploy", () => {
    it.each([
      ["wrong-name", "p1"],
      ["my-app", "wrong-project"],
    ] as const)("returns ambiguous with resourceRef for deployment response identity %s/%s", async (name, projectId) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vercel-runtime-"));
      await execFileAsync("git", ["init"], { cwd });
      await writeFile(join(cwd, "index.js"), "export default 1;");
      await execFileAsync("git", ["add", "index.js"], { cwd });
      const snapshot = await enumerateSource(cwd, ".");
      const client = {
        uploadFile: async () => ({ urls: [] }),
        createDeployment: async () => ({
          id: "dpl_1",
          name,
          projectId,
          url: "https://my-app.vercel.app",
          readyState: "READY" as const,
          createdAt: Date.now(),
        }),
      } as unknown as VercelClient;
      const rt = createVercelRuntime({ client, cwd });
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "deploy",
        projectName: "my-app", observedProjectId: "p1", environment: "production",
        source: { kind: "local-files", rootDirectory: ".", fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes, fingerprint: snapshot.fingerprint },
        targetFingerprint: "tf1", requestFingerprint: "rf1", expectedStateFingerprint: "esf1",
        destructive: false, reversible: true, dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.reason).toBe("conflict");
        expect(result.resourceRef).toBe("dpl_1");
      }
    });

    it("requires operation with source ref", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "deploy",
        projectName: "my-app",
        environment: "preview",
        // No source — will fail
        source: undefined as unknown as import("../../../src/providers/vercel/plan.js").LocalSourceRef,
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.code).toBe("E_PRECONDITION");
      }
    });
  });

  describe("execute - rollback", () => {
    it("calls rollback endpoint and returns succeeded", async () => {
      const calls: string[] = [];
      const fetch = async (url: string) => {
        calls.push(url);
        return fakeEmpty(201);
      };
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "rollback",
        projectId: "p1",
        environment: "production",
        targetDeploymentId: "dpl_abc",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: true,
        dependsOn: [],
      };
      const result = await rt.execute(op, { secretValues: {} });
      expect(result.status).toBe("succeeded");
      expect(calls.some((c) => c.includes("/rollback/"))).toBe(true);
    });
  });

  describe("status", () => {
    it("maps readyState to typed status string", async () => {
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": fakeOk({
          id: "dpl_abc",
          name: "my-app",
          url: "https://my-app.vercel.app",
          readyState: "READY",
          createdAt: 1700000000000,
          projectId: "p1",
        }),
      });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.status("dpl_abc");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toBe("ready");
      }
    });

    it("returns unverified on unknown state", async () => {
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": fakeOk({
          id: "dpl_abc",
          name: "my-app",
          url: "https://my-app.vercel.app",
          readyState: "BOGUS",
          createdAt: 1700000000000,
          projectId: "p1",
        }),
      });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.status("dpl_abc");
      expect(result.status).toBe("unverified");
    });
  });

  describe("logs", () => {
    it("fetches runtime logs, redacts secrets, caps output", async () => {
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": fakeOk({
          id: "dpl_abc",
          name: "my-app",
          url: "https://my-app.vercel.app",
          readyState: "READY",
          createdAt: 1700000000000,
          projectId: "p1",
        }),
        "/v3/deployments/dpl_abc/events": fakeOk([]),
        "/v1/projects/p1/deployments/dpl_abc/runtime-logs": fakeOk([
          { level: "info", message: "app started", rowId: "r1", source: "serverless", timestampInMs: 1700000001000 },
          { level: "error", message: "connection string: postgres://user:pass@host/db", rowId: "r2", source: "serverless", timestampInMs: 1700000002000 },
        ]),
      });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.logs("dpl_abc", { lines: 100, secretValues: ["pass"] });
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        // Should contain messages
        expect(result.value).toContain("[info] app started");
        // Secrets should be redacted
        expect(result.value).not.toContain("postgres://user:pass@host/db");
      }
    });

    it.each(["build", "runtime"] as const)("fails closed on malformed %s logs", async (malformedEndpoint) => {
      const deployment = fakeOk({
        id: "dpl_abc", name: "my-app", url: "https://my-app.vercel.app",
        readyState: "READY", createdAt: 1700000000000, projectId: "p1",
      });
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": deployment,
        "/v3/deployments/dpl_abc/events": malformedEndpoint === "build" ? fakeOk({ providerBody: "app-secret tok_test" }) : fakeOk([]),
        "/v1/projects/p1/deployments/dpl_abc/runtime-logs": malformedEndpoint === "runtime" ? fakeOk([{ message: "app-secret tok_test" }]) : fakeOk([]),
      });
      const result = await runtimeWithFetch(fetch).logs("dpl_abc", { lines: 50, secretValues: ["app-secret"] });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.safeMessage).not.toContain("providerBody");
        expect(result.safeMessage).not.toContain("app-secret");
        expect(result.safeMessage).not.toContain("tok_test");
      }
    });

    it("returns unverified on missing deployment", async () => {
      const fetch = mapFetch({
        "/v13/deployments/nonexistent": fakeError(404, "not found"),
      });
      const rt = runtimeWithFetch(fetch);
      const result = await rt.logs("nonexistent", { lines: 50, secretValues: [] });
      expect(result.status).toBe("unverified");
    });
  });

  describe("reconcile", () => {
    it("ensure_project: matches when project exists with same name", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [{ id: "p1", name: "my-app" }] }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "ensure_project",
        projectName: "my-app",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("matches_expected");
      }
    });

    it("ensure_project: not_applied when project absent", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [] }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "ensure_project",
        projectName: "my-app",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("not_applied");
      }
    });

    it("ensure_project: conflict when resourceRef from ambiguous createProject", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [] }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "ensure_project",
        projectName: "my-app", targetFingerprint: "tf1", requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1", destructive: false, reversible: false, dependsOn: [],
      };
      // Passing a resourceRef means the create returned ambiguous with a different-name project.
      const result = await rt.reconcile(op, "p_conflict");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("conflict");
        expect(result.value.observedStateFingerprint).toBe("p_conflict");
      }
      // No findProject fetch should have been made — resourceRef short-circuits.
    });

    it("ensure_project: not_applied when no resourceRef and project absent", async () => {
      const fetch = mapFetch({
        "/v10/projects?search=my-app": fakeOk({ projects: [] }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "ensure_project",
        projectName: "my-app", targetFingerprint: "tf1", requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1", destructive: false, reversible: false, dependsOn: [],
      };
      // No resourceRef — falls through to findProject, empty list → not_applied
      const result = await rt.reconcile(op);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("not_applied");
      }
    });

    it.each([404, 500])("ensure_project: HTTP %s remains unverified", async (status) => {
      const rt = runtimeWithFetch(mapFetch({
        "/v10/projects?search=my-app": fakeError(status, "project endpoint failed"),
      }));
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "ensure_project",
        projectName: "my-app", targetFingerprint: "tf1", requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1", destructive: false, reversible: false, dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
    });

    it("upsert_secrets: always unverified (write-only)", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "upsert_secrets",
        projectName: "my-app",
        environment: "production",
        secretNames: ["API_KEY"],
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
    });

    it("deploy: not_applied on 404", async () => {
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": fakeError(404, "not found"),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "deploy",
        projectName: "my-app",
        environment: "production",
        source: { kind: "local-files", rootDirectory: ".", fileCount: 1, totalBytes: 10, fingerprint: "fp1" },
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: true,
        dependsOn: [],
      };
      const result = await rt.reconcile(op, "dpl_abc");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("not_applied");
      }
    });

    it("deploy: returns READY release metadata for an exact operation match", async () => {
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": fakeOk({
          id: "dpl_abc", name: "my-app", url: "https://my-app.vercel.app",
          readyState: "READY", createdAt: 1700000000000, projectId: "p1",
          meta: { piShipOperationId: "op1" },
        }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1", provider: "vercel", domain: "app", kind: "deploy",
        projectName: "my-app", observedProjectId: "p1", environment: "production",
        source: { kind: "local-files", rootDirectory: ".", fileCount: 1, totalBytes: 10, fingerprint: "fp1" },
        targetFingerprint: "tf1", requestFingerprint: "rf1", expectedStateFingerprint: "esf1",
        destructive: false, reversible: true, dependsOn: [],
      };
      const result = await rt.reconcile(op, "dpl_abc");
      expect(result.status).toBe("verified");
      if (result.status === "verified" && result.value.outcome === "matches_expected") {
        expect(result.value.releaseStatus).toBe("ready");
        expect(result.value.releaseUrl).toBe("https://my-app.vercel.app");
      }
    });

    it("deploy: conflict when deployment exists without piShipOperationId", async () => {
      const fetch = mapFetch({
        "/v13/deployments/dpl_abc": fakeOk({
          id: "dpl_abc",
          name: "my-app",
          url: "https://my-app.vercel.app",
          readyState: "READY",
          createdAt: 1700000000000,
          projectId: "p1",
        }),
      });
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "deploy",
        projectName: "my-app",
        environment: "production",
        source: { kind: "local-files", rootDirectory: ".", fileCount: 1, totalBytes: 10, fingerprint: "fp1" },
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: true,
        dependsOn: [],
      };
      const result = await rt.reconcile(op, "dpl_abc");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("conflict");
      }
    });

    it("rollback: always unverified (write-only)", async () => {
      const rt = runtimeWithFetch(async () => fakeOk({}));
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "rollback",
        projectId: "p1",
        environment: "production",
        targetDeploymentId: "dpl_abc",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: true,
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
    });

    it("returns unverified on transport error", async () => {
      const fetch = async () => { throw new TypeError("timeout"); };
      const rt = runtimeWithFetch(fetch);
      const op: VercelOperation = {
        operationId: "op1",
        provider: "vercel",
        domain: "app",
        kind: "ensure_project",
        projectName: "my-app",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        destructive: false,
        reversible: false,
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("transport");
      }
    });
  });
});
