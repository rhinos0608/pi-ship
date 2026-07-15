import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createVercelClient, type VercelFetchLike } from "../../../src/providers/vercel/client.js";
import type { BackoffFn } from "../../../src/providers/vercel/types.js";

// ── Test helpers ────────────────────────────────────────────────────────────────

function fakeOk(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fakeEmpty(status = 201): Response {
  return new Response(null, { status });
}

function fakeText(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function fakeError(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface CallRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recordingFetch(record: CallRecord[], response: Response): VercelFetchLike {
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

function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("VercelClient", () => {
  describe("checkAuth", () => {
    it("GET /v2/user with bearer auth", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok_abc" },
        recordingFetch(calls, fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }))
      );
      const result = await client.checkAuth();
      expect(result.user.id).toBe("u1");
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toBe("https://api.vercel.com/v2/user");
      expect(calls[0].headers["Authorization"]).toBe("Bearer tok_abc");
    });

    it("appends teamId when configured", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok", teamId: "team_x" },
        recordingFetch(calls, fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: "team_x" } }))
      );
      await client.checkAuth();
      const url = new URL(calls[0].url);
      expect(url.searchParams.get("teamId")).toBe("team_x");
    });

    it("validates required user fields", async () => {
      // Missing 'id' field
      const fetch = async () => fakeOk({ user: { email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } });
      const client = createVercelClient({ token: "tok" }, fetch);
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: false,
      });
    });

    it("tolerates extra response fields", async () => {
      const fetch = async () =>
        fakeOk({
          user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null, extraField: "ignored" },
        });
      const client = createVercelClient({ token: "tok" }, fetch);
      await expect(client.checkAuth()).resolves.toMatchObject({ user: { id: "u1" } });
    });
  });

  describe("listProjects", () => {
    it("GET /v10/projects with optional search query", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ projects: [{ id: "p1", name: "my-app" }] }))
      );
      const result = await client.listProjects("my-app");
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].id).toBe("p1");
      expect(calls[0].url).toContain("search=my-app");
    });

    it("list all projects when search omitted", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ projects: [] }))
      );
      const result = await client.listProjects();
      expect(result.projects).toEqual([]);
      expect(calls[0].url).not.toContain("search");
    });

    it("validates pagination field is optional", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk({ projects: [] })
      );
      await expect(client.listProjects()).resolves.toMatchObject({ projects: [] });
    });

    it("accepts direct array and normalizes to wrapper", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ id: "p1", name: "my-app" }])
      );
      const result = await client.listProjects();
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].id).toBe("p1");
      expect(result.pagination).toBeUndefined();
    });
  });

  describe("findProject", () => {
    it("returns exact match from list response", async () => {
      const fetch = async () =>
        fakeOk({
          projects: [
            { id: "p1", name: "my-app" },
            { id: "p2", name: "other" },
          ],
        });
      const client = createVercelClient({ token: "tok" }, fetch);
      const result = await client.findProject("my-app");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("p1");
    });

    it("returns null when not found", async () => {
      const fetch = async () => fakeOk({ projects: [] });
      const client = createVercelClient({ token: "tok" }, fetch);
      const result = await client.findProject("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createProject", () => {
    it("POST /v11/projects with JSON body", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ id: "p1", name: "new-project" }))
      );
      const result = await client.createProject({ name: "new-project" });
      expect(result.id).toBe("p1");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/v11/projects");
      expect(calls[0].headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(calls[0].body!)).toEqual({ name: "new-project" });
    });
  });

  describe("upsertEnv", () => {
    it("POST /v10/projects/{id}/env with upsert=true", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ created: { id: "e1" }, failed: [] }, 201))
      );
      const envInput = { key: "MY_SECRET", value: "s3cret", type: "sensitive" as const, target: ["production"] as ["production"] };
      const result = await client.upsertEnv("p1", envInput);
      expect(result.created).toBeDefined();
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/v10/projects/p1/env");
      expect(calls[0].url).toContain("upsert=true");
      expect(JSON.parse(calls[0].body!)).toMatchObject({ key: "MY_SECRET", type: "sensitive" });
    });

    it("encodes project ID in path", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ created: {} }, 201))
      );
      await client.upsertEnv("project/name", { key: "K", value: "v", type: "sensitive", target: ["preview"] });
      expect(calls[0].url).toContain("/v10/projects/project%2Fname/env");
    });

    it("redacts env.value from error messages", async () => {
      const secretValue = "super-secret-value-xyz789";
      const fetch = async () =>
        new Response(
          JSON.stringify({ error: { message: `bad request for value '${secretValue}'` } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      const client = createVercelClient({ token: "tok" }, fetch);
      try {
        await client.upsertEnv("p1", { key: "K", value: secretValue, type: "sensitive", target: ["production"] });
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).not.toContain(secretValue);
        expect(e.message).toContain("***");
      }
    });
  });

  describe("uploadFile", () => {
    it("POST /v2/files with SHA1 digest and Content-Length", async () => {
      const calls: CallRecord[] = [];
      const content = new Uint8Array([1, 2, 3, 4]);
      const digest = sha1Hex(content);
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ urls: ["https://vercel.com/file"] }))
      );
      const result = await client.uploadFile(digest, content);
      expect(result.urls).toEqual(["https://vercel.com/file"]);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/v2/files");
      expect(calls[0].headers["x-vercel-digest"]).toBe(digest);
      expect(calls[0].headers["Content-Length"]).toBe("4");
      expect(calls[0].headers["Content-Type"]).toBe("application/octet-stream");
    });

    it("accepts empty response body", async () => {
      const content = new Uint8Array([1]);
      const digest = sha1Hex(content);
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk({})
      );
      const result = await client.uploadFile(digest, content);
      expect(result.urls).toBeUndefined();
    });

    it("rejects empty content", async () => {
      const client = createVercelClient({ token: "tok" });
      await expect(client.uploadFile(sha1Hex(new Uint8Array(0)), new Uint8Array(0)))
        .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });

    it("rejects malformed sha1 (non-hex)", async () => {
      const client = createVercelClient({ token: "tok" });
      await expect(client.uploadFile("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", new Uint8Array([1])))
        .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });

    it("rejects sha1 mismatch with content", async () => {
      const client = createVercelClient({ token: "tok" });
      await expect(client.uploadFile("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new Uint8Array([1, 2, 3])))
        .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });

    it("rejects uppercase sha1", async () => {
      const client = createVercelClient({ token: "tok" });
      await expect(client.uploadFile("ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", new Uint8Array([1])))
        .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });

    it("rejects short sha1", async () => {
      const client = createVercelClient({ token: "tok" });
      await expect(client.uploadFile("abc123", new Uint8Array([1])))
        .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });

    it("computes SHA1 of content correctly", async () => {
      const calls: CallRecord[] = [];
      const content = new TextEncoder().encode("hello world");
      const digest = sha1Hex(content);
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({}))
      );
      await client.uploadFile(digest, content);
      expect(calls[0].headers["x-vercel-digest"]).toBe(digest);
    });
  });

  describe("createDeployment", () => {
    it("POST /v13/deployments with JSON body", async () => {
      const calls: CallRecord[] = [];
      const deployBody = { name: "my-app" };
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(
          calls,
          fakeOk({
            id: "dpl_1",
            name: "my-app",
            url: "https://my-app.vercel.app",
            readyState: "QUEUED",
            createdAt: Date.now(),
            projectId: "p1",
          })
        )
      );
      const result = await client.createDeployment(deployBody);
      expect(result.id).toBe("dpl_1");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/v13/deployments");
      expect(JSON.parse(calls[0].body!)).toEqual(deployBody);
    });
  });

  describe("getDeployment", () => {
    it("GET /v13/deployments/{id}", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(
          calls,
          fakeOk({
            id: "dpl_1",
            name: "my-app",
            url: "https://my-app.vercel.app",
            readyState: "READY",
            createdAt: Date.now(),
            projectId: "p1",
          })
        )
      );
      const result = await client.getDeployment("dpl_1");
      expect(result.id).toBe("dpl_1");
      expect(result.url).toBe("https://my-app.vercel.app");
      expect(calls[0].url).toContain("/v13/deployments/dpl_1");
    });

    it("encodes id in path", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk({ id: "x", name: "a", url: "https://a", readyState: "READY", createdAt: 0, projectId: "p" }))
      );
      await client.getDeployment("dpl/id");
      expect(calls[0].url).toContain("/v13/deployments/dpl%2Fid");
    });
  });

  describe("getBuildEvents", () => {
    it("GET /v3/deployments/{idOrUrl}/events returns validated array", async () => {
      const calls: CallRecord[] = [];
      const events = [{ type: "command", created: 100, payload: { text: "build" } }];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk(events))
      );
      const result = await client.getBuildEvents("dpl_1");
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("command");
      expect(result[0].created).toBe(100);
      expect(result[0].payload).toBeDefined();
      expect(calls[0].url).toContain("/v3/deployments/dpl_1/events");
    });

    it("throws when response is not an array", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk({ not: "an array" })
      );
      await expect(client.getBuildEvents("dpl_1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects build event with invalid type", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ type: "invalid_type", created: 100, payload: {} }])
      );
      await expect(client.getBuildEvents("dpl_1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects build event missing required created", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ type: "command", payload: {} }]) // missing created
      );
      await expect(client.getBuildEvents("dpl_1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects build event missing required payload", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ type: "command", created: 100 }]) // missing payload
      );
      await expect(client.getBuildEvents("dpl_1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("accepts payload with extra fields", async () => {
      const events = [{ type: "stderr", created: 200, payload: { text: "error", extraField: "ok" } }];
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk(events)
      );
      const result = await client.getBuildEvents("dpl_1");
      expect(result[0].payload.text).toBe("error");
    });
  });

  describe("getRuntimeLogs", () => {
    const validLog = { level: "info" as const, message: "started", rowId: "r1", source: "serverless" as const, timestampInMs: 1000 };

    it("GET /v1/projects/{pid}/deployments/{did}/runtime-logs (JSON array)", async () => {
      const calls: CallRecord[] = [];
      const logs = [validLog];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeOk(logs))
      );
      const result = await client.getRuntimeLogs("p1", "d1");
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe("info");
      expect(calls[0].url).toContain("/v1/projects/p1/deployments/d1/runtime-logs");
    });

    it("parses newline-delimited JSON stream", async () => {
      const stream =
        '{"level":"info","message":"line1","rowId":"r1","source":"serverless","timestampInMs":1000}\n{"level":"error","message":"line2","rowId":"r2","source":"edge-function","timestampInMs":2000}\n';
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeText(stream)
      );
      const result = await client.getRuntimeLogs("p1", "d1");
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("line1");
      expect(result[1].level).toBe("error");
    });

    it("handles empty text response", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeText("")
      );
      const result = await client.getRuntimeLogs("p1", "d1");
      expect(result).toEqual([]);
    });

    it("rejects malformed NDJSON line", async () => {
      const stream = '{"level":"info","message":"ok","rowId":"r1","source":"serverless","timestampInMs":1000}\nnot-json-line\n';
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeText(stream)
      );
      await expect(client.getRuntimeLogs("p1", "d1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects runtime log with invalid level", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ level: "invalid_level", message: "x", rowId: "r1", source: "serverless", timestampInMs: 1 }])
      );
      await expect(client.getRuntimeLogs("p1", "d1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects runtime log with invalid source", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ level: "info", message: "x", rowId: "r1", source: "invalid_source", timestampInMs: 1 }])
      );
      await expect(client.getRuntimeLogs("p1", "d1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects runtime log missing required level", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ message: "x", rowId: "r1", source: "serverless", timestampInMs: 1 }])
      );
      await expect(client.getRuntimeLogs("p1", "d1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("rejects runtime log missing required message", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk([{ level: "info", rowId: "r1", source: "serverless", timestampInMs: 1 }])
      );
      await expect(client.getRuntimeLogs("p1", "d1")).rejects.toMatchObject({ code: "E_PROVIDER" });
    });

    it("accepts runtime log with extra fields", async () => {
      const logs = [{ ...validLog, domain: "example.com", extraField: "ignored" }];
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk(logs)
      );
      const result = await client.getRuntimeLogs("p1", "d1");
      expect(result[0].level).toBe("info");
    });
  });

  describe("cancelDeployment", () => {
    it("PATCH /v12/deployments/{id}/cancel", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(
          calls,
          fakeOk({
            id: "dpl_1",
            name: "my-app",
            url: "https://my-app.vercel.app",
            readyState: "CANCELED",
            createdAt: Date.now(),
            projectId: "p1",
          })
        )
      );
      const result = await client.cancelDeployment("dpl_1");
      expect(result.readyState).toBe("CANCELED");
      expect(calls[0].method).toBe("PATCH");
      expect(calls[0].url).toContain("/v12/deployments/dpl_1/cancel");
    });
  });

  describe("rollback", () => {
    it("POST /v1/projects/{pid}/rollback/{did} (empty 201)", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeEmpty(201))
      );
      await expect(client.rollback("p1", "d1")).resolves.toBeUndefined();
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/v1/projects/p1/rollback/d1");
    });

    it("accepts object body without trusting content", async () => {
      const client = createVercelClient(
        { token: "tok" },
        async () => fakeOk({ deployment: { id: "d1" } }, 201)
      );
      await expect(client.rollback("p1", "d1")).resolves.toBeUndefined();
    });

    it("appends description query", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, fakeEmpty(201))
      );
      await client.rollback("p1", "d1", "fix rollback");
      const url = new URL(calls[0].url);
      expect(url.searchParams.get("description")).toBe("fix rollback");
    });
  });

  // ── Team scoping ──────────────────────────────────────────────────────────────

  describe("team scoping", () => {
    it.each([
      ["checkAuth", (c: ReturnType<typeof createVercelClient>) => c.checkAuth(), fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } })],
      ["listProjects", (c: ReturnType<typeof createVercelClient>) => c.listProjects(), fakeOk({ projects: [] })],
      ["createProject", (c: ReturnType<typeof createVercelClient>) => c.createProject({ name: "x" }), fakeOk({ id: "p1", name: "x" })],
      ["uploadFile", (c: ReturnType<typeof createVercelClient>) => c.uploadFile(sha1Hex(new Uint8Array([1])), new Uint8Array([1])), fakeOk({})],
    ])("%s appends teamId to URL", async (_name, action, response) => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok", teamId: "team_1" },
        recordingFetch(calls, response)
      );
      await action(client);
      const url = new URL(calls[0].url);
      expect(url.searchParams.get("teamId")).toBe("team_1");
    });
  });

  // ── Error mapping ─────────────────────────────────────────────────────────────

  describe("error mapping", () => {
    it("401 maps to E_AUTH_MISSING non-retryable", async () => {
      const client = createVercelClient({ token: "tok" }, async () => fakeError(401, "unauthorized"));
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_AUTH_MISSING",
        retryable: false,
      });
    });

    it("403 maps to E_AUTH_MISSING non-retryable", async () => {
      const client = createVercelClient({ token: "tok" }, async () => fakeError(403, "forbidden"));
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_AUTH_MISSING",
        retryable: false,
      });
    });

    it("404 maps to E_PROVIDER non-retryable", async () => {
      const client = createVercelClient({ token: "tok" }, async () => fakeError(404, "not found"));
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: false,
      });
    });

    it("409 maps to E_PROVIDER non-retryable", async () => {
      const client = createVercelClient({ token: "tok" }, async () => fakeError(409, "conflict"));
      await expect(client.getDeployment("x")).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: false,
      });
    });

    it("429 maps to E_PROVIDER retryable (no retry)", async () => {
      const client = createVercelClient({ token: "tok", maxRetries: 0 }, async () => fakeError(429, "rate limited"));
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: true,
      });
    });

    it("500 maps to E_PROVIDER retryable (no retry)", async () => {
      const client = createVercelClient({ token: "tok", maxRetries: 0 }, async () => fakeError(500, "server error"));
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: true,
      });
    });
  });

  // ── Malformed response ────────────────────────────────────────────────────────

  describe("malformed response", () => {
    it("non-JSON body with JSON content-type throws E_PROVIDER", async () => {
      const fetch = async () =>
        new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } });
      const client = createVercelClient({ token: "tok" }, fetch);
      await expect(client.checkAuth()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: false,
      });
    });

    it("transport error on safe operation retries", async () => {
      let attempts = 0;
      const fetch = async () => {
        attempts++;
        throw new TypeError("fetch failed");
      };
      const client = createVercelClient(
        { token: "tok", maxRetries: 2, backoff: () => 1 },
        fetch
      );
      await expect(client.checkAuth()).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
      // 1 initial + 2 retries = 3 total
      expect(attempts).toBe(3);
    });
  });

  // ── Retry behavior ────────────────────────────────────────────────────────────

  describe("retry", () => {
    it("retries 429 up to maxRetries for safe ops, then fails", async () => {
      let attempt = 0;
      const fetch = async () => {
        attempt++;
        return fakeError(429, "rate limit");
      };
      const backoff: BackoffFn = () => 1;
      const client = createVercelClient(
        { token: "tok", maxRetries: 2, backoff },
        fetch
      );
      await expect(client.checkAuth()).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
      expect(attempt).toBe(3); // 1 initial + 2 retries
    });

    it("retries 500 up to maxRetries for safe ops", async () => {
      let attempt = 0;
      const fetch = async () => {
        attempt++;
        return fakeError(500, "server error");
      };
      const client = createVercelClient(
        { token: "tok", maxRetries: 1, backoff: () => 1 },
        fetch
      );
      await expect(client.checkAuth()).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
      expect(attempt).toBe(2);
    });

    it("does NOT retry 429 for unsafe (mutation) ops", async () => {
      let attempt = 0;
      const fetch = async () => {
        attempt++;
        return fakeError(429, "rate limit");
      };
      const client = createVercelClient({ token: "tok" }, fetch);
      await expect(client.createProject({ name: "x" })).rejects.toThrow();
      expect(attempt).toBe(1);
    });

    it("uses Retry-After header when present", async () => {
      let attempt = 0;
      const backoffCalls: Array<{ attempt: number; retryAfter: number | null }> = [];
      const backoff: BackoffFn = (a, ra) => {
        backoffCalls.push({ attempt: a, retryAfter: ra ?? null });
        return 1;
      };
      const fetch = async () => {
        attempt++;
        if (attempt === 1) {
          return fakeError(429, "rate limit", { "Retry-After": "3" });
        }
        return fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } });
      };
      const client = createVercelClient({ token: "tok", maxRetries: 1, backoff }, fetch);
      await client.checkAuth();
      expect(attempt).toBe(2);
      expect(backoffCalls[0].retryAfter).toBe(3);
    });
  });

  // ── AbortSignal ───────────────────────────────────────────────────────────────

  describe("AbortSignal", () => {
    it("passes signal to fetch", async () => {
      let passedSignal: AbortSignal | undefined;
      const fetch = async (_input: string, init?: RequestInit) => {
        passedSignal = init?.signal ?? undefined;
        return fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } });
      };
      const client = createVercelClient({ token: "tok" }, fetch);
      const controller = new AbortController();
      await client.checkAuth(controller.signal);
      expect(passedSignal).toBe(controller.signal);
    });
  });

  // ── Token non-leak ────────────────────────────────────────────────────────────

  describe("token non-leak", () => {
    it("does not include token in URL", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "super-secret-token-12345" },
        recordingFetch(calls, fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }))
      );
      await client.checkAuth();
      expect(calls[0].url).not.toContain("super-secret");
      expect(calls[0].url).not.toContain("token");
    });

    it("redacts token from error messages", async () => {
      const fetch = async () =>
        new Response(
          JSON.stringify({ error: { message: "token super-secret-token-12345 is invalid" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      const client = createVercelClient({ token: "super-secret-token-12345" }, fetch);
      try {
        await client.checkAuth();
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).not.toContain("super-secret-token-12345");
        expect(e.message).toContain("***");
      }
    });

    it("redacts token from retry error messages", async () => {
      let attempt = 0;
      const backoff: BackoffFn = () => 1;
      const fetch429 = async () => {
        attempt++;
        return new Response(
          JSON.stringify({ error: { message: "rate limited for tok_abc123" } }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      };
      const client = createVercelClient({ token: "tok_abc123", maxRetries: 2, backoff }, fetch429);
      try {
        await client.checkAuth();
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).not.toContain("tok_abc123");
      }
    });
  });

  // ── Custom baseUrl ────────────────────────────────────────────────────────────

  describe("custom baseUrl", () => {
    it("uses custom base URL", async () => {
      const calls: CallRecord[] = [];
      const client = createVercelClient(
        { token: "tok", baseUrl: "https://custom.vercel.com" },
        recordingFetch(calls, fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } }))
      );
      await client.checkAuth();
      expect(calls[0].url).toMatch(/^https:\/\/custom\.vercel\.com\/v2\/user/);
    });
  });

  // ── Config validation ─────────────────────────────────────────────────────────

  describe("config validation", () => {
    function assertCode(fn: () => void, code: string): void {
      try {
        fn();
        expect.unreachable();
      } catch (e: any) {
        expect(e.code).toBe(code);
      }
    }

    it("rejects empty token", () => {
      assertCode(() => createVercelClient({ token: "" }), "E_CONFIG_INVALID");
    });

    it("rejects empty teamId", () => {
      assertCode(() => createVercelClient({ token: "tok", teamId: "" }), "E_CONFIG_INVALID");
    });

    it("rejects negative maxRetries", () => {
      assertCode(() => createVercelClient({ token: "tok", maxRetries: -1 }), "E_CONFIG_INVALID");
    });

    it("rejects non-integer maxRetries", () => {
      assertCode(() => createVercelClient({ token: "tok", maxRetries: 1.5 }), "E_CONFIG_INVALID");
    });

    it("accepts zero maxRetries", () => {
      const client = createVercelClient({ token: "tok", maxRetries: 0 });
      expect(client).toBeDefined();
    });

    it("accepts valid teamId", () => {
      const client = createVercelClient({ token: "tok", teamId: "team_x" });
      expect(client).toBeDefined();
    });

    it("accepts undefined maxRetries (defaults to 3)", () => {
      const client = createVercelClient({ token: "tok" });
      expect(client).toBeDefined();
    });
  });

  // ── Endpoint version correctness ──────────────────────────────────────────────

  describe("endpoint versions", () => {
    it.each([
      ["checkAuth", "/v2/user", (c: ReturnType<typeof createVercelClient>) => c.checkAuth()],
      ["listProjects", "/v10/projects", (c: ReturnType<typeof createVercelClient>) => c.listProjects()],
      ["createProject", "/v11/projects", (c: ReturnType<typeof createVercelClient>) => c.createProject({ name: "x" })],
      ["uploadFile", "/v2/files", (c: ReturnType<typeof createVercelClient>) => c.uploadFile(sha1Hex(new Uint8Array([1])), new Uint8Array([1]))],
      ["createDeployment", "/v13/deployments", (c: ReturnType<typeof createVercelClient>) => c.createDeployment({ name: "x" })],
      ["getDeployment", "/v13/deployments", (c: ReturnType<typeof createVercelClient>) => c.getDeployment("d1")],
      ["getBuildEvents", "/v3/deployments", (c: ReturnType<typeof createVercelClient>) => c.getBuildEvents("d1")],
      ["cancelDeployment", "/v12/deployments", (c: ReturnType<typeof createVercelClient>) => c.cancelDeployment("d1")],
      ["rollback", "/v1/projects", (c: ReturnType<typeof createVercelClient>) => c.rollback("p1", "d1")],
    ])("%s hits %s", async (_name, expectedPath, action) => {
      const calls: CallRecord[] = [];
      let response: Response;
      switch (_name) {
        case "checkAuth":
          response = fakeOk({ user: { id: "u1", email: "a@b.com", name: null, username: "a", avatar: null, defaultTeamId: null } });
          break;
        case "createProject":
          response = fakeOk({ id: "p1", name: "x" });
          break;
        case "listProjects":
          response = fakeOk({ projects: [] });
          break;
        case "uploadFile":
          response = fakeOk({});
          break;
        case "getDeployment":
        case "createDeployment":
        case "cancelDeployment":
          response = fakeOk({ id: "d1", name: "x", url: "https://x", readyState: "READY", createdAt: 0, projectId: "p1" });
          break;
        case "rollback":
          response = fakeEmpty(201);
          break;
        case "getBuildEvents":
          response = fakeOk([{ type: "command", created: 1, payload: {} }]);
          break;
        default:
          response = fakeOk({});
      }
      const client = createVercelClient(
        { token: "tok" },
        recordingFetch(calls, response)
      );
      await action(client);
      expect(calls[0].url).toContain(expectedPath);
    });
  });
});
