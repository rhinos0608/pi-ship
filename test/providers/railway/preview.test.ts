import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createRailwayAdapter, type ProviderAdapter, type FailureInjection } from "../../../src/providers/railway/adapter.js";
import { RAILWAY_GRAPHQL_ENDPOINT } from "../../../src/providers/railway/gql.js";

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

type GqlFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function adapterWith(fetchImpl: GqlFetchLike) {
  const pi = { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false, cancelled: false, truncated: false })) } as unknown as Pick<ExtensionAPI, "exec">;
  return createRailwayAdapter(pi, { apiToken: "api-token", fetchImpl });
}

describe("preview environment operations", () => {
  it("createPreviewEnvironment creates env when none exists", async () => {
    const reqs: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reqs.push(body);
      // findEnvironmentByName returns null
      if (reqs.length === 1) return response({ project: { environments: [] } });
      // environmentCreate returns id
      return response({ environmentCreate: { id: "penv-1" } });
    };
    const adapter = adapterWith(fetchImpl);
    const result = await adapter.createPreviewEnvironment("proj-1", "pr-42");
    expect(result).toEqual({ environmentId: "penv-1", created: true });
    expect(reqs.length).toBe(2);
    expect(reqs[1]?.query).toContain("environmentCreate");
  });

  it("createPreviewEnvironment reuses existing env", async () => {
    const reqs: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reqs.push(body);
      // findEnvironmentByName returns existing
      return response({ project: { environments: [{ id: "penv-existing", name: "pr-42" }] } });
    };
    const adapter = adapterWith(fetchImpl);
    const result = await adapter.createPreviewEnvironment("proj-1", "pr-42");
    expect(result).toEqual({ environmentId: "penv-existing", created: false });
    expect(reqs.length).toBe(1);
  });

  it("ensurePostgres idempotent - skips when Postgres instance exists", async () => {
    const reqs: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reqs.push(body);
      return response({
        environment: {
          serviceInstances: [{ id: "pg-1", name: "Postgres", serviceId: "pg-svc-1" }],
        },
      });
    };
    const adapter = adapterWith(fetchImpl);
    const result = await adapter.ensurePostgres("proj-1", "env-1", "ws-1");
    expect(result).toEqual({ serviceId: "pg-svc-1", created: false });
    expect(reqs.length).toBe(1);
  });

  it("ensurePostgres provisions when no Postgres instance exists", async () => {
    let call = 0;
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      call++;
      // First: getServiceInstances returns empty
      if (call === 1) {
        return response({ environment: { serviceInstances: [] } });
      }
      // Second: getTemplate returns template
      if (call === 2) {
        return response({ template: { id: "tmpl-postgres", serializedConfig: "{}" } });
      }
      // Third: deployTemplate returns service id
      return response({ templateDeployV2: { id: "pg-svc-2" } });
    };
    const adapter = adapterWith(fetchImpl);
    const result = await adapter.ensurePostgres("proj-1", "env-1", "ws-1");
    expect(result).toEqual({ serviceId: "pg-svc-2", created: true });
    expect(call).toBe(3);
  });

  it("linkPostgresToService sets DATABASE_URL reference variable", async () => {
    const reqs: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reqs.push(body);
      return response({ variableCollectionUpsert: true });
    };
    const adapter = adapterWith(fetchImpl);
    await adapter.linkPostgresToService("proj-1", "env-1", "svc-1");
    expect(reqs.length).toBe(1);
    const vars = reqs[0]?.variables;
    expect(vars?.projectId).toBe("proj-1");
    expect(vars?.environmentId).toBe("env-1");
    expect(vars?.serviceId).toBe("svc-1");
  });

  it("getWorkspaceId discovers and caches workspaceId", async () => {
    let fetchCount = 0;
    const fetchImpl: GqlFetchLike = async () => {
      fetchCount++;
      return response({ project: { workspaceId: "ws-proj-1" } });
    };
    const adapter = adapterWith(fetchImpl);
    const wid1 = await adapter.getWorkspaceId("proj-1");
    expect(wid1).toBe("ws-proj-1");
    const wid2 = await adapter.getWorkspaceId("proj-1");
    expect(wid2).toBe("ws-proj-1");
    expect(fetchCount).toBe(1);
  });

  it("deployToPreview deploys service to environment", async () => {
    const reqs: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reqs.push(body);
      return response({});
    };
    const adapter = adapterWith(fetchImpl);
    await adapter.deployToPreview("svc-1", "env-preview-1");
    expect(reqs.length).toBe(1);
    expect(reqs[0]?.query).toContain("serviceInstanceDeployV2");
    expect(reqs[0]?.variables?.serviceId).toBe("svc-1");
    expect(reqs[0]?.variables?.environmentId).toBe("env-preview-1");
  });

  it("idempotent: createPreviewEnvironment does not create second env", async () => {
    const reqs: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reqs.push(body);
      return response({ project: { environments: [{ id: "penv-1", name: "pr-99" }] } });
    };
    const adapter = adapterWith(fetchImpl);
    const r1 = await adapter.createPreviewEnvironment("proj-1", "pr-99");
    const r2 = await adapter.createPreviewEnvironment("proj-1", "pr-99");
    expect(r1).toEqual({ environmentId: "penv-1", created: false });
    expect(r2).toEqual({ environmentId: "penv-1", created: false });
    // Only one findEnvironmentByName call (second is cached by first returning same)
    expect(reqs.length).toBe(2); // both go to gql (no local cache)
  });

  it("state isolation: two previews have different env IDs", async () => {
    let call = 0;
    const fetchImpl: GqlFetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      call++;
      if (call === 1) return response({ project: { environments: [] } }); // pr-1: no existing
      if (call === 2) return response({ environmentCreate: { id: "penv-1" } }); // pr-1: create
      if (call === 3) return response({ project: { environments: [] } }); // pr-2: no existing
      if (call === 4) return response({ environmentCreate: { id: "penv-2" } }); // pr-2: create
      return response({});
    };
    const adapter = adapterWith(fetchImpl);
    const r1 = await adapter.createPreviewEnvironment("proj-1", "pr-1");
    const r2 = await adapter.createPreviewEnvironment("proj-1", "pr-2");
    expect(r1.environmentId).toBe("penv-1");
    expect(r2.environmentId).toBe("penv-2");
    expect(r1.environmentId).not.toBe(r2.environmentId);
  });
});
