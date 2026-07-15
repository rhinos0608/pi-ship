/** Tests for MySQL inspection — uses fake mysql2 client, asserts fixed SQL queries and result mapping. */
import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted ensures these are defined before mock factory runs
const fakeExecute = vi.hoisted(() => vi.fn());
const fakeConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fakeEnd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fakeCreateConnection = vi.hoisted(() => vi.fn());
fakeCreateConnection.mockReturnValue({
  connect: fakeConnect,
  execute: fakeExecute,
  end: fakeEnd,
});

vi.mock("mysql2/promise", () => ({
  createConnection: fakeCreateConnection,
}));

/**
 * Helper: set up execute mock results in order for the inspect flow:
 * START TRANSACTION -> SCHEMAS -> TABLES -> COLUMNS -> INDEXES -> CONSTRAINTS -> ROLLBACK
 */
function setupInspectMocks(results: Record<string, unknown>[][]) {
  fakeExecute.mockReset();
  // First call: START TRANSACTION READ ONLY (always returns empty)
  fakeExecute.mockResolvedValueOnce([[], []]);
  // Then category queries in order
  for (const rows of results) {
    fakeExecute.mockResolvedValueOnce([rows, []]);
  }
  // Last: ROLLBACK (always returns empty)
  fakeExecute.mockResolvedValueOnce([[], []]);
  // Default fallback for any extra calls
  fakeExecute.mockResolvedValue([[], []]);
}

describe("MySQL inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const target = {
    kind: "remote" as const,
    dialect: "mysql" as const,
    url: "mysql://user:pass@localhost:3306/testdb",
  };

  it("sends START TRANSACTION READ ONLY before queries", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const startTxCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => call[0] === "START TRANSACTION READ ONLY",
    );
    expect(startTxCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sends ROLLBACK after queries", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const rollbackCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => call[0] === "ROLLBACK",
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("queries information_schema.SCHEMATA", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const schemaCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("information_schema.SCHEMATA"),
    );
    expect(schemaCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("queries information_schema.TABLES", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const tablesCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("information_schema.TABLES"),
    );
    expect(tablesCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("queries information_schema.COLUMNS", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const columnsCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("information_schema.COLUMNS"),
    );
    expect(columnsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("queries information_schema.STATISTICS", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const statsCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("information_schema.STATISTICS"),
    );
    expect(statsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("queries information_schema.KEY_COLUMN_USAGE", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    await inspectMySQL(target);

    const keyColCalls = fakeExecute.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("information_schema.KEY_COLUMN_USAGE"),
    );
    expect(keyColCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty PG-only categories (enums, triggers, policies)", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([[], [], [], [], []]);

    const result = await inspectMySQL(target);
    expect(result.enums).toEqual([]);
    expect(result.triggers).toEqual([]);
    expect(result.policies).toEqual([]);
  });

  it("maps schemas correctly", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([
      [{ name: "mydb" }, { name: "test" }], // schemas
      [], [], [], [],
    ]);

    const result = await inspectMySQL(target);
    expect(result.schemas).toEqual([{ name: "mydb" }, { name: "test" }]);
    expect(result.relations).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.indexes).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it("maps tables correctly", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([
      [], // schemas (empty)
      [  // tables
        { schema: "mydb", name: "users", kind: "BASE TABLE" },
        { schema: "mydb", name: "user_view", kind: "VIEW" },
      ],
      [], [], [],
    ]);

    const result = await inspectMySQL(target);
    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]).toMatchObject({ schema: "mydb", name: "users", kind: "table", rlsEnabled: false });
    expect(result.relations[1]).toMatchObject({ schema: "mydb", name: "user_view", kind: "view", rlsEnabled: false });
  });

  it("maps columns with auto_increment detection", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([
      [], // schemas
      [], // tables
      [   // columns
        { schema: "mydb", table_name: "users", name: "id", type: "int", nullable: "NO", default_value: null, extra: "auto_increment" },
        { schema: "mydb", table_name: "users", name: "name", type: "varchar", nullable: "YES", default_value: null, extra: "" },
      ],
      [], [],
    ]);

    const result = await inspectMySQL(target);
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0]).toMatchObject({
      schema: "mydb", table: "users", name: "id", type: "int",
      nullable: false, isIdentity: false, isGenerated: true,
    });
    expect(result.columns[1]).toMatchObject({
      schema: "mydb", table: "users", name: "name", type: "varchar",
      nullable: true, isIdentity: false, isGenerated: false,
    });
  });

  it("maps indexes correctly", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([
      [], [], [],
      [  // indexes
        { schema: "mydb", table_name: "users", name: "PRIMARY", unique_index: 0, primary_index: 1, columns: "id" },
        { schema: "mydb", table_name: "users", name: "idx_name", unique_index: 1, primary_index: 0, columns: "name" },
      ],
      [],
    ]);

    const result = await inspectMySQL(target);
    expect(result.indexes).toHaveLength(2);
    expect(result.indexes[0]).toMatchObject({
      schema: "mydb", table: "users", name: "PRIMARY",
      unique: false, primary: true, valid: true, columns: ["id"],
    });
    expect(result.indexes[1]).toMatchObject({
      schema: "mydb", table: "users", name: "idx_name",
      unique: true, primary: false, valid: true, columns: ["name"],
    });
  });

  it("maps constraints correctly", async () => {
    const { inspectMySQL } = await import("../../../../src/database/dialect/mysql/inspect.js");

    setupInspectMocks([
      [], [], [], [],
      [  // constraints
        {
          schema: "mydb", table_name: "orders", name: "fk_user",
          type: "FOREIGN KEY", columns: "user_id",
          ref_schema: "mydb", ref_table: "users", ref_columns: "id",
        },
        {
          schema: "mydb", table_name: "users", name: "uq_email",
          type: "UNIQUE", columns: "email",
          ref_schema: null, ref_table: null, ref_columns: null,
        },
      ],
    ]);

    const result = await inspectMySQL(target);
    expect(result.constraints).toHaveLength(2);
    expect(result.constraints[0]).toMatchObject({
      schema: "mydb", table: "orders", name: "fk_user",
      type: "foreign_key", columns: ["user_id"],
      refSchema: "mydb", refTable: "users", refColumns: ["id"],
      deferrable: false, deferred: false,
    });
    expect(result.constraints[1]).toMatchObject({
      schema: "mydb", table: "users", name: "uq_email",
      type: "unique", columns: ["email"],
      refSchema: undefined, refTable: undefined, refColumns: undefined,
    });
  });
});
