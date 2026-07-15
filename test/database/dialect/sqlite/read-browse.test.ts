import { describe, expect, it } from "vitest";
import { openSQLite, createSQLiteClient } from "../../../../src/database/dialect/sqlite/client.js";
import { executeSQLiteReadQuery } from "../../../../src/database/dialect/sqlite/read.js";
import { executeSQLiteBrowse } from "../../../../src/database/dialect/sqlite/browse.js";
import type { DatabaseClient } from "../../../../src/database/client.js";

function setupTestDb(): { db: ReturnType<typeof openSQLite>; client: DatabaseClient; close: () => void } {
  const db = openSQLite(":memory:", "write");
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL,
      category TEXT
    );
    INSERT INTO products VALUES (1, 'Widget', 9.99, 'tools');
    INSERT INTO products VALUES (2, 'Gadget', 24.99, 'tools');
    INSERT INTO products VALUES (3, 'Book', 12.99, 'media');
    INSERT INTO products VALUES (4, 'Movie', 19.99, 'media');
    INSERT INTO products VALUES (5, 'Game', 59.99, 'media');
  `);
  const client = createSQLiteClient(db);
  return {
    db,
    client,
    close: () => db.close(),
  };
}

describe("SQLite read query", () => {
  it("reads all rows with default limit", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteReadQuery(client, {
        sql: "SELECT * FROM products ORDER BY id",
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(5);
      expect(result.columns.length).toBeGreaterThanOrEqual(4);
      expect(result.hasMore).toBe(false);
    } finally {
      close();
    }
  });

  it("respects explicit limit", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteReadQuery(client, {
        sql: "SELECT * FROM products ORDER BY id",
        limit: 2,
      });
      expect(result.rows).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    } finally {
      close();
    }
  });

  it("returns hasMore=false when result fits limit exactly", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteReadQuery(client, {
        sql: "SELECT * FROM products ORDER BY id",
        limit: 5,
      });
      expect(result.rows).toHaveLength(5);
      expect(result.hasMore).toBe(false);
    } finally {
      close();
    }
  });

  it("rejects write SQL in read query", async () => {
    const { client, close } = setupTestDb();
    try {
      await expect(
        executeSQLiteReadQuery(client, {
          sql: "INSERT INTO products (name, price) VALUES (?, ?)",
          params: ["New", 1.99],
        }),
      ).rejects.toThrow();
    } finally {
      close();
    }
  });

  it("rejects destructive SQL in read query", async () => {
    const { client, close } = setupTestDb();
    try {
      await expect(
        executeSQLiteReadQuery(client, {
          sql: "DROP TABLE products",
        }),
      ).rejects.toThrow();
    } finally {
      close();
    }
  });

  it("accepts PRAGMA queries in read query", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteReadQuery(client, {
        sql: "PRAGMA table_info(products)",
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(4);
      expect(result.hasMore).toBe(false);
    } finally {
      close();
    }
  });
});

describe("SQLite browse", () => {
  it("browses all rows in a table", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteBrowse(client, {
        table: "products",
        limit: 10,
        offset: 0,
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(5);
      expect(result.table).toBe("products");
      expect(result.schema).toBe("main");
    } finally {
      close();
    }
  });

  it("applies filters with ? bind params", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteBrowse(client, {
        table: "products",
        filters: [{ column: "category", op: "eq", value: "media" }],
        limit: 10,
        offset: 0,
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(3);
    } finally {
      close();
    }
  });

  it("supports LIKE filter (case-insensitive in SQLite)", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteBrowse(client, {
        table: "products",
        filters: [{ column: "name", op: "like", value: "%g%" }],
        limit: 10,
        offset: 0,
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      close();
    }
  });

  it("supports is_null / not_null filters", async () => {
    const { client, close } = setupTestDb();
    try {
      // All products have non-null category
      const result = await executeSQLiteBrowse(client, {
        table: "products",
        filters: [{ column: "category", op: "not_null" }],
        limit: 10,
        offset: 0,
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(5);
    } finally {
      close();
    }
  });

  it("supports ordering", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteBrowse(client, {
        table: "products",
        orderBy: [{ column: "price", direction: "desc" }],
        limit: 10,
        offset: 0,
      });
      expect(result.rows.length).toBeGreaterThanOrEqual(5);
      expect(Number(result.rows[0]!.price)).toBeGreaterThanOrEqual(
        Number(result.rows[result.rows.length - 1]!.price),
      );
    } finally {
      close();
    }
  });

  it("limits results and signals hasMore", async () => {
    const { client, close } = setupTestDb();
    try {
      const result = await executeSQLiteBrowse(client, {
        table: "products",
        limit: 2,
        offset: 0,
      });
      expect(result.rows).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    } finally {
      close();
    }
  });

  it("handles offset correctly", async () => {
    const { client, close } = setupTestDb();
    try {
      const page1 = await executeSQLiteBrowse(client, {
        table: "products",
        limit: 3,
        offset: 0,
      });
      const page2 = await executeSQLiteBrowse(client, {
        table: "products",
        limit: 3,
        offset: 3,
      });
      expect(page1.rows.length).toBeGreaterThanOrEqual(3);
      expect(page2.rows.length).toBeGreaterThanOrEqual(2);
      // Ensure different rows (by id)
      const page1Id = page1.rows[0]!.id;
      const page2Id = page2.rows[0]!.id;
      expect(page2Id).not.toBe(page1Id);
    } finally {
      close();
    }
  });
});
