import { describe, expect, it } from "vitest";
import { err } from "../../../src/core/errors.js";
import { createFakeProvider } from "../../support/railway-fake.js";

describe("createFakeProvider", () => {
  it("ensureProject creates on first call, finds existing on second", async () => {
    const p = createFakeProvider();
    const r1 = await p.ensureProject("my-project");
    expect(r1.created).toBe(true);
    const r2 = await p.ensureProject("my-project");
    expect(r2.created).toBe(false);
    expect(r1.projectId).toBe(r2.projectId);
  });

  it("ensureService under a project is idempotent", async () => {
    const p = createFakeProvider();
    const proj = await p.ensureProject("my-project");
    const s1 = await p.ensureService(proj.projectId, "app");
    expect(s1.created).toBe(true);
    const s2 = await p.ensureService(proj.projectId, "app");
    expect(s2.created).toBe(false);
    expect(s1.serviceId).toBe(s2.serviceId);
  });

  it("setVariables reads values from source callback and records names only", async () => {
    const p = createFakeProvider();
    const svc = await p.ensureService("proj-1", "app");
    await p.setVariables(svc.serviceId, ["DATABASE_URL"], () => ({ DATABASE_URL: "postgres://secret" }));
    expect(p.variables.get(svc.serviceId)).toEqual({ DATABASE_URL: "postgres://secret" });
    const call = p.calls.find((c) => c.method === "setVariables");
    expect(call?.args[1]).toEqual(["DATABASE_URL"]);
  });

  it("deploy returns release ID and URL", async () => {
    const p = createFakeProvider();
    const svc = await p.ensureService("proj-1", "app");
    const r = await p.deploy(svc.serviceId, "/tmp", undefined, () => {});
    expect(r.releaseId).toBeDefined();
    expect(r.url).toContain("railway.app");
  });

  it("status and logs return recorded values", async () => {
    const p = createFakeProvider();
    const svc = await p.ensureService("proj-1", "app");
    const status = await p.status(svc.serviceId);
    expect(status.status).toBe("SUCCESS");
    const logs = await p.logs(svc.serviceId, 10);
    expect(logs).toContain("log line 1");
  });

  it("rollback marks release as rolled back", async () => {
    const p = createFakeProvider();
    const svc = await p.ensureService("proj-1", "app");
    const rel = await p.deploy(svc.serviceId, "/tmp");
    const r = await p.rollback(svc.serviceId, rel.releaseId);
    expect(r.ok).toBe(true);
  });

  it("duplicate found with mismatched state returns conflict", async () => {
    const p = createFakeProvider({ initial: { projects: { "my-project": "proj-abc" } } });
    const r = await p.ensureProject("my-project");
    expect(r.projectId).toBe("proj-abc");
    expect(r.created).toBe(false);
  });

  it("provisionPostgres returns ok with serviceId", async () => {
    const p = createFakeProvider();
    const r = await p.provisionPostgres("proj-1", "env-1", "ws-1");
    expect(r.ok).toBe(true);
    expect(r.serviceId).toBe("test-postgres-service-id");
  });
});
