import { describe, expect, it, vi } from "vitest";
import {
  createNeonClient,
  type NeonClient,
  type NeonFetchLike,
  type CreateProjectResponse,
  type CreateBranchResponse,
  type NeonOperation,
} from "../../../src/providers/neon/client.js";

// ── Fake response helpers ─────────────────────────────────────────────────

function fakeOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeError(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Call recording helper ─────────────────────────────────────────────────

interface CallRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recordingFetch(record: CallRecord[], response: Response): NeonFetchLike {
  return async (input, init) => {
    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) hdrs[k] = h[k];
    }
    record.push({
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers: hdrs,
      body: init?.body ? String(init.body) : undefined,
    });
    return response;
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("NeonClient", () => {
  describe("checkAuth", () => {
    it("GET /users/me with bearer auth", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key_abc" },
        recordingFetch(calls, fakeOk({ id: "user-1" })),
      );
      const result = await client.checkAuth();
      expect(result.ok).toBe(true);
      expect(result.accountId).toBe("user-1");
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toContain("/users/me");
      expect(calls[0].headers["Authorization"]).toBe("Bearer key_abc");
    });

    it("returns ok: false on 401", async () => {
      const client = createNeonClient(
        { apiKey: "bad_key" },
        async () => fakeError(401, "unauthorized"),
      );
      const result = await client.checkAuth();
      expect(result.ok).toBe(false);
    });
  });

  describe("listProjects", () => {
    it("GET /projects", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ projects: [{ id: "p1", name: "app" }] })),
      );
      const result = await client.listProjects();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("p1");
    });

    it("returns empty array when no projects", async () => {
      const client = createNeonClient(
        { apiKey: "key" },
        async () => fakeOk({ projects: [] }),
      );
      const result = await client.listProjects();
      expect(result).toEqual([]);
    });
  });

  describe("getProject", () => {
    it("GET /projects/{id} returns project", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ project: { id: "p1", name: "app", platform_primary_branch: "main", pg_version: 16, region_id: "aws-us-east-1", created_at: "t", updated_at: "t" } })),
      );
      const result = await client.getProject("p1");
      expect(result.id).toBe("p1");
      expect(result.name).toBe("app");
      expect(calls[0].url).toContain("/projects/p1");
    });

    it("throws when project missing in response", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.getProject("p1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("createProject", () => {
    it("POST /projects with config", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ project: { id: "p-new", name: "new-app", platform_primary_branch: "main", pg_version: 16, region_id: "aws-us-east-1", created_at: "t", updated_at: "t" }, operations: [] })),
      );
      const result = await client.createProject({ project: { name: "new-app" } });
      expect(result.project.id).toBe("p-new");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/projects");
      expect(JSON.parse(calls[0].body!)).toEqual({ project: { name: "new-app" } });
    });

    it("throws when response missing project", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.createProject({ project: { name: "x" } })).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("listBranches", () => {
    it("GET /projects/{id}/branches", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ branches: [{ id: "b1", project_id: "p1", name: "main", created_at: "t", updated_at: "t", primary: true }] })),
      );
      const result = await client.listBranches("p1");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("b1");
      expect(calls[0].url).toContain("/projects/p1/branches");
    });

    it("returns empty array when no branches", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({ branches: [] }));
      const result = await client.listBranches("p1");
      expect(result).toEqual([]);
    });
  });

  describe("getBranch", () => {
    it("GET /projects/{id}/branches/{branchId}", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ branch: { id: "b1", project_id: "p1", name: "main", created_at: "t", updated_at: "t", primary: true } })),
      );
      const result = await client.getBranch("p1", "b1");
      expect(result.id).toBe("b1");
      expect(calls[0].url).toContain("/projects/p1/branches/b1");
    });

    it("throws when branch missing", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.getBranch("p1", "missing")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("createBranch", () => {
    it("POST /projects/{id}/branches", async () => {
      const calls: CallRecord[] = [];
      const branchResponse: CreateBranchResponse = {
        branch: { id: "b-new", project_id: "p1", name: "feature", created_at: "t", updated_at: "t", primary: false },
        endpoints: [{ id: "ep-1", project_id: "p1", branch_id: "b-new", type: "read_write", host: "host", port: 5432 }],
        operations: [],
        connection_uris: [{ connection_uri: "postgresql://user:pass@host/db", database: "neondb", role: "neondb_owner" }],
      };
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk(branchResponse)),
      );
      const result = await client.createBranch("p1", { branch: { name: "feature" }, endpoints: [{ type: "read_write" }] });
      expect(result.branch.id).toBe("b-new");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/projects/p1/branches");
      expect(JSON.parse(calls[0].body!)).toEqual({ branch: { name: "feature" }, endpoints: [{ type: "read_write" }] });
    });

    it("throws when response missing branch", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.createBranch("p1", { branch: { name: "x" } })).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("getConnectionUri", () => {
    it("GET /projects/{id}/connection_uri", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ connection_uri: "postgresql://user:pass@host/db" })),
      );
      const result = await client.getConnectionUri("p1", undefined, "neondb", "neondb_owner");
      expect(result).toBe("postgresql://user:pass@host/db");
      expect(calls[0].url).toContain("/projects/p1/connection_uri");
      expect(calls[0].url).toContain("database_name=neondb");
      expect(calls[0].url).toContain("role_name=neondb_owner");
    });

    it("throws when connection_uri missing", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.getConnectionUri("p1", undefined, "db", "role")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("listDatabases", () => {
    it("GET /projects/{id}/branches/{branchId}/databases", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ databases: [{ id: "db-1", branch_id: "b1", name: "neondb", owner_name: "neondb_owner", created_at: "t", updated_at: "t" }] })),
      );
      const result = await client.listDatabases("p1", "b1");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("neondb");
      expect(calls[0].url).toContain("/projects/p1/branches/b1/databases");
    });

    it("returns empty array", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({ databases: [] }));
      const result = await client.listDatabases("p1", "b1");
      expect(result).toEqual([]);
    });
  });

  describe("getOperation", () => {
    it("GET /projects/{id}/operations/{opId}", async () => {
      const calls: CallRecord[] = [];
      const op: NeonOperation = { id: "op-1", project_id: "p1", action: "create_branch", status: "finished", created_at: "t", updated_at: "t" };
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk(op)),
      );
      const result = await client.getOperation("p1", "op-1");
      expect(result.id).toBe("op-1");
      expect(result.status).toBe("finished");
      expect(calls[0].url).toContain("/projects/p1/operations/op-1");
    });

    it("throws when op missing id", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.getOperation("p1", "bad")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("restoreBranch", () => {
    it("POST /projects/{id}/branches/{branchId}/restore", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key" },
        recordingFetch(calls, fakeOk({ operations: [{ id: "op-1", project_id: "p1", action: "restore", status: "running", created_at: "t", updated_at: "t" }] })),
      );
      const result = await client.restoreBranch("p1", "b1", { source_branch_id: "b2" });
      expect(result.operations).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/projects/p1/branches/b1/restore");
    });

    it("throws when response missing operations", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeOk({}));
      await expect(client.restoreBranch("p1", "b1", {})).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("custom baseUrl", () => {
    it("uses custom base URL", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key", baseUrl: "https://custom.neon.tech/api/v2" },
        recordingFetch(calls, fakeOk({ id: "user-1" })),
      );
      await client.checkAuth();
      expect(calls[0].url).toMatch(/^https:\/\/custom\.neon\.tech\/api\/v2\/users\/me/);
    });
  });

  describe("error handling", () => {
    it("401 maps to E_AUTH_MISSING", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeError(401, "unauthorized"));
      await expect(client.listProjects()).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    });

    it("403 maps to E_AUTH_MISSING", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeError(403, "forbidden"));
      await expect(client.listProjects()).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    });

    it("404 maps to E_PROVIDER", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeError(404, "not found"));
      await expect(client.getProject("nonexistent")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("409 maps to E_PROVIDER", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeError(409, "conflict"));
      await expect(client.createProject({ project: { name: "x" } })).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("429 maps to E_PROVIDER retryable", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeError(429, "rate limited"));
      await expect(client.listProjects()).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
    });

    it("500 maps to E_PROVIDER retryable", async () => {
      const client = createNeonClient({ apiKey: "key" }, async () => fakeError(500, "server error"));
      await expect(client.listProjects()).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
    });
  });

  describe("cursor-based pagination", () => {
    it("follows cursor until undefined", async () => {
      let callCount = 0;
      const fetchImpl: NeonFetchLike = async (url) => {
        callCount++;
        if (callCount === 1) {
          return fakeOk({ projects: [{ id: "p1", name: "a" }], cursor: "next-page" });
        }
        return fakeOk({ projects: [{ id: "p2", name: "b" }] });
      };
      const client = createNeonClient({ apiKey: "key" }, fetchImpl);
      const result = await client.listProjects();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("p1");
      expect(result[1].id).toBe("p2");
      expect(callCount).toBe(2);
    });

    it("stops when cursor is undefined", async () => {
      const fetchImpl: NeonFetchLike = async () => fakeOk({ projects: [{ id: "p1", name: "a" }] });
      const client = createNeonClient({ apiKey: "key" }, fetchImpl);
      const result = await client.listProjects();
      expect(result).toHaveLength(1);
    });
  });

  describe("async operation polling", () => {
    it("polls until finished", async () => {
      let pollCount = 0;
      const fetchImpl: NeonFetchLike = async (url) => {
        if (url.includes("/operations/")) {
          pollCount++;
          const status = pollCount >= 3 ? "finished" : "running";
          return fakeOk({ id: "op-1", project_id: "p1", action: "create", status, created_at: "t", updated_at: "t" } as NeonOperation);
        }
        return fakeOk({ id: "user-1" });
      };
      const client = createNeonClient({ apiKey: "key", pollIntervalMs: 1 }, fetchImpl);
      const result = await client.pollOperation("p1", "op-1", 5000);
      expect(result.status).toBe("finished");
      expect(pollCount).toBeGreaterThanOrEqual(3);
    });

    it("throws on failed operation", async () => {
      const fetchImpl: NeonFetchLike = async (url) => {
        if (url.includes("/operations/")) {
          return fakeOk({ id: "op-1", project_id: "p1", action: "create", status: "failed", error: { code: "ERR", message: "operation failed" }, created_at: "t", updated_at: "t" } as NeonOperation);
        }
        return fakeOk({});
      };
      const client = createNeonClient({ apiKey: "key", pollIntervalMs: 1 }, fetchImpl);
      await expect(client.pollOperation("p1", "op-1", 100)).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("throws on cancelled operation", async () => {
      const fetchImpl: NeonFetchLike = async (url) => {
        if (url.includes("/operations/")) {
          return fakeOk({ id: "op-1", project_id: "p1", action: "create", status: "cancelled", created_at: "t", updated_at: "t" } as NeonOperation);
        }
        return fakeOk({});
      };
      const client = createNeonClient({ apiKey: "key", pollIntervalMs: 1 }, fetchImpl);
      await expect(client.pollOperation("p1", "op-1", 100)).rejects.toMatchObject({ code: "E_CANCELLED" });
    });

    it("throws on timeout", async () => {
      const fetchImpl: NeonFetchLike = async (url) => {
        if (url.includes("/operations/")) {
          return fakeOk({ id: "op-1", project_id: "p1", action: "create", status: "running", created_at: "t", updated_at: "t" } as NeonOperation);
        }
        return fakeOk({});
      };
      const client = createNeonClient({ apiKey: "key", pollIntervalMs: 5 }, fetchImpl);
      await expect(client.pollOperation("p1", "op-1", 20)).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
    });
  });

  describe("redaction", () => {
    it("redacts API key from error messages", async () => {
      const client = createNeonClient(
        { apiKey: "super-secret-key-12345" },
        async () => fakeError(401, "invalid key super-secret-key-12345"),
      );
      try {
        await client.listProjects();
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).not.toContain("super-secret-key-12345");
      }
    });

    it("does not include API key in URL", async () => {
      const calls: CallRecord[] = [];
      const client = createNeonClient(
        { apiKey: "key_very_secret" },
        recordingFetch(calls, fakeOk({ id: "user-1" })),
      );
      await client.checkAuth();
      expect(calls[0].url).not.toContain("key_very_secret");
      expect(calls[0].url).not.toContain("apiKey");
    });
  });

  describe("AbortSignal", () => {
    it("passes signal to fetch", async () => {
      let passedSignal: AbortSignal | undefined;
      const fetchImpl: NeonFetchLike = async (_input, init) => {
        passedSignal = init?.signal ?? undefined;
        return fakeOk({ id: "user-1" });
      };
      const client = createNeonClient({ apiKey: "key" }, fetchImpl);
      const controller = new AbortController();
      await client.checkAuth(controller.signal);
      expect(passedSignal).toBe(controller.signal);
    });
  });
});
