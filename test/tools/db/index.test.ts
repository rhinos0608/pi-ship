import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { DBFilterSchema, DBOrderSchema, DBSchema, DBValueSchema, type DBInput } from "../../../src/tools/db/schema.js";
import { registerDB } from "../../../src/tools/db/index.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import type { DatabaseClient, DatabaseClientFactory } from "../../../src/database/client.js";

const environmentSource = { get: (name: string) => name === "PI_SHIP_DATABASE_ENVIRONMENT" ? "development" : undefined };
const envWithDb = { get: (name: string) => ({ PI_SHIP_DATABASE_ENVIRONMENT: "development", DATABASE_URL: "postgres://user:pass@localhost:5432/test" })[name] };

/** Stub client that records all calls. */
function makeStubClient(): DatabaseClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ fields: [], rows: [], rowCount: 0, command: "SELECT" }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("DBSchema", () => {
  it("accepts supported actions and rejects provision or model-selected environment", () => {
    for (const value of [
      { action: "inspect" }, { action: "migration_status" }, { action: "plan_migration" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
      { action: "browse", table: "users", limit: 1, offset: 0 },
      { action: "browse", table: "users" },
      { action: "query", sql: "select 1", limit: 1 },
      { action: "query", sql: "select 1" },
      { action: "plan", sql: "select 1" },
    ]) expect(Value.Check(DBSchema, value), JSON.stringify(value)).toBe(true);
    expect(Value.Check(DBSchema, { action: "provision" })).toBe(false);
    expect(Value.Check(DBSchema, { action: "plan_migration", environment: "production" })).toBe(false);
  });

  it("browse and query accept missing optional limit/offset and reject bound violations", () => {
    expect(Value.Check(DBSchema, { action: "browse", table: "users" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "browse", table: "x", limit: 201, offset: 0 })).toBe(false);
    expect(Value.Check(DBSchema, { action: "browse", table: "x", limit: 1, offset: 10001 })).toBe(false);
    expect(Value.Check(DBSchema, { action: "query", sql: "select 1" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "query", sql: "", limit: 1 })).toBe(false);
    expect(Value.Check(DBSchema, { action: "query", sql: "select 1", limit: 0 })).toBe(false);
  });

  it("uses strict, bounded DB value, filter, order shapes", () => {
    expect(Value.Check(DBValueSchema, "x")).toBe(true);
    expect(Value.Check(DBValueSchema, ["x"])) .toBe(false);
    expect(Value.Check(DBSchema, { action: "query", sql: "select 1", params: Array.from({ length: 101 }, () => "x"), limit: 1 })).toBe(false);
    expect(Value.Check(DBFilterSchema, { column: "id", op: "eq", value: 1 })).toBe(true);
    expect(Value.Check(DBFilterSchema, { column: "id", op: "is_null" })).toBe(true);
    expect(Value.Check(DBFilterSchema, { column: "id", op: "is_null", value: null })).toBe(false);
    expect(Value.Check(DBOrderSchema, { column: "id", direction: "asc", extra: true })).toBe(false);
  });
});

describe("DB tool", () => {
  const exec = promisify(execFile);
  let cwd: string;
  let stubClient: DatabaseClient;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-dbtool-"));
    await exec("git", ["init"], { cwd });
    await exec("git", ["config", "user.email", "t@t.local"], { cwd });
    await exec("git", ["config", "user.name", "T"], { cwd });
    await writeFile(join(cwd, "x"), "y");
    await exec("git", ["add", "."], { cwd });
    await exec("git", ["commit", "-m", "init"], { cwd });
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({
      name: "db-tool-test", provider: "railway", project: "db-tool-test",
      run: { command: ["node", "server.js"] }, db: { migrate: { command: ["npx", "prisma", "migrate", "deploy"] } },
    }));
    stubClient = makeStubClient();
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  function registered(opts?: { clientFactory?: DatabaseClientFactory; credentialSource?: { get: (name: string) => string | undefined } }) {
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const calls: { name: string; parameters: unknown }[] = [];
    const factory = opts?.clientFactory ?? (() => stubClient);
    registerDB({ registerTool(def: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }) {
      calls.push(def); execute = def.execute;
    } } as never, new ApprovalRegistry(cwd), {
      credentialSource: opts?.credentialSource ?? environmentSource,
      clientFactory: factory,
    });
    return { calls, execute: execute! };
  }

  it("registers uppercase DB only and routes inspect with fake client", async () => {
    const { calls, execute } = registered({ credentialSource: envWithDb, clientFactory: () => stubClient });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "DB", parameters: DBSchema });
    // Inspect without manifest -> uses shared read kernel, returns catalog results
    await expect(execute("id", { action: "inspect" } as DBInput, undefined, undefined, { cwd }))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("Inspected") }] });
  });

  it("requires environment source before every dispatch and rejects non-finite values", async () => {
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerDB({ registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } } as never, new ApprovalRegistry(cwd), {
      credentialSource: { get: () => undefined },
    });
    await expect(execute!("id", { action: "inspect" }, undefined, undefined, { cwd })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    const { execute: finiteExecute } = registered({ credentialSource: envWithDb, clientFactory: () => stubClient });
    await expect(finiteExecute("id", { action: "query", sql: "select $1", params: [Infinity], limit: 1 }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects missing DATABASE_URL with E_AUTH_MISSING", async () => {
    const { execute } = registered({ credentialSource: environmentSource });
    await expect(execute("id", { action: "browse", table: "x", limit: 1, offset: 0 }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    await expect(execute("id", { action: "query", sql: "select 1" }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    await expect(execute("id", { action: "inspect" }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_AUTH_MISSING" });
  });

  it("rejects query with invalid SQL before contacting any client", async () => {
    const connect = vi.fn();
    const factorySpy = vi.fn(() => ({ ...stubClient, connect }));
    const { execute } = registered({
      credentialSource: envWithDb,
      clientFactory: factorySpy,
    });
    await expect(execute("id", { action: "query", sql: "INSERT INTO x VALUES (1)" }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    expect(factorySpy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects browse with invalid identifier without factory call", async () => {
    const factorySpy = vi.fn(() => stubClient);
    const { execute } = registered({ credentialSource: envWithDb, clientFactory: factorySpy });
    await expect(execute("id", { action: "browse", table: "" }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(execute("id", { action: "browse", table: "x\0y" }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("routes plan_migration to provider handler and migration_status returns stub", async () => {
    const { execute } = registered({ credentialSource: envWithDb, clientFactory: () => stubClient });
    // plan_migration reaches Railway handler which uses loadState -> defaultState
    const result = await execute("id", { action: "plan_migration" }, undefined, undefined, { cwd });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining("Migration plan") }],
    });
    await expect(execute("id", { action: "migration_status" }, undefined, undefined, { cwd }))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("Migration status") }] });
  });

  it("plans without manifest, persists redacted result, retains exact payload until cleanup", async () => {
    await unlink(join(cwd, "pi-ship.json"));
    const payloads = new (await import("../../../src/database/payload.js")).DatabasePayloadRegistry();
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerDB({ registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } } as never, new ApprovalRegistry(cwd), {
      credentialSource: { get: (name: string) => ({ PI_SHIP_DATABASE_ENVIRONMENT: "development", DATABASE_URL: "postgres://alice:password@db.example.test:5432/app?sslmode=require" })[name] },
      payloads,
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const literal = "DISTINCTIVE_SQL_LITERAL";
    const secret = "secret-param";
    try {
      const result = await execute!("id", { action: "plan", sql: `INSERT INTO audit_log (message, note) VALUES ($1, '${literal}')`, params: [secret] }, undefined, undefined, { cwd, hasUI: false, ui: undefined });
      const details = (result as { details: { planId: string; planDigest: string; approved: boolean } }).details;
      expect(details.approved).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      const persisted = await readFile(join(cwd, ".pi-ship", "plans", `${details.planId}.json`), "utf8");
      expect(persisted).not.toContain(literal);
      expect(persisted).not.toContain("password");
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain('"sql"');
      expect(persisted).not.toContain('"params"');
      expect(payloads.require(details.planId, details.planDigest)).toMatchObject({ sql: `INSERT INTO audit_log (message, note) VALUES ($1, '${literal}')`, params: [secret] });
      payloads.clear();
      expect(() => payloads.require(details.planId, details.planDigest)).toThrow(expect.objectContaining({ code: "E_STATE_CONFLICT" }));
    } finally { fetch.mockRestore(); }
  });

  it("rejects invalid present manifest during planning", async () => {
    await writeFile(join(cwd, "pi-ship.json"), "{ invalid json");
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerDB({ registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } } as never, new ApprovalRegistry(cwd), {
      credentialSource: { get: (name: string) => ({ PI_SHIP_DATABASE_ENVIRONMENT: "development", DATABASE_URL: "postgres://alice:password@db.example.test/app" })[name] },
    });
    await expect(execute!("id", { action: "plan", sql: "INSERT INTO audit_log VALUES (1)", params: [] }, undefined, undefined, { cwd, hasUI: false, ui: undefined })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects parser input before creating plan or payload", async () => {
    await unlink(join(cwd, "pi-ship.json"));
    const payloads = new (await import("../../../src/database/payload.js")).DatabasePayloadRegistry();
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerDB({ registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } } as never, new ApprovalRegistry(cwd), {
      credentialSource: { get: (name: string) => ({ PI_SHIP_DATABASE_ENVIRONMENT: "development", DATABASE_URL: "postgres://alice:password@db.example.test/app" })[name] }, payloads,
    });
    await expect(execute!("id", { action: "plan", sql: "CRAP SQL", params: [] }, undefined, undefined, { cwd, hasUI: false, ui: undefined })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    expect(payloads.size).toBe(0);
    await expect(readFile(join(cwd, ".pi-ship", "plans", "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing environment and malformed database URL", async () => {
    for (const values of [{ DATABASE_URL: "postgres://alice:password@db.example.test/app" }, { PI_SHIP_DATABASE_ENVIRONMENT: "development", DATABASE_URL: "not-a-url" }]) {
      let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
      registerDB({ registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } } as never, new ApprovalRegistry(cwd), {
        credentialSource: { get: (name: string) => values[name as keyof typeof values] },
      });
      await expect(execute!("id", { action: "plan", sql: "INSERT INTO audit_log VALUES (1)", params: [] }, undefined, undefined, { cwd, hasUI: false, ui: undefined })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    }
  });

  it("prompts destructive plans with database destructive approval scope", async () => {
    await unlink(join(cwd, "pi-ship.json"));
    const approvals = new ApprovalRegistry(cwd);
    const prompts: Array<[string, string]> = [];
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerDB({ registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } } as never, approvals, {
      credentialSource: { get: (name: string) => ({ PI_SHIP_DATABASE_ENVIRONMENT: "production", DATABASE_URL: "postgresql://alice:password@db.example.test/app" })[name] },
    });
    const result = await execute!("id", { action: "plan", sql: "DELETE FROM audit_log WHERE id = $1", params: [1] }, undefined, undefined, {
      cwd, hasUI: true, ui: { confirm: async (title: string, summary: string) => { prompts.push([title, summary]); return true; } },
    });
    const details = (result as { details: { planId: string; planDigest: string; approved: boolean } }).details;
    expect(details.approved).toBe(true);
    expect(prompts[0]?.[0]).toMatch(/high-risk.*destructive/i);
    expect(approvals.isApproved(details.planId, details.planDigest, cwd, { domain: "database", risk: "destructive" })).toBe(true);
    expect(approvals.isApproved(details.planId, details.planDigest, cwd, { domain: "deployment", risk: "write" })).toBe(false);
  });
});
