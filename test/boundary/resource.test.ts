import { describe, it, expect, beforeEach } from "vitest";
import { createDatabaseResource, createDeploymentResource, createVercelResource, createRailwayResource, createCloudflareResource, createNeonControlPlaneResource, ProtectedResourceRegistry } from "../../src/boundary/resource.js";

describe("createDatabaseResource", () => {
  it("returns default database resource", () => {
    const r = createDatabaseResource();
    expect(r.type).toBe("database");
    expect(r.credentialNames).toContain("DATABASE_URL");
    expect(r.allowedExecutors).toContain("DB");
    expect(r.ports).toContain(5432);
    expect(r.ports).toContain(3306);
  });

  it("accepts overrides", () => {
    const r = createDatabaseResource({ name: "staging-db", ports: [3306] });
    expect(r.name).toBe("staging-db");
    expect(r.ports).toEqual([3306]);
  });
});

describe("createDeploymentResource", () => {
  it("returns default deployment resource", () => {
    const r = createDeploymentResource();
    expect(r.type).toBe("deployment");
    expect(r.allowedExecutors).toContain("ship");
  });
});

describe("createVercelResource", () => {
  it("returns correct type, name, credentialNames, allowedExecutors", () => {
    const r = createVercelResource();
    expect(r.type).toBe("deployment");
    expect(r.name).toBe("vercel-deployment");
    expect(r.credentialNames).toEqual(["VERCEL_TOKEN"]);
    expect(r.allowedExecutors).toEqual(["ship"]);
    expect(r.hostnames).toEqual([]);
    expect(r.ports).toEqual([]);
    expect(r.filePaths).toEqual([]);
  });
});

describe("createRailwayResource", () => {
  it("returns correct type, name, credentialNames", () => {
    const r = createRailwayResource();
    expect(r.type).toBe("deployment");
    expect(r.name).toBe("railway-deployment");
    expect(r.credentialNames).toEqual(["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]);
    expect(r.hostnames).toEqual([]);
    expect(r.ports).toEqual([]);
    expect(r.filePaths).toEqual([]);
  });
});

describe("createCloudflareResource", () => {
  it("returns correct type — verify NO CLOUDFLARE_ACCOUNT_ID", () => {
    const r = createCloudflareResource();
    expect(r.type).toBe("deployment");
    expect(r.name).toBe("cloudflare-deployment");
    expect(r.credentialNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(r.credentialNames).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(r.hostnames).toEqual([]);
    expect(r.ports).toEqual([]);
    expect(r.filePaths).toEqual([]);
  });
});

describe("createNeonControlPlaneResource", () => {
  it("returns type database, allowedExecutors includes ship", () => {
    const r = createNeonControlPlaneResource();
    expect(r.type).toBe("database");
    expect(r.name).toBe("neon-control-plane");
    expect(r.credentialNames).toEqual(["NEON_API_KEY"]);
    expect(r.allowedExecutors).toContain("ship");
    expect(r.hostnames).toEqual([]);
    expect(r.ports).toEqual([]);
    expect(r.filePaths).toEqual([]);
  });
});

describe("ProtectedResourceRegistry", () => {
  let registry: ProtectedResourceRegistry;

  beforeEach(() => {
    registry = new ProtectedResourceRegistry();
  });

  it("registers and retrieves resources", () => {
    const db = createDatabaseResource();
    registry.register(db);
    expect(registry.get("production-database")).toBe(db);
  });

  it("returns undefined for unknown resource", () => {
    expect(registry.get("nope")).toBeUndefined();
  });

  it("filters by type", () => {
    registry.register(createDatabaseResource());
    registry.register(createDeploymentResource());
    expect(registry.byType("database")).toHaveLength(1);
    expect(registry.byType("deployment")).toHaveLength(1);
  });

  it("collects all credential names", () => {
    registry.register(createDatabaseResource());
    registry.register(createDeploymentResource({ credentialNames: ["RAILWAY_API_TOKEN"] }));
    expect(registry.credentialNames()).toContain("DATABASE_URL");
    expect(registry.credentialNames()).toContain("RAILWAY_API_TOKEN");
  });

  it("detects protected credentials", () => {
    registry.register(createDatabaseResource());
    expect(registry.isCredentialProtected("DATABASE_URL")).toBe(true);
    expect(registry.isCredentialProtected("HOME")).toBe(false);
  });

  it("detects allowed executors", () => {
    registry.register(createDatabaseResource());
    expect(registry.isExecutorAllowed("DB")).toBe(true);
    expect(registry.isExecutorAllowed("bash")).toBe(false);
  });
});
