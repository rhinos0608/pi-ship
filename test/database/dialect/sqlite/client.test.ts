import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  openSQLite,
  createSQLiteClient,
} from "../../../../src/database/dialect/sqlite/client.js";

describe("SQLite client", () => {
  describe("openSQLite", () => {
    it("opens in-memory database in read-write mode", () => {
      const db = openSQLite(":memory:", "write");
      expect(db).toBeInstanceOf(DatabaseSync);
      db.close();
    });

    it("opens in-memory database in read-only mode", () => {
      const db = openSQLite(":memory:", "read");
      expect(db).toBeInstanceOf(DatabaseSync);
      db.close();
    });

    it("read-only mode blocks write queries via client", async () => {
      const db = openSQLite(":memory:", "read");
      const client = createSQLiteClient(db);
      await expect(
        client.query("CREATE TABLE t (x INTEGER)"),
      ).rejects.toThrow();
      db.close();
    });

    it("read-only mode allows SELECT queries", async () => {
      // Write first, then read
      const writeDb = openSQLite(":memory:", "write");
      writeDb.exec("CREATE TABLE t (x INTEGER)");
      writeDb.exec("INSERT INTO t (x) VALUES (42)");
      writeDb.close();

      // Open same db path — doesn't work for in-memory, so use a temp test
      const db = openSQLite(":memory:", "read");
      const client = createSQLiteClient(db);
      // The table doesn't exist in this new :memory: db, just test read query works
      const result = await client.query("SELECT 1 as val");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty("val");
      db.close();
    });

    it("write mode client can insert and select", async () => {
      const db = openSQLite(":memory:", "write");
      const client = createSQLiteClient(db);

      await client.query("CREATE TABLE items (id INTEGER, name TEXT)");
      await client.query("INSERT INTO items (id, name) VALUES (?, ?)", [
        1,
        "test",
      ]);

      const result = await client.query("SELECT * FROM items");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ id: 1, name: "test" });
      db.close();
    });

    it("returns query result with fields, rows, rowCount, and command", async () => {
      const db = openSQLite(":memory:", "write");
      const client = createSQLiteClient(db);

      await client.query("CREATE TABLE t (x INTEGER)");
      const insertResult = await client.query(
        "INSERT INTO t (x) VALUES (?)",
        [99],
      );
      expect(insertResult).toHaveProperty("fields");
      expect(insertResult).toHaveProperty("rows");
      expect(insertResult.rowCount).toBe(1);
      expect(insertResult.command).toBe("INSERT");

      const selectResult = await client.query("SELECT * FROM t");
      expect(selectResult.fields.length).toBeGreaterThan(0);
      expect(selectResult.rows).toHaveLength(1);
      expect(selectResult.rowCount).toBe(1);
      expect(selectResult.command).toBe("SELECT");

      db.close();
    });
  });

  describe("setAuthorizer deny-list", () => {
    it("write connection rejects ATTACH DATABASE", () => {
      const db = openSQLite(":memory:", "write");
      expect(() => db.prepare("ATTACH DATABASE ':memory:' AS attached")).toThrow();
      db.close();
    });

    it("write connection rejects DETACH DATABASE", () => {
      const db = openSQLite(":memory:", "write");
      expect(() => db.prepare("DETACH DATABASE attached")).toThrow();
      db.close();
    });

    it("write connection rejects write PRAGMA", () => {
      const db = openSQLite(":memory:", "write");
      expect(() => db.prepare("PRAGMA journal_mode = WAL")).toThrow();
      db.close();
    });

    it("write connection accepts INSERT and CREATE", async () => {
      const db = openSQLite(":memory:", "write");
      const client = createSQLiteClient(db);
      await expect(client.query("CREATE TABLE t (x INTEGER)")).resolves.toBeDefined();
      await expect(client.query("INSERT INTO t (x) VALUES (?)", [42])).resolves.toBeDefined();
      db.close();
    });

    it("write connection accepts SELECT", async () => {
      const db = openSQLite(":memory:", "write");
      const client = createSQLiteClient(db);
      await expect(client.query("SELECT 1")).resolves.toBeDefined();
      db.close();
    });
  });

  describe("createSQLiteClient lifecycle", () => {
    it("connect resolves without error", async () => {
      const db = openSQLite(":memory:", "write");
      const client = createSQLiteClient(db);
      await expect(client.connect()).resolves.toBeUndefined();
      db.close();
    });

    it("end closes the database", async () => {
      const db = openSQLite(":memory:", "write");
      const client = createSQLiteClient(db);
      await client.end();
      // After close, query should fail
      await expect(client.query("SELECT 1")).rejects.toThrow();
    });
  });
});
