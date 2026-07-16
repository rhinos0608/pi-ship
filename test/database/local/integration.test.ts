import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseClient } from "../../../src/database/client.js";
import { createPGliteClient } from "../../../src/database/local/pglite-client.js";
import { executeLocalQuery } from "../../../src/database/execute-local.js";
import { importData } from "../../../src/database/import.js";
import { resetLocalDatabase } from "../../../src/database/reset.js";

describe("local database integration (PGlite)", () => {
  it("inspects empty database schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-int-"));
    const client = await createPGliteClient(dir);
    try {
      const result = await client.query(
        "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'public'",
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.nspname).toBe("public");
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("creates table, inserts, queries, and browses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-int-"));
    const client = await createPGliteClient(dir);
    try {
      // Create table
      await client.query(
        "CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)",
      );

      // Insert via executeLocalQuery
      const insertResult = await executeLocalQuery(
        client,
        "INSERT INTO test (name) VALUES ($1)",
        ["alice"],
      );
      expect(insertResult.rowCount).toBe(1);

      // Read query via executeLocalQuery
      const queryResult = await executeLocalQuery(client, "SELECT * FROM test");
      expect(queryResult.kind).toBe("read");
      expect(queryResult.rows).toHaveLength(1);
      expect(queryResult.rows![0]!.name).toBe("alice");
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("imports JSON rows with schema inference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-int-"));
    const client = await createPGliteClient(dir);
    try {
      const result = await importData(client, {
        table: "imported",
        format: "json",
        rows: [
          { name: "item1", count: 5, active: true },
          { name: "item2", count: 3, active: false },
        ],
      });

      expect(result.rowsImported).toBe(2);
      expect(result.created).toBe(true);

      const query = await executeLocalQuery(client, "SELECT * FROM imported");
      expect(query.rows).toHaveLength(2);
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("imports CSV rows with schema inference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-int-"));
    const client = await createPGliteClient(dir);
    const csvDir = await mkdtemp(join(tmpdir(), "pglite-csv-"));
    try {
      const csvPath = join(csvDir, "test.csv");
      await writeFile(csvPath, "name,value\nfoo,10\nbar,20\n");

      const result = await importData(client, {
        table: "csv_import",
        format: "csv",
        path: csvPath,
      });

      expect(result.rowsImported).toBe(2);
      expect(result.created).toBe(true);

      const query = await executeLocalQuery(client, "SELECT * FROM csv_import");
      expect(query.rows).toHaveLength(2);
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await rm(csvDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("handles mutation errors with ROLLBACK via mapSQLError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-int-"));
    const client = await createPGliteClient(dir);
    try {
      await client.query("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      await executeLocalQuery(client, "INSERT INTO t VALUES (1)");

      // Duplicate key should fail — flows through mapSQLError
      await expect(
        executeLocalQuery(client, "INSERT INTO t VALUES (1)"),
      ).rejects.toMatchObject({ code: "E_PROVIDER" });

      // Table should still have only 1 row (rollback succeeded)
      const result = await executeLocalQuery(client, "SELECT count(*) FROM t");
      expect(result.rows![0]!.count).toBe(1);
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("plans and applies via executeLocalQuery parity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-int-"));
    const client = await createPGliteClient(dir);
    try {
      await client.query("CREATE TABLE plan_test (id INT PRIMARY KEY, val TEXT)");
      const execResult = await executeLocalQuery(
        client,
        "INSERT INTO plan_test (id, val) VALUES ($1, $2)",
        [1, "planned"],
      );
      expect(execResult.rowCount).toBe(1);

      const readResult = await executeLocalQuery(
        client,
        "SELECT * FROM plan_test WHERE id = $1",
        [1],
      );
      expect(readResult.kind).toBe("read");
      expect(readResult.rows).toHaveLength(1);
      expect(readResult.rows![0]!.val).toBe("planned");
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("reset clears all data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pglite-reset-"));
    const dataDir = join(dir, "local-db");

    // Create client and insert data
    const client = await createPGliteClient(dataDir);
    try {
      await client.query(
        "CREATE TABLE reset_test (id INTEGER PRIMARY KEY, label TEXT)",
      );
      await client.query("INSERT INTO reset_test VALUES (1, 'before')");
      const beforeCount = await client.query("SELECT count(*) FROM reset_test");
      expect(beforeCount.rows[0]!.count).toBe(1);
    } finally {
      await client.end();
    }

    // Reset
    await resetLocalDatabase(dataDir);

    // Fresh client — old table should be gone
    const freshClient = await createPGliteClient(dataDir);
    try {
      const tables = await freshClient.query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE tablename = 'reset_test'",
      );
      expect(tables.rows.length).toBe(0);
    } finally {
      await freshClient.end();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
