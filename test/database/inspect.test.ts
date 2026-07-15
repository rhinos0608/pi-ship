import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabaseClientFactory, DatabaseQueryResult } from "../../src/database/client.js";
import { inspectDatabase } from "../../src/database/inspect.js";

/** Unique SQL markers from each catalog query SELECT clause in inspect.ts. */
const M_NAMESPACE = "pg_get_userbyid(n.nspowner)";
const M_CLASS = "CASE c.relkind";
const M_ATTRIBUTE = "format_type(a.atttypid, a.atttypmod)";
const M_INDEX = "pg_index ix";
const M_ENUM = "ARRAY(SELECT e.enumlabel";
const M_CONSTRAINT = "pg_constraint con";
const M_TRIGGER = "pg_trigger t";
const M_POLICY = "pg_policy p";

function makeFakeClient(
  catalogResults: Record<string, DatabaseQueryResult>,
  signal?: AbortSignal,
): DatabaseClient {
  return {
    connect: vi.fn().mockImplementation(async () => {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
    }),
    query: vi.fn().mockImplementation((text: string) => {
      if (text === "BEGIN READ ONLY") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (text.startsWith("SET LOCAL")) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (text === "ROLLBACK") return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      for (const [marker, result] of Object.entries(catalogResults)) {
        if (text.includes(marker)) return result;
      }
      return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
    }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeFactory(client: DatabaseClient): DatabaseClientFactory {
  return (_connectionString: string) => client;
}

const EMPTY = (): DatabaseQueryResult => ({ fields: [], rows: [], rowCount: 0, command: "SELECT" });

describe("inspectDatabase", () => {
  it("returns empty results for empty database", async () => {
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.schemas).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.indexes).toEqual([]);
    expect(result.enums).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.triggers).toEqual([]);
    expect(result.policies).toEqual([]);
    expect(result.truncatedCategories).toEqual([]);
  });

  it("returns relations with RLS info and schema identity", async () => {
    const client = makeFakeClient({
      [M_NAMESPACE]: { fields: [{ name: "name", dataTypeID: 19 }, { name: "owner", dataTypeID: 19 }], rows: [{ name: "public", owner: "postgres" }], rowCount: 1, command: "SELECT" },
      [M_CLASS]: {
        fields: [
          { name: "schema", dataTypeID: 19 }, { name: "name", dataTypeID: 19 },
          { name: "kind", dataTypeID: 25 }, { name: "rls_enabled", dataTypeID: 16 },
        ],
        rows: [{ schema: "public", name: "users", kind: "table", rls_enabled: true }],
        rowCount: 1, command: "SELECT",
      },
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0]).toMatchObject({ name: "public" });
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({ schema: "public", name: "users", kind: "table", rlsEnabled: true });
  });

  it("contains pg_catalog exclusion and ORDER BY in every query", async () => {
    const queryTexts: string[] = [];
    const fakeQuery = vi.fn().mockImplementation((text: string) => {
      queryTexts.push(text);
      return EMPTY();
    });
    const client: DatabaseClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: fakeQuery,
      end: vi.fn().mockResolvedValue(undefined),
    };
    await inspectDatabase("postgres://localhost/test", fakeFactory(client));

    const catalogQueries = queryTexts.filter((t) => t.includes("pg_catalog"));
    expect(catalogQueries.length).toBeGreaterThanOrEqual(8);

    for (const q of catalogQueries) {
      expect(q).toMatch(/information_schema/);
      expect(q).toMatch(/ORDER BY/);
      expect(q).toMatch(/LIMIT 501/);
    }
  });

  it("reports truncatedCategories when results exceed 500", async () => {
    const manySchemas = Array.from({ length: 501 }, (_, i) => ({ name: `schema_${i}`, owner: "postgres" }));
    const client = makeFakeClient({
      [M_NAMESPACE]: { fields: [{ name: "name", dataTypeID: 19 }, { name: "owner", dataTypeID: 19 }], rows: manySchemas, rowCount: 501, command: "SELECT" },
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.truncatedCategories).toContain("schemas");
    expect(result.schemas).toHaveLength(500);
  });

  it("returns indexes with schema identity and columns array", async () => {
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: {
        fields: [
          { name: "schema", dataTypeID: 19 }, { name: "table_name", dataTypeID: 19 },
          { name: "name", dataTypeID: 19 }, { name: "unique", dataTypeID: 16 },
          { name: "primary", dataTypeID: 16 }, { name: "valid", dataTypeID: 16 },
          { name: "columns", dataTypeID: 25 },
        ],
        rows: [{ schema: "public", table_name: "users", name: "users_pkey", unique: true, primary: true, valid: true, columns: "id" }],
        rowCount: 1, command: "SELECT",
      },
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0]).toMatchObject({
      schema: "public", table: "users", name: "users_pkey",
      unique: true, primary: true, valid: true,
      columns: ["id"],
    });
  });

  it("returns constraints with schema, columns arrays, and refColumns", async () => {
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: {
        fields: [
          { name: "schema", dataTypeID: 19 }, { name: "table_name", dataTypeID: 19 },
          { name: "name", dataTypeID: 19 }, { name: "type", dataTypeID: 25 },
          { name: "columns", dataTypeID: 25 },
          { name: "ref_schema", dataTypeID: 19 }, { name: "ref_table", dataTypeID: 19 },
          { name: "ref_columns", dataTypeID: 25 },
          { name: "deferrable", dataTypeID: 16 }, { name: "deferred", dataTypeID: 16 },
        ],
        rows: [{
          schema: "public", table_name: "orders", name: "orders_user_id_fkey",
          type: "foreign_key", columns: "user_id",
          ref_schema: "public", ref_table: "users", ref_columns: "id",
          deferrable: false, deferred: false,
        }],
        rowCount: 1, command: "SELECT",
      },
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0]).toMatchObject({
      schema: "public", table: "orders", name: "orders_user_id_fkey",
      type: "foreign_key", columns: ["user_id"],
      refSchema: "public", refTable: "users", refColumns: ["id"],
      deferrable: false, deferred: false,
    });
  });

  it("returns triggers with schema, events array, row flag, enabled", async () => {
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: {
        fields: [
          { name: "schema", dataTypeID: 19 }, { name: "table_name", dataTypeID: 19 },
          { name: "name", dataTypeID: 19 }, { name: "timing", dataTypeID: 25 },
          { name: "events", dataTypeID: 25 }, { name: "row_trigger", dataTypeID: 16 },
          { name: "enabled", dataTypeID: 16 },
        ],
        rows: [
          { schema: "public", table_name: "users", name: "check_insert", timing: "BEFORE", events: "INSERT,UPDATE", row_trigger: true, enabled: true },
          { schema: "public", table_name: "audit", name: "after_update", timing: "AFTER", events: "UPDATE", row_trigger: true, enabled: true },
          { schema: "public", table_name: "views", name: "instead_select", timing: "INSTEAD OF", events: "SELECT", row_trigger: false, enabled: false },
        ],
        rowCount: 3, command: "SELECT",
      },
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.triggers).toHaveLength(3);
    // BEFORE, INSERT+UPDATE, row=true, enabled=true
    expect(result.triggers[0]).toMatchObject({
      schema: "public", table: "users", name: "check_insert",
      timing: "BEFORE", events: ["INSERT", "UPDATE"], row: true, enabled: true,
    });
    // AFTER, UPDATE only
    expect(result.triggers[1]).toMatchObject({
      schema: "public", table: "audit", name: "after_update",
      timing: "AFTER", events: ["UPDATE"], row: true, enabled: true,
    });
    // INSTEAD OF, row=false, enabled=false
    expect(result.triggers[2]).toMatchObject({
      schema: "public", table: "views", name: "instead_select",
      timing: "INSTEAD OF", events: ["SELECT"], row: false, enabled: false,
    });
  });

  it("enforces final JSON always <=512KiB even with 500 large entries", async () => {
    // Build 500 big enum rows with normalized ~8KB labels to exceed budget
    const bigLabel = "x".repeat(15_000);
    const rows = Array.from({ length: 500 }, (_, i) => ({
      schema: "public", name: `enum_${i}`, labels: [bigLabel, bigLabel, bigLabel],
    }));
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: {
        fields: [{ name: "schema", dataTypeID: 19 }, { name: "name", dataTypeID: 19 }, { name: "labels", dataTypeID: 2003 }],
        rows, rowCount: rows.length, command: "SELECT",
      },
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(525 * 1024);
  });

  it("policy role SQL uses per-element coalesce for OID 0", async () => {
    const queryTexts: string[] = [];
    const fakeQuery = vi.fn().mockImplementation((text: string) => {
      queryTexts.push(text);
      return EMPTY();
    });
    const client: DatabaseClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: fakeQuery,
      end: vi.fn().mockResolvedValue(undefined),
    };
    await inspectDatabase("postgres://localhost/test", fakeFactory(client));

    const policySql = queryTexts.find((t) => t.includes("pg_policy p"));
    expect(policySql).toBeDefined();
    // Must have per-element coalesce not just aggregate coalesce
    expect(policySql).toContain("coalesce(r.rolname, 'public')");
    // Must not have the old incorrect pattern (aggregate-only coalesce)
    expect(policySql).not.toContain("coalesce(string_agg(r.rolname");
  });

  it("returns policies with schema and roles from unnest", async () => {
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: EMPTY(),
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: {
        fields: [
          { name: "schema", dataTypeID: 19 }, { name: "table_name", dataTypeID: 19 },
          { name: "name", dataTypeID: 19 }, { name: "permissive", dataTypeID: 16 },
          { name: "command", dataTypeID: 25 }, { name: "roles", dataTypeID: 25 },
        ],
        rows: [
          { schema: "public", table_name: "users", name: "user_select", permissive: true, command: "SELECT", roles: "app_user,admin" },
          { schema: "public", table_name: "users", name: "user_insert", permissive: false, command: "INSERT", roles: "public" },
        ],
        rowCount: 2, command: "SELECT",
      },
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    expect(result.policies).toHaveLength(2);
    expect(result.policies[0]).toMatchObject({
      schema: "public", table: "users", name: "user_select",
      permissive: true, command: "SELECT", roles: ["app_user", "admin"],
    });
    expect(result.policies[1]).toMatchObject({
      schema: "public", table: "users", name: "user_insert",
      permissive: false, command: "INSERT", roles: ["public"],
    });
  });

  it("enforces serialized output budget across categories without throwing", async () => {
    // After normalizeCell truncates strings to ~8KB, 40 rows × 3 labels × 8KB ≈ 960KB > 512KB
    const bigLabel = "x".repeat(15_000); // 15KB label — normalized to ~8KB
    const rows = Array.from({ length: 40 }, (_, i) => ({
      schema: "public", name: `enum_${i}`, labels: [bigLabel, bigLabel, bigLabel],
    }));
    const client = makeFakeClient({
      [M_NAMESPACE]: EMPTY(),
      [M_CLASS]: EMPTY(),
      [M_ATTRIBUTE]: EMPTY(),
      [M_INDEX]: EMPTY(),
      [M_ENUM]: {
        fields: [{ name: "schema", dataTypeID: 19 }, { name: "name", dataTypeID: 19 }, { name: "labels", dataTypeID: 2003 }],
        rows,
        rowCount: rows.length, command: "SELECT",
      },
      [M_CONSTRAINT]: EMPTY(),
      [M_TRIGGER]: EMPTY(),
      [M_POLICY]: EMPTY(),
    });
    const result = await inspectDatabase("postgres://localhost/test", fakeFactory(client));
    // Should not throw - truncates silently to fit budget
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(525 * 1024);
    // Budget truncation reduced enums count
    expect(result.enums.length).toBeLessThan(40);
  });

  it("uses 5000ms / 1000ms local timeouts", async () => {
    const queryTexts: string[] = [];
    const fakeQuery = vi.fn().mockImplementation((text: string) => {
      queryTexts.push(text);
      return EMPTY();
    });
    const client: DatabaseClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: fakeQuery,
      end: vi.fn().mockResolvedValue(undefined),
    };
    await inspectDatabase("postgres://localhost/test", fakeFactory(client));

    const setCalls = queryTexts.filter((t) => t.startsWith("SET LOCAL"));
    expect(setCalls).toContain("SET LOCAL statement_timeout = '5000ms'");
    expect(setCalls).toContain("SET LOCAL lock_timeout = '1000ms'");
  });

  it("aborts before connect when signal pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectDatabase("postgres://localhost/test", fakeFactory(makeFakeClient({})), controller.signal)
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  });
});
