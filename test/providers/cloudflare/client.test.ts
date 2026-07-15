import { describe, expect, it } from "vitest";
import { createCloudflareClient } from "../../../src/providers/cloudflare/client.js";

// ── Test helpers ────────────────────────────────────────────────────────────────

function fakeOk<T>(body: T, status = 200, headers?: Record<string, string>): Response {
  const wrapper = { success: true, errors: [], result: body };
  return new Response(JSON.stringify(wrapper), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fakeError(status: number, code: number, message: string): Response {
  const wrapper = { success: false, errors: [{ code, message }], result: null };
  return new Response(JSON.stringify(wrapper), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeCloudflareSuccess<T>(body: T): Response {
  return fakeOk(body);
}

interface CallRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recordingFetch(record: CallRecord[], response: Response) {
  return async (input: string, init?: RequestInit) => {
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

function basicConfig() {
  return { apiToken: "tok_abc", accountId: "acc_123" };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("CloudflareClient", () => {
  describe("checkAuth", () => {
    it("GET /user/tokens/verify with bearer auth", async () => {
      const calls: CallRecord[] = [];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk({ ok: true }, 200))
      );
      const result = await client.checkAuth();
      expect(result.ok).toBe(true);
      expect(result.accountId).toBe("acc_123");
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toContain("/user/tokens/verify");
      expect(calls[0].headers["Authorization"]).toBe("Bearer tok_abc");
    });
  });

  describe("listWorkers", () => {
    it("GET /accounts/{id}/workers/scripts", async () => {
      const calls: CallRecord[] = [];
      const scripts = [
        { id: "s1", etag: "e1", handlers: ["fetch"], created_on: "2024-01-01", modified_on: "2024-01-01" },
      ];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(scripts))
      );
      const result = await client.listWorkers();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("s1");
      expect(calls[0].url).toContain("/accounts/acc_123/workers/scripts");
    });
  });

  describe("getWorker", () => {
    it("returns script when found", async () => {
      const script = { id: "s1", etag: "e1", handlers: ["fetch"], created_on: "2024-01-01", modified_on: "2024-01-01" };
      const client = createCloudflareClient(basicConfig(), async () => fakeOk(script));
      const result = await client.getWorker("my-worker");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("s1");
    });

    it("returns null on 404", async () => {
      const client = createCloudflareClient(basicConfig(), async () => fakeError(404, 10007, "not found"));
      const result = await client.getWorker("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("uploadWorker", () => {
    it("PUT with multipart form-data", async () => {
      const calls: CallRecord[] = [];
      const script = { id: "s1", etag: "e1", handlers: ["fetch"], created_on: "2024-01-01", modified_on: "2024-01-01" };
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(script))
      );
      const result = await client.uploadWorker("my-worker", { compatibility_date: "2024-01-01", main_module: "main.js" }, "export default {}");
      expect(result.id).toBe("s1");
      expect(calls[0].method).toBe("PUT");
      expect(calls[0].url).toContain("/accounts/acc_123/workers/scripts/my-worker");
      expect(calls[0].headers["Content-Type"]).toContain("multipart/form-data");
      expect(calls[0].body).toContain('name="main.js"');
      expect(calls[0].body).toContain('"main_module":"main.js"');
      expect(calls[0].body).toContain("export default {}");
    });
  });

  describe("uploadVersion", () => {
    it("POST with multipart form-data", async () => {
      const calls: CallRecord[] = [];
      const version = { id: "v1", number: 1, metadata: { author_email: "test@test.com" } };
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(version))
      );
      const result = await client.uploadVersion("my-worker", { compatibility_date: "2024-01-01" }, "export default {}");
      expect(result.id).toBe("v1");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/accounts/acc_123/workers/scripts/my-worker/versions");
      expect(calls[0].headers["Content-Type"]).toContain("multipart/form-data");
    });
  });

  describe("listVersions", () => {
    it("GET /accounts/{id}/workers/scripts/{name}/versions", async () => {
      const calls: CallRecord[] = [];
      const versions = [{ id: "v1", number: 1, metadata: {} }];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(versions))
      );
      const result = await client.listVersions("my-worker");
      expect(result).toHaveLength(1);
      expect(calls[0].url).toContain("/accounts/acc_123/workers/scripts/my-worker/versions");
    });
  });

  describe("getVersion", () => {
    it("GET version by id", async () => {
      const calls: CallRecord[] = [];
      const version = { id: "v1", number: 1, metadata: {} };
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(version))
      );
      const result = await client.getVersion("my-worker", "v1");
      expect(result.id).toBe("v1");
      expect(calls[0].url).toContain("/versions/v1");
    });
  });

  describe("listDeployments", () => {
    it("GET /accounts/{id}/workers/scripts/{name}/deployments", async () => {
      const calls: CallRecord[] = [];
      const deployments = [{ id: "d1", created_on: "2024-01-01" }];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(deployments))
      );
      const result = await client.listDeployments("my-worker");
      expect(result).toHaveLength(1);
      expect(calls[0].url).toContain("/accounts/acc_123/workers/scripts/my-worker/deployments");
    });
  });

  describe("createDeployment", () => {
    it("POST with version refs", async () => {
      const calls: CallRecord[] = [];
      const deployment = { id: "d1", created_on: "2024-01-01" };
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(deployment))
      );
      const result = await client.createDeployment("my-worker", [{ version_id: "v1", percentage: 100 }]);
      expect(result.id).toBe("d1");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toContain("/deployments");
      const body = JSON.parse(calls[0].body!);
      expect(body.versions).toHaveLength(1);
      expect(body.versions[0].version_id).toBe("v1");
    });

    it("passes force flag when set", async () => {
      const calls: CallRecord[] = [];
      const deployment = { id: "d1", created_on: "2024-01-01" };
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(deployment))
      );
      await client.createDeployment("my-worker", [{ version_id: "v1", percentage: 100 }], true);
      expect(calls[0].url).toContain("?force=true");
      const body = JSON.parse(calls[0].body!);
      expect(body.strategy).toBe("percentage");
    });
  });

  describe("getDeployment", () => {
    it("GET deployment by id", async () => {
      const calls: CallRecord[] = [];
      const deployment = { id: "d1", created_on: "2024-01-01" };
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(deployment))
      );
      const result = await client.getDeployment("my-worker", "d1");
      expect(result.id).toBe("d1");
      expect(calls[0].url).toContain("/deployments/d1");
    });
  });

  describe("listSecrets", () => {
    it("GET /accounts/{id}/workers/scripts/{name}/secrets", async () => {
      const calls: CallRecord[] = [];
      const secrets = [{ name: "API_KEY", type: "secret_text" as const }];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, fakeOk(secrets))
      );
      const result = await client.listSecrets("my-worker");
      expect(result).toHaveLength(1);
      expect(calls[0].url).toContain("/secrets");
    });
  });

  describe("putSecret", () => {
    it("PUT secret with JSON body", async () => {
      const calls: CallRecord[] = [];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, new Response(JSON.stringify({ success: true, errors: [], result: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      );
      await client.putSecret("my-worker", "API_KEY", "sk-123");
      expect(calls[0].method).toBe("PUT");
      expect(calls[0].url).toContain("/secrets");
      const body = JSON.parse(calls[0].body!);
      expect(body.name).toBe("API_KEY");
      expect(body.type).toBe("secret_text");
      expect(body.text).toBe("sk-123");
    });
  });

  describe("bulkSecrets", () => {
    it("PATCH with secrets map", async () => {
      const calls: CallRecord[] = [];
      const client = createCloudflareClient(
        basicConfig(),
        recordingFetch(calls, new Response(JSON.stringify({ success: true, errors: [], result: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
      );
      await client.bulkSecrets("my-worker", [{ name: "API_KEY", type: "secret_text", value: "sk-123" }]);
      expect(calls[0].method).toBe("PATCH");
      expect(calls[0].url).toContain("/secrets-bulk");
      const body = JSON.parse(calls[0].body!);
      // Cloudflare JSON Merge Patch: body is a map keyed by secret name
      expect(body.API_KEY).toBeDefined();
      expect(body.API_KEY.name).toBe("API_KEY");
      expect(body.API_KEY.type).toBe("secret_text");
      expect(body.API_KEY.text).toBe("sk-123");
    });
  });

  describe("error handling", () => {
    it("401 maps to E_AUTH_MISSING non-retryable", async () => {
      const client = createCloudflareClient(basicConfig(), async () => fakeError(401, 10000, "unauthorized"));
      await expect(client.listWorkers()).rejects.toMatchObject({
        code: "E_AUTH_MISSING",
        retryable: false,
      });
    });

    it("404 maps to E_PROVIDER non-retryable", async () => {
      const client = createCloudflareClient(basicConfig(), async () => fakeError(404, 10007, "not found"));
      await expect(client.listWorkers()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: false,
      });
    });

    it("429 maps to E_PROVIDER retryable", async () => {
      const client = createCloudflareClient(basicConfig(), async () => fakeError(429, 10009, "rate limited"));
      await expect(client.listWorkers()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: true,
      });
    });

    it("500 maps to E_PROVIDER retryable", async () => {
      const client = createCloudflareClient(basicConfig(), async () => fakeError(500, 10010, "server error"));
      await expect(client.listWorkers()).rejects.toMatchObject({
        code: "E_PROVIDER",
        retryable: true,
      });
    });

    it("non-JSON response throws E_PROVIDER", async () => {
      const client = createCloudflareClient(basicConfig(), async () =>
        new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } })
      );
      await expect(client.listWorkers()).rejects.toMatchObject({ code: "E_PROVIDER" });
    });
  });

  describe("custom baseUrl", () => {
    it("uses custom base URL", async () => {
      const calls: CallRecord[] = [];
      const client = createCloudflareClient(
        { apiToken: "tok", accountId: "acc", baseUrl: "https://custom.cloudflare.com" },
        recordingFetch(calls, fakeOk({ ok: true }))
      );
      await client.checkAuth();
      expect(calls[0].url).toMatch(/^https:\/\/custom\.cloudflare\.com\/user\/tokens\/verify/);
    });
  });
});
