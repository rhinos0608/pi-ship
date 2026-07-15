import { describe, expect, it, vi } from "vitest";
import { openSQLite, createSQLiteClient } from "../../../../src/database/dialect/sqlite/client.js";
import { importData, sqliteImportDialect } from "../../../../src/database/import.js";
import type { DatabaseClient, DatabaseQueryResult } from "../../../../src/database/client.js";

describe("SQLite real import", () => {
  it("creates table and imports rows using ? placeholders", async () => {
    const db = openSQLite(":memory:", "write");
    const client = createSQLiteClient(db);

    const result = await importData(
      client,
      {
        table: "widgets",
        format: "json",
        rows: [
          { id: 1, name: "Widget A", price: 9.99 },
          { id: 2, name: "Widget B", price: 19.99 },
        ],
      },
      undefined,
      sqliteImportDialect,
    );

    expect(result.table).toBe("widgets");
    expect(result.rowsImported).toBe(2);
    expect(result.created).toBe(true);

    // Verify rows were inserted
    const queryResult = await client.query("SELECT * FROM widgets ORDER BY id");
    expect(queryResult.rows).toHaveLength(2);
    expect(queryResult.rows[0]).toMatchObject({ id: 1, name: "Widget A" });
    expect(queryResult.rows[1]).toMatchObject({ id: 2, name: "Widget B" });

    db.close();
  });

  it("stores objects as JSON strings in TEXT columns", async () => {
    const db = openSQLite(":memory:", "write");
    const client = createSQLiteClient(db);

    await importData(
      client,
      {
        table: "config",
        format: "json",
        rows: [{ key: "theme", meta: { dark: true } }],
      },
      undefined,
      sqliteImportDialect,
    );

    const result = await client.query("SELECT * FROM config");
    expect(result.rows).toHaveLength(1);
    // meta should be stored as JSON string
    const meta = result.rows[0]!.meta;
    expect(typeof meta).toBe("string");
    const parsed = JSON.parse(meta as string);

    db.close();
  });

  it("infers INTEGER for boolean values", async () => {
    const db = openSQLite(":memory:", "write");
    const client = createSQLiteClient(db);

    await importData(
      client,
      {
        table: "flags",
        format: "json",
        rows: [{ active: true, count: 42 }],
      },
      undefined,
      sqliteImportDialect,
    );

    const result = await client.query("SELECT * FROM flags");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.active).toBe(1); // SQLite stores TRUE as 1
    expect(result.rows[0]!.count).toBe(42);

    db.close();
  });

  it("infers REAL for non-integer numbers", async () => {
    const db = openSQLite(":memory:", "write");
    const client = createSQLiteClient(db);

    await importData(
      client,
      {
        table: "prices",
        format: "json",
        rows: [{ price: 19.99, discount: 0.1 }],
      },
      undefined,
      sqliteImportDialect,
    );

    const result = await client.query("SELECT * FROM prices");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.price).toBeCloseTo(19.99);
    expect(result.rows[0]!.discount).toBeCloseTo(0.1);

    db.close();
  });

  it("appends to existing table with append mode", async () => {
    const db = openSQLite(":memory:", "write");
    const client = createSQLiteClient(db);

    // Create table first
    await importData(
      client,
      {
        table: "items",
        format: "json",
        rows: [{ id: 1, label: "first" }],
      },
      undefined,
      sqliteImportDialect,
    );

    // Append
    const result = await importData(
      client,
      {
        table: "items",
        format: "json",
        rows: [{ id: 2, label: "second" }],
        mode: "append",
      },
      undefined,
      sqliteImportDialect,
    );

    expect(result.table).toBe("items");
    expect(result.rowsImported).toBe(1);
    expect(result.created).toBe(false);

    const queryResult = await client.query("SELECT * FROM items ORDER BY id");
    expect(queryResult.rows).toHaveLength(2);

    db.close();
  });
});

describe("SQLite import dialect contract", () => {
  it("sqliteImportDialect uses ? placeholder for all indices", () => {
    expect(sqliteImportDialect.placeholder(0)).toBe("?");
    expect(sqliteImportDialect.placeholder(5)).toBe("?");
    expect(sqliteImportDialect.placeholder(99)).toBe("?");
  });

  it("sqliteImportDialect infers types correctly", () => {
    expect(sqliteImportDialect.inferredType(null)).toBe("TEXT");
    expect(sqliteImportDialect.inferredType(true)).toBe("INTEGER");
    expect(sqliteImportDialect.inferredType(42)).toBe("INTEGER");
    expect(sqliteImportDialect.inferredType(3.14)).toBe("REAL");
    expect(sqliteImportDialect.inferredType("hello")).toBe("TEXT");
    expect(sqliteImportDialect.inferredType({ a: 1 })).toBe("TEXT");
    expect(sqliteImportDialect.inferredType([1, 2])).toBe("TEXT");
  });

  it("sqliteImportDialect serializes objects as JSON strings", () => {
    expect(sqliteImportDialect.serializeValue({ x: 1 }, "TEXT")).toBe(
      '{"x":1}',
    );
    expect(sqliteImportDialect.serializeValue("hello", "TEXT")).toBe("hello");
    expect(sqliteImportDialect.serializeValue(42, "INTEGER")).toBe(42);
    expect(sqliteImportDialect.serializeValue(null, "TEXT")).toBe(null);
    expect(sqliteImportDialect.serializeValue(undefined, "TEXT")).toBe(null);
  });
});
