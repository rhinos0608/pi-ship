import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabaseQueryResult } from "../../src/database/client.js";
import { importData, sqliteImportDialect } from "../../src/database/import.js";

function makeImportClient(opts?: {
  queryError?: Error;
  queryLog?: { text: string; params?: unknown[] }[];
}): DatabaseClient {
  const log = opts?.queryLog ?? [];
  return {
    connect: vi.fn(),
    query: vi.fn(async (text: string, params?: readonly unknown[]) => {
      log.push({ text, params: params ? [...params] : undefined });
      if (opts?.queryError) throw opts.queryError;
      return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
    }),
    end: vi.fn(),
  };
}

describe("importData", () => {
  it("infers schema and creates table on first import", async () => {
    const log: { text: string }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string) => {
        log.push({ text });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    await importData(client, {
      table: "users",
      format: "json",
      rows: [
        { name: "alice", age: 30, active: true },
        { name: "bob", age: 25, active: false },
      ],
    });

    const createSQL = log.find((l) => l.text.startsWith("CREATE TABLE"));
    expect(createSQL).toBeTruthy();
    expect(createSQL!.text).toContain('"users"');
    expect(createSQL!.text).toContain("TEXT"); // name → TEXT
    expect(createSQL!.text).toContain("BIGINT"); // age → BIGINT
    expect(createSQL!.text).toContain("BOOLEAN"); // active → BOOLEAN

    const insertSQL = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertSQL).toBeTruthy();
  });

  it("inserts all rows in a single batch when under 100", async () => {
    const log: { text: string; params?: unknown[] }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        log.push({ text, params: params ? [...params] : undefined });
        return { fields: [], rows: [], rowCount: 3, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    const result = await importData(client, {
      table: "items",
      format: "json",
      rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
    });

    expect(result.rowsImported).toBe(3);
    expect(result.created).toBe(true);

    const insertCall = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertCall).toBeTruthy();
    const valueGroupCount = (insertCall!.text.match(/\)\s*,\s*\(/g) || []).length + 1;
    expect(valueGroupCount).toBe(3); // all 3 rows in one INSERT
  });

  it("handles JSONB columns for objects and arrays", async () => {
    const log: { text: string; params?: unknown[] }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        log.push({ text, params: params ? [...params] : undefined });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    await importData(client, {
      table: "config",
      format: "json",
      rows: [{
        key: "main",
        value: { nested: true, list: [1, 2, 3] },
        tags: ["a", "b"],
      }],
    });

    const insertCall = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertCall).toBeTruthy();
    // value and tags should be JSON-stringified
    const params = insertCall!.params;
    expect(params).toBeTruthy();
    expect(params!.some((p) => typeof p === "string" && p.startsWith("{"))).toBe(true);
  });

  it("preserves null in JSONB-inferred column while stringifying objects", async () => {
    // First row has an object → column inferred as JSONB.
    // Second row has null for the same column — must reach serializeValue's value ?? null fallback.
    const log: { text: string; params?: unknown[] }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        log.push({ text, params: params ? [...params] : undefined });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    await importData(client, {
      table: "settings",
      format: "json",
      rows: [
        { name: "theme", payload: { color: "dark" } },
        { name: "legacy", payload: null },
      ],
    });

    const insertCall = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertCall).toBeTruthy();
    const params = insertCall!.params!;
    // Columns: [name, payload]; types: [TEXT, JSONB]
    // Row 0: name="theme" (TEXT → "theme"), payload={color:"dark"} (JSONB → JSON.stringify)
    expect(params[1]).toBe(JSON.stringify({ color: "dark" }));
    // Row 1: name="legacy" (TEXT → "legacy"), payload=null (JSONB → null via value ?? null)
    expect(params[3]).toBe(null);
  });

  it("rejects invalid table identifier", async () => {
    const client = makeImportClient();
    await expect(
      importData(client, { table: "", format: "json", rows: [{ x: 1 }] }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects empty rows", async () => {
    const client = makeImportClient();
    await expect(
      importData(client, { table: "t", format: "json", rows: [] }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects both rows and path", async () => {
    const client = makeImportClient();
    await expect(
      importData(client, { table: "t", format: "json", rows: [{ x: 1 }], path: "/tmp/data.json" }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("respects append mode (no CREATE TABLE)", async () => {
    const log: { text: string }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string) => {
        log.push({ text });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    const result = await importData(client, {
      table: "existing",
      format: "json",
      mode: "append",
      rows: [{ col: "val" }],
    });

    expect(result.created).toBe(false);
    expect(log.find((l) => l.text.startsWith("CREATE TABLE"))).toBeUndefined();
    expect(log.find((l) => l.text.startsWith("INSERT INTO"))).toBeTruthy();
  });

  it("rejects > 5000 rows", async () => {
    const client = makeImportClient();
    const rows = Array.from({ length: 5001 }, (_, i) => ({ n: i }));
    await expect(
      importData(client, { table: "t", format: "json", rows }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // ── SQLite import dialect tests ────────────────────────────

  describe("sqliteImportDialect", () => {
    it("uses ? placeholders instead of $n", async () => {
      const log: { text: string; params?: unknown[] }[] = [];
      const client: DatabaseClient = {
        connect: vi.fn(),
        query: vi.fn(async (text: string, params?: readonly unknown[]) => {
          log.push({ text, params: params ? [...params] : undefined });
          return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
        }),
        end: vi.fn(),
      };

      await importData(client, {
        table: "items",
        format: "json",
        rows: [{ x: 1, y: "hello" }],
      }, undefined, sqliteImportDialect);

      const createSQL = log.find((l) => l.text.startsWith("CREATE TABLE"));
      expect(createSQL).toBeTruthy();
      expect(createSQL!.text).toContain("INTEGER");
      expect(createSQL!.text).toContain("TEXT");

      const insertSQL = log.find((l) => l.text.startsWith("INSERT INTO"));
      expect(insertSQL).toBeTruthy();
      // SQLite uses ? placeholders
      expect(insertSQL!.text).toContain("?");
      expect(insertSQL!.text).not.toContain("$1");
    });

    it("serializes objects as TEXT (JSON strings)", async () => {
      const log: { text: string; params?: unknown[] }[] = [];
      const client: DatabaseClient = {
        connect: vi.fn(),
        query: vi.fn(async (text: string, params?: readonly unknown[]) => {
          log.push({ text, params: params ? [...params] : undefined });
          return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
        }),
        end: vi.fn(),
      };

      await importData(client, {
        table: "config",
        format: "json",
        rows: [{ key: "main", value: { nested: true } }],
      }, undefined, sqliteImportDialect);

      const createSQL = log.find((l) => l.text.startsWith("CREATE TABLE"));
      expect(createSQL).toBeTruthy();
      expect(createSQL!.text).toContain("TEXT"); // object → TEXT in SQLite dialect

      const insertSQL = log.find((l) => l.text.startsWith("INSERT INTO"));
      expect(insertSQL).toBeTruthy();
      const params = insertSQL!.params;
      expect(params).toBeTruthy();
      // value column should be JSON-stringified
      const valueParam = params!.find((p) => typeof p === "string" && p.includes("nested"));
      expect(valueParam).toBeTruthy();
    });

    it("infers INTEGER for booleans and whole numbers", async () => {
      const log: { text: string }[] = [];
      const client: DatabaseClient = {
        connect: vi.fn(),
        query: vi.fn(async (text: string) => {
          log.push({ text });
          return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
        }),
        end: vi.fn(),
      };

      await importData(client, {
        table: "test",
        format: "json",
        rows: [{ flag: true, count: 42 }],
      }, undefined, sqliteImportDialect);

      const createSQL = log.find((l) => l.text.startsWith("CREATE TABLE"));
      expect(createSQL).toBeTruthy();
      expect(createSQL!.text).toContain("INTEGER"); // both boolean and safe integer
    });

    it("infers REAL for non-integer numbers", async () => {
      const log: { text: string }[] = [];
      const client: DatabaseClient = {
        connect: vi.fn(),
        query: vi.fn(async (text: string) => {
          log.push({ text });
          return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
        }),
        end: vi.fn(),
      };

      await importData(client, {
        table: "test",
        format: "json",
        rows: [{ price: 19.99 }],
      }, undefined, sqliteImportDialect);

      const createSQL = log.find((l) => l.text.startsWith("CREATE TABLE"));
      expect(createSQL).toBeTruthy();
      expect(createSQL!.text).toContain("REAL");
    });
  });
});
