import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createRailwayAdapter } from "../../../src/providers/railway/adapter.js";
import { RAILWAY_GRAPHQL_ENDPOINT, type GqlFetchLike } from "../../../src/providers/railway/gql.js";

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function adapterWith(fetchImpl: GqlFetchLike, exec = vi.fn(async () => ({
  code: 0,
  stdout: '{"status":"success","deploymentId":"release-1"}\n',
  stderr: "",
  killed: false,
  cancelled: false,
  truncated: false,
}))) {
  const pi = { exec } as unknown as Pick<ExtensionAPI, "exec">;
  return { adapter: createRailwayAdapter(pi, { apiToken: "api-token", fetchImpl }), exec };
}

describe("createRailwayAdapter", () => {
  it("uses discovered environment ID for variables and deploy", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetchImpl: GqlFetchLike = async (input, init) => {
      expect(input).toBe(RAILWAY_GRAPHQL_ENDPOINT);
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      requests.push(body);
      if (requests.length === 1) return response({ project: undefined });
      if (requests.length === 2) return response({ projectCreate: { id: "proj-1" } });
      if (requests.length === 3) return response({ project: { id: "proj-1", name: "demo", environments: [{ id: "env-1", name: "production" }] } });
      if (requests.length === 4) return response({ project: { services: [{ id: "svc-1", name: "demo-app" }] } });
      return response({ variableCollectionUpsert: true });
    };
    const { adapter, exec } = adapterWith(fetchImpl);

    await expect(adapter.ensureProject("demo")).resolves.toMatchObject({ projectId: "proj-1", environmentId: "env-1" });
    await expect(adapter.ensureService("proj-1", "demo-app")).resolves.toMatchObject({ serviceId: "svc-1" });
    await adapter.setVariables("svc-1", ["TOKEN"], () => ({ TOKEN: "value" }));
    await adapter.deploy("svc-1", "/tmp/project");

    expect(requests[4]?.variables).toMatchObject({ projectId: "proj-1", environmentId: "env-1", serviceId: "svc-1" });
    expect(exec).toHaveBeenCalledWith("railway", expect.arrayContaining(["--environment", "env-1", "--project", "proj-1"]), expect.objectContaining({ cwd: "/tmp/project" }));
  });

  it("fails closed when environment discovery has no ID", async () => {
    const fetchImpl: GqlFetchLike = async () => response({ project: { id: "proj-1", name: "demo", environments: [] } });
    const { adapter, exec } = adapterWith(fetchImpl);

    await expect(adapter.ensureProject("demo")).rejects.toMatchObject({ code: "E_PRECONDITION" });
    await expect(adapter.setVariables("svc-1", [], () => ({}))).rejects.toMatchObject({ code: "E_PRECONDITION" });
    await expect(adapter.deploy("svc-1", "/tmp/project")).rejects.toMatchObject({ code: "E_PRECONDITION" });
    expect(exec).not.toHaveBeenCalled();
  });
});
