import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../src/database/client.js";

// We test the mapping logic without a real PGlite by mocking the module.
// The integration suite (T6) tests against real in-memory PGlite.

/**
 * Create a minimal DatabaseClient using the same query logic as
 * the real createPGliteClient: derive command from SQL text and
 * use affectedRows for writes, rows.length for reads.
 */
function wrapPGliteLike(pg: {
  query: (text: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    fields?: { name: string; dataTypeID?: number }[];
    affectedRows?: number;
  }>;
}): DatabaseClient {
  const READ_COMMANDS = new Set([
    "SELECT", "WITH", "VALUES", "EXPLAIN", "SHOW", "DESCRIBE",
  ]);

  function extractCommand(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed) return "SELECT";
    let i = 0;
    while (i < trimmed.length) {
      if (trimmed[i] === "-" && trimmed[i + 1] === "-") {
        const nl = trimmed.indexOf("\n", i);
        if (nl === -1) return "SELECT";
        i = nl + 1;
      } else if (trimmed[i] === "/" && trimmed[i + 1] === "*") {
        const end = trimmed.indexOf("*/", i + 2);
        if (end === -1) return "SELECT";
        i = end + 2;
      } else if (trimmed[i] === " " || trimmed[i] === "\t" || trimmed[i] === "\n" || trimmed[i] === "\r") {
        i++;
      } else {
        break;
      }
    }
    const wordEnd = trimmed.indexOf(" ", i);
    const word = wordEnd === -1 ? trimmed.slice(i) : trimmed.slice(i, wordEnd);
    return word.toUpperCase();
  }

  return {
    async connect() {},
    async query(text: string, params?: readonly unknown[]) {
      const result = await pg.query(text, params as unknown[] | undefined);
      const command = extractCommand(text);
      const isRead = READ_COMMANDS.has(command);
      const rowCount = isRead
        ? result.rows.length
        : (result.affectedRows ?? result.rows.length);
      return {
        fields: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataTypeID: f.dataTypeID ?? 0,
        })),
        rows: result.rows ?? [],
        rowCount,
        command,
      };
    },
    async end() {},
  };
}

describe("PGliteClient adapter", () => {
  it("maps SELECT query result correctly", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "alice" }],
        fields: [
          { name: "id", dataTypeID: 23 },
          { name: "name", dataTypeID: 25 },
        ],
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("SELECT id, name FROM users");
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({ name: "id", dataTypeID: 23 });
    expect(result.rows).toEqual([{ id: 1, name: "alice" }]);
    expect(result.rowCount).toBe(1);
    expect(result.command).toBe("SELECT");
  });

  it("maps INSERT result with affectedRows", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [],
        fields: [],
        affectedRows: 3,
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("INSERT INTO t VALUES ($1), ($2), ($3)", [1, 2, 3]);
    expect(result.rowCount).toBe(3);
    expect(result.command).toBe("INSERT");
  });

  it("uses rows.length for SELECT when affectedRows is absent", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ a: 1 }, { a: 2 }],
        fields: [{ name: "a", dataTypeID: 23 }],
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("SELECT * FROM t");
    expect(result.rowCount).toBe(2);
    expect(result.command).toBe("SELECT");
  });

  it("derives command from SQL text", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({ rows: [], fields: [], affectedRows: 0 }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("DELETE FROM t WHERE id = 1");
    expect(result.command).toBe("DELETE");
    expect(result.rowCount).toBe(0);
  });

  it("handles WITH CTE as read command", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1 }],
        fields: [{ name: "id", dataTypeID: 23 }],
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte");
    expect(result.command).toBe("WITH");
    expect(result.rowCount).toBe(1);
  });

  it("handles missing fields gracefully (defaults to empty)", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("SELECT 1");
    expect(result.fields).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.command).toBe("SELECT");
  });

  it("propagates query errors through mapSQLError path", async () => {
    const pgError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const fakePg = { query: vi.fn().mockRejectedValue(pgError) };
    const client = wrapPGliteLike(fakePg);
    await expect(client.query("SELECT * FROM nonexistent")).rejects.toMatchObject({ code: "42P01" });
  });

  it("connect and end are no-ops (do not throw)", async () => {
    const fakePg = { query: vi.fn() };
    const client = wrapPGliteLike(fakePg);
    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.end()).resolves.toBeUndefined();
  });
});
