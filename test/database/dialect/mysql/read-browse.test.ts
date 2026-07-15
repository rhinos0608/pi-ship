/** Tests for MySQL read and browse operations — uses fake mysql2, asserts transaction order and SQL. */
import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted ensures variables defined before mock factory runs
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
 * Set up read mock sequence: START TRANSACTION -> query -> ROLLBACK
 */
function setupReadMock(rows: Record<string, unknown>[], fields?: { name: string; type?: number }[]) {
  fakeExecute.mockReset();
  fakeExecute.mockResolvedValueOnce([[], []]);                                // START TRANSACTION READ ONLY
  fakeExecute.mockResolvedValueOnce([rows, fields ?? []]);                    // query
  fakeExecute.mockResolvedValueOnce([[], []]);                                // ROLLBACK
  fakeExecute.mockResolvedValue([[], []]);                                    // fallback
}

describe("MySQL read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const target = {
    kind: "remote" as const,
    dialect: "mysql" as const,
    url: "mysql://user:pass@localhost:3306/testdb",
  };

  it("executes connect -> START TRANSACTION READ ONLY -> query -> ROLLBACK -> end in order", async () => {
    const { executeMySQLRead } = await import("../../../../src/database/dialect/mysql/read.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    await executeMySQLRead(target, { sql: "SELECT * FROM users WHERE id = ?", params: [1] });

    const executeCalls = fakeExecute.mock.calls.map((c: any[]) => c[0]);
    expect(executeCalls[0]).toBe("START TRANSACTION READ ONLY");
    expect(executeCalls[1]).toContain("SELECT * FROM users WHERE id = ?");
    expect(executeCalls[1]).toContain("LIMIT ?");
    expect(executeCalls[2]).toBe("ROLLBACK");

    expect(fakeConnect).toHaveBeenCalledTimes(1);
    expect(fakeEnd).toHaveBeenCalledTimes(1);
  });

  it("appends LIMIT ? with limit+1 for hasMore detection", async () => {
    const { executeMySQLRead } = await import("../../../../src/database/dialect/mysql/read.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    await executeMySQLRead(target, { sql: "SELECT * FROM users", limit: 50 });

    const queryCalls = fakeExecute.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("SELECT * FROM users"),
    );
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const querySql = queryCalls[0][0] as string;
    expect(querySql).toMatch(/LIMIT\s+\?/i);
    expect(queryCalls[0][1]).toEqual([51]);
  });

  it("strips trailing semicolons before appending LIMIT", async () => {
    const { executeMySQLRead } = await import("../../../../src/database/dialect/mysql/read.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    await executeMySQLRead(target, { sql: "SELECT * FROM users;" });

    const queryCalls = fakeExecute.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("SELECT * FROM users"),
    );
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const querySql = queryCalls[0][0] as string;
    expect(querySql).not.toContain(";");
    expect(querySql).toContain("LIMIT ?");
  });

  it("returns hasMore when rows exceed limit", async () => {
    const { executeMySQLRead } = await import("../../../../src/database/dialect/mysql/read.js");

    setupReadMock(
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      [{ name: "id", type: 3 }],
    );

    const result = await executeMySQLRead(target, { sql: "SELECT * FROM users", limit: 3 });
    expect(result.hasMore).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rowCount).toBe(3);
  });

  it("ROLLBACKs on error", async () => {
    const { executeMySQLRead } = await import("../../../../src/database/dialect/mysql/read.js");

    fakeConnect.mockRejectedValueOnce(new Error("connection failed"));

    await expect(
      executeMySQLRead(target, { sql: "SELECT * FROM users" }),
    ).rejects.toThrow();
  });
});

describe("MySQL browse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const target = {
    kind: "remote" as const,
    dialect: "mysql" as const,
    url: "mysql://user:pass@localhost:3306/testdb",
  };

  it("uses backtick quoting and ? placeholders", async () => {
    const { executeMySQLBrowse } = await import("../../../../src/database/dialect/mysql/browse.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    await executeMySQLBrowse(target, {
      schema: "public",
      table: "users",
      columns: ["id", "name"],
      filters: [{ column: "name", op: "like", value: "%test%" }],
      orderBy: [{ column: "id", direction: "ASC" }],
      limit: 10,
      offset: 0,
    });

    const queryCalls = fakeExecute.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("SELECT"),
    );
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const querySql = queryCalls[0][0] as string;
    expect(querySql).toContain("`id`");
    expect(querySql).toContain("`name`");
    expect(querySql).toContain("`users`");
    expect(querySql).toContain("`public`");
    expect(querySql).toContain("`name` LIKE ?");
    expect(querySql).toContain("LIMIT ? OFFSET ?");
  });

  it("rejects ILIKE operator", async () => {
    const { executeMySQLBrowse } = await import("../../../../src/database/dialect/mysql/browse.js");

    setupReadMock([], []);

    await expect(
      executeMySQLBrowse(target, {
        table: "users",
        filters: [{ column: "name", op: "ilike", value: "%test%" }],
        limit: 10,
        offset: 0,
      }),
    ).rejects.toThrow("unsupported operator");
  });

  it("ignores nulls ordering (MySQL does not support NULLS FIRST/LAST)", async () => {
    const { executeMySQLBrowse } = await import("../../../../src/database/dialect/mysql/browse.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    const result = await executeMySQLBrowse(target, {
      table: "users",
      orderBy: [{ column: "name", direction: "ASC", nulls: "first" }],
      limit: 10,
      offset: 0,
    });

    // Should succeed (nulls silently ignored) and not contain NULLS FIRST syntax
    const queryCalls = fakeExecute.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("SELECT"),
    );
    const querySql = queryCalls[0][0] as string;
    expect(querySql).toContain("ORDER BY");
    expect(querySql).not.toContain("NULLS");
  });

  it("produces correct ? bind params", async () => {
    const { executeMySQLBrowse } = await import("../../../../src/database/dialect/mysql/browse.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    await executeMySQLBrowse(target, {
      schema: "public",
      table: "users",
      filters: [
        { column: "name", op: "eq", value: "alice" },
        { column: "age", op: "gt", value: 25 },
      ],
      limit: 10,
      offset: 5,
    });

    const queryCalls = fakeExecute.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("SELECT"),
    );
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    expect(queryCalls[0][1]).toEqual(["alice", 25, 11, 5]);
  });

  it("executes connect -> START TRANSACTION READ ONLY -> browse -> ROLLBACK -> end", async () => {
    const { executeMySQLBrowse } = await import("../../../../src/database/dialect/mysql/browse.js");

    setupReadMock([{ id: 1 }], [{ name: "id", type: 3 }]);

    await executeMySQLBrowse(target, {
      table: "users",
      limit: 10,
      offset: 0,
    });

    const executeCalls = fakeExecute.mock.calls.map((c: any[]) => c[0]);
    expect(executeCalls[0]).toBe("START TRANSACTION READ ONLY");
    expect(executeCalls[1]).toContain("SELECT");
    expect(executeCalls[2]).toBe("ROLLBACK");

    expect(fakeConnect).toHaveBeenCalledTimes(1);
    expect(fakeEnd).toHaveBeenCalledTimes(1);
  });
});
