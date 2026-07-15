import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { DBFilterSchema, DBOrderSchema, DBSchema, DBValueSchema, type DBInput } from "../../../src/tools/db/schema.js";
import type { ToolResult } from "../../../src/core/types.js";
import { registerDB } from "../../../src/tools/db/index.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import type { DatabaseClient, DatabaseClientFactory } from "../../../src/database/client.js";
import { appendDatabaseJournal, readDatabaseJournal } from "../../../src/database/journal.js";

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
    const inspectResult = await execute("id", { action: "inspect" } as DBInput, undefined, undefined, { cwd }) as ToolResult;
    expect(inspectResult.content[1].text).toContain("Inspected");
  });

  it("rejects remote target without PI_SHIP_DATABASE_ENVIRONMENT and rejects non-finite values", async () => {
    // Remote target (DATABASE_URL set) still requires environment var
    const { execute: remoteExecute } = registered({
      credentialSource: { get: (name) => name === "DATABASE_URL" ? "postgres://user:pass@localhost:5432/test" : undefined },
      clientFactory: () => stubClient,
    });
    await expect(remoteExecute("id", { action: "inspect" }, undefined, undefined, { cwd })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    // Non-finite params should be rejected early
    const { execute: finiteExecute } = registered({ credentialSource: envWithDb, clientFactory: () => stubClient });
    await expect(finiteExecute("id", { action: "query", sql: "select $1", params: [Infinity], limit: 1 }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("falls back to local target when DATABASE_URL absent", async () => {
    const { execute } = registered({ credentialSource: environmentSource });
    // inspect on fresh local DB returns empty catalog
    const inspectResult = await execute("id", { action: "inspect" }, undefined, undefined, { cwd }) as ToolResult;
    expect(inspectResult.content.some((c: any) => c.text.includes("local embedded database"))).toBe(true);
    // query on local DB works (select 1)
    const queryResult = await execute("id", { action: "query", sql: "select 1" }, undefined, undefined, { cwd }) as ToolResult;
    expect(queryResult.content.some((c: any) => c.text.includes("local embedded database"))).toBe(true);
    expect(queryResult.content.some((c: any) => c.text.includes("Query returned 1 row"))).toBe(true);
    // browse on non-existent table fails with provider error
    await expect(execute("id", { action: "browse", table: "x", limit: 1, offset: 0 }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
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

  it("routes plan_migration to provider handler and migration_status reads generic journal", async () => {
    const { execute } = registered({ credentialSource: envWithDb, clientFactory: () => stubClient });
    // plan_migration reaches Railway handler which uses loadState -> defaultState
    const result = await execute("id", { action: "plan_migration" }, undefined, undefined, { cwd });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining("Migration plan") }],
    });
    // No journal entries yet — migration_status reports empty
    const status = await execute("id", { action: "migration_status" }, undefined, undefined, { cwd });
    expect(status).toMatchObject({
      content: [{ text: expect.stringContaining("No database migration entries found") }],
    });
  });

  it("migration_status returns journal entries from generic journal", async () => {
    const { execute } = registered({ credentialSource: envWithDb, clientFactory: () => stubClient });
    const at = new Date().toISOString();
    const entry = await appendDatabaseJournal(cwd, {
      version: 1,
      planId: "test-plan-id",
      planDigest: "0000000000000000000000000000000000000000000000000000000000000001",
      targetFingerprint: "0000000000000000000000000000000000000000000000000000000000000002",
      providerFingerprint: "0000000000000000000000000000000000000000000000000000000000000003",
      manifestFingerprint: "0000000000000000000000000000000000000000000000000000000000000004",
      sqlFingerprint: "0000000000000000000000000000000000000000000000000000000000000005",
      paramFingerprint: "0000000000000000000000000000000000000000000000000000000000000006",
      environment: "development",
      risk: "write",
      statementCount: 1,
      status: "committed",
      at,
    });
    const result = await execute("id", { action: "migration_status" }, undefined, undefined, { cwd }) as ToolResult;
    expect(result.content[1].text).toContain("Found 1 migration entry");
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
