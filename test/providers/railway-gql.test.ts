import { describe, expect, it } from "vitest";
import { createRailwayGqlClient, RAILWAY_GRAPHQL_ENDPOINT } from "../../src/providers/railway/gql.js";

function buildFakeFetch(assertions: Array<{ req: (body: Record<string, unknown>) => boolean; resp: Response }>) {
  let index = 0;
  return async (input: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : ({} as Record<string, any>);
    expect(input).toBe(RAILWAY_GRAPHQL_ENDPOINT);
    const a = assertions[index++];
    if (!a) return new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 200 });
    expect(a.req(body)).toBe(true);
    return a.resp;
  };
}

describe("createRailwayGqlClient", () => {
  it("uses Bearer header for API token", async () => {
    let auth: string | null = null;
    const fetch = async (_input: string, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(JSON.stringify({ data: { me: { id: "u1" } } }), { status: 200 });
    };
    const client = createRailwayGqlClient({ apiToken: "tok" }, fetch);
    await client.checkAuth();
    expect(auth).toBe("Bearer tok");
  });

  it("uses Project-Access-Token header for project token", async () => {
    let header: string | null = null;
    const fetch = async (_input: string, init?: RequestInit) => {
      header = (init?.headers as Record<string, string> | undefined)?.["Project-Access-Token"] ?? null;
      return new Response(JSON.stringify({ data: { me: { id: "u1" } } }), { status: 200 });
    };
    const client = createRailwayGqlClient({ projectToken: "ptok" }, fetch);
    await client.checkAuth();
    expect(header).toBe("ptok");
  });

  it("unwraps data envelope for project/service/status/rollback", async () => {
    const fetch = buildFakeFetch([
      { req: (b) => String(b.query).includes("FindProject"), resp: new Response(JSON.stringify({ data: { project: { id: "p1" } } })) },
      { req: (b) => String(b.query).includes("FindService"), resp: new Response(JSON.stringify({ data: { project: { services: [{ id: "s1", name: "app" }] } } })) },
      { req: (b) => String(b.query).includes("Deployments"), resp: new Response(JSON.stringify({ data: { deployments: [{ status: "SUCCESS", url: "https://app" }] } })) },
      { req: (b) => String(b.query).includes("deployment("), resp: new Response(JSON.stringify({ data: { deployment: { canRollback: false } } })) },
    ]);
    const client = createRailwayGqlClient({ apiToken: "tok" }, fetch);
    await expect(client.ensureProject("app")).resolves.toEqual({ projectId: "p1", created: false });
    await expect(client.ensureService("p1", "app")).resolves.toEqual({ serviceId: "s1", created: false });
    await expect(client.status("s1")).resolves.toEqual({ status: "SUCCESS", url: "https://app" });
    await expect(client.rollback("s1", "r1")).rejects.toMatchObject({ code: "E_PRECONDITION" });
  });

  it("variable upsert body contains replace:false and skipDeploys:true", async () => {
    const fetch = buildFakeFetch([
      {
        req: (body) =>
          typeof body.query === "string" && body.query.includes("variableCollectionUpsert") &&
          (body.variables as Record<string, any> | undefined)?.replace === false &&
          (body.variables as Record<string, any> | undefined)?.skipDeploys === true,
        resp: new Response(JSON.stringify({ data: { variableCollectionUpsert: true } }), { status: 200 }),
      },
    ]);
    const client = createRailwayGqlClient({ apiToken: "tok" }, fetch);
    await client.setVariables("proj", "env", "svc", { KEY: "value" });
  });

  it("linked-existing mode never issues projectCreate or serviceCreate", async () => {
    const client = createRailwayGqlClient({ projectToken: "ptok" }, async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(client.ensureProject("p")).rejects.toMatchObject({ code: "E_PRECONDITION" });
    await expect(client.ensureService("proj", "svc")).rejects.toMatchObject({ code: "E_PRECONDITION" });
  });

  it("429 maps to retryable E_PROVIDER", async () => {
    const fetch = async () => new Response("", { status: 429, headers: { "Retry-After": "5" } });
    const client = createRailwayGqlClient({ apiToken: "tok" }, fetch);
    await expect(client.checkAuth()).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
  });

  it("rollback requires canRollback:true", async () => {
    const fetch = buildFakeFetch([
      {
        req: (body) => typeof body.query === "string" && body.query.includes("deployment("),
        resp: new Response(JSON.stringify({ data: { deployment: { canRollback: false } } }), { status: 200 }),
      },
    ]);
    const client = createRailwayGqlClient({ apiToken: "tok" }, fetch);
    await expect(client.rollback("svc", "dep-1")).rejects.toMatchObject({ code: "E_PRECONDITION" });
  });
});
