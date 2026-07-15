import { describe, expect, it } from "vitest";
import { openSQLite, createSQLiteClient } from "../../../../src/database/dialect/sqlite/client.js";
import { inspectSQLite } from "../../../../src/database/dialect/sqlite/inspect.js";

async function setupTestDb() {
  const db = openSQLite(":memory:", "write");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE
    );
    CREATE INDEX idx_users_name ON users(name);
    INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@test.com');
    INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@test.com');
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      total REAL,
      created_at TEXT
    );
  `);
  const client = createSQLiteClient(db);
  return { db, client };
}

describe("SQLite inspect", () => {
  it("returns InspectResult shape with schemas", async () => {
    const { db, client } = await setupTestDb();
    try {
      const result = await inspectSQLite(client);
      expect(result).toHaveProperty("schemas");
      expect(result).toHaveProperty("relations");
      expect(result).toHaveProperty("columns");
      expect(result).toHaveProperty("indexes");
      expect(result).toHaveProperty("enums");
      expect(result).toHaveProperty("constraints");
      expect(result).toHaveProperty("triggers");
      expect(result).toHaveProperty("policies");
      expect(result).toHaveProperty("truncatedCategories");

      // Schemas
      expect(result.schemas).toEqual([{ name: "main", owner: undefined }]);
    } finally {
      db.close();
    }
  });

  it("lists tables and views as relations", async () => {
    const { db, client } = await setupTestDb();
    try {
      const result = await inspectSQLite(client);
      expect(result.relations.length).toBeGreaterThanOrEqual(2);
      const tableNames = result.relations.map((r) => r.name).sort();
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("orders");
      expect(tableNames.every((r) => r.length > 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("maps columns with types and nullability", async () => {
    const { db, client } = await setupTestDb();
    try {
      const result = await inspectSQLite(client);
      const userCols = result.columns.filter((c) => c.table === "users");
      expect(userCols.length).toBeGreaterThanOrEqual(3);

      const idCol = userCols.find((c) => c.name === "id");
      expect(idCol).toBeTruthy();
      expect(idCol!.isIdentity).toBe(true); // INTEGER PRIMARY KEY
      // SQLite's pragma_table_info reports notnull=0 for INTEGER PRIMARY KEY
      // (rowid alias), so nullable is true
      expect(idCol!.type).toBe("INTEGER");

      const nameCol = userCols.find((c) => c.name === "name");
      expect(nameCol).toBeTruthy();
      expect(nameCol!.nullable).toBe(false); // NOT NULL

      const emailCol = userCols.find((c) => c.name === "email");
      expect(emailCol).toBeTruthy();
      expect(emailCol!.nullable).toBe(true); // no NOT NULL
    } finally {
      db.close();
    }
  });

  it("lists indexes with columns", async () => {
    const { db, client } = await setupTestDb();
    try {
      const result = await inspectSQLite(client);
      const userIndexes = result.indexes.filter((i) => i.table === "users");
      // INTEGER PRIMARY KEY (rowid alias) does not create an explicit index entry in SQLite.
      // So we should still find at least the unique index on email.
      expect(userIndexes.length).toBeGreaterThanOrEqual(1);

      const nameIndex = userIndexes.find((i) => i.name === "idx_users_name");
      expect(nameIndex).toBeTruthy();
      expect(nameIndex!.columns).toContain("name");
      expect(nameIndex!.unique).toBe(false);
    } finally {
      db.close();
    }
  });

  it("maps foreign keys as constraints", async () => {
    const { db, client } = await setupTestDb();
    try {
      const result = await inspectSQLite(client);
      const orderConstraints = result.constraints.filter(
        (c) => c.table === "orders",
      );
      expect(orderConstraints.length).toBeGreaterThanOrEqual(1);

      const fk = orderConstraints[0]!;
      expect(fk.type).toBe("foreign_key");
      expect(fk.refTable).toBe("users");
      expect(fk.deferrable).toBe(false);
      expect(fk.deferred).toBe(false);
    } finally {
      db.close();
    }
  });

  it("returns empty arrays for PG-only categories", async () => {
    const { db, client } = await setupTestDb();
    try {
      const result = await inspectSQLite(client);
      expect(result.enums).toEqual([]);
      expect(result.triggers).toEqual([]);
      expect(result.policies).toEqual([]);
    } finally {
      db.close();
    }
  });
});
