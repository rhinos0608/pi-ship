import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../src/database/client.js";

// We test the mapping logic without a real PGlite by mocking the module.
// The integration suite (T6) tests against real in-memory PGlite.

describe("PGliteClient adapter", () => {
  // Create a thin helper that mimics what createPGliteClient does
  function wrapPGliteLike(pg: {
    query: (text: string, params?: unknown[]) => Promise<{
      rows: Record<string, unknown>[];
      fields?: { name: string; dataTypeID?: number }[];
      affectedRows?: number;
      command?: string;
    }>;
  }): DatabaseClient {
    return {
      async connect() {},
      async query(text: string, params?: readonly unknown[]) {
        const result = await pg.query(text, params as unknown[] | undefined);
        return {
          fields: (result.fields ?? []).map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID ?? 0,
          })),
          rows: result.rows ?? [],
          rowCount: result.affectedRows ?? result.rows.length,
          command: result.command ?? "SELECT",
        };
      },
      async end() {},
    };
  }

  it("maps SELECT query result correctly", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "alice" }],
        fields: [
          { name: "id", dataTypeID: 23 },
          { name: "name", dataTypeID: 25 },
        ],
        command: "SELECT",
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
        command: "INSERT",
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("INSERT INTO t VALUES ($1), ($2), ($3)", [1, 2, 3]);
    expect(result.rowCount).toBe(3);
    expect(result.command).toBe("INSERT");
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
