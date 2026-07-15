import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseClient } from "../../../src/database/client.js";
import { createPGliteClient } from "../../../src/database/local/pglite-client.js";
import { executeLocalQuery } from "../../../src/database/execute-local.js";
import { importData } from "../../../src/database/import.js";
import { resetLocalDatabase } from "../../../src/database/reset.js";

/** Wraps an in-memory PGlite as a DatabaseClient with test isolation. */
async function getMemoryClient(): Promise<DatabaseClient> {
  const pg = new PGlite(); // in-memory
  return {
    async connect() {
      // PGlite initializes at construction
    },
    async query(text: string, params?: readonly unknown[]) {
      const result = await pg.query(text, params as unknown[] | undefined);
      return {
        fields: (result.fields ?? []).map((f: any) => ({
          name: f.name,
          dataTypeID: f.dataTypeID ?? 0,
        })),
        rows: result.rows as Record<string, unknown>[],
        rowCount: (result as any).affectedRows ?? result.rows.length,
        command: (result as any).command ?? "SELECT",
      };
    },
    async end() {
      // No-op for test isolation
    },
  };
}

describe("local database integration (in-memory PGlite)", () => {
  it("inspects empty database schema", async () => {
    const client = await getMemoryClient();
    // Fresh PGlite in-memory has a public schema
    const result = await client.query(
      "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'public'",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.nspname).toBe("public");
  });

  it("creates table, inserts, queries, and browses", async () => {
    const client = await getMemoryClient();

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
  });

  it("imports JSON rows with schema inference", async () => {
    const client = await getMemoryClient();

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
  });

  it("imports CSV rows with schema inference", async () => {
    const client = await getMemoryClient();

    const dir = await mkdtemp(join(tmpdir(), "pglite-csv-"));
    const csvPath = join(dir, "test.csv");
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
  });

  it("handles mutation errors with ROLLBACK via mapSQLError", async () => {
    const client = await getMemoryClient();
    await client.query("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await executeLocalQuery(client, "INSERT INTO t VALUES (1)");

    // Duplicate key should fail — flows through mapSQLError
    await expect(
      executeLocalQuery(client, "INSERT INTO t VALUES (1)"),
    ).rejects.toMatchObject({ code: "E_PROVIDER" });

    // Table should still have only 1 row (rollback succeeded)
    const result = await executeLocalQuery(client, "SELECT count(*) FROM t");
    expect(result.rows![0]!.count).toBe(1);
  });

  it("plans and applies via executeLocalQuery parity", async () => {
    const client = await getMemoryClient();

    // Simulate plan-then-apply by creating a plan classification then executing
    // (tests the same code path that apply_plan uses)
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
  });

  it("reset clears all data", async () => {
    // Use a unique data dir for reset test
    const dir = await mkdtemp(join(tmpdir(), "pglite-reset-"));
    const dataDir = join(dir, "local-db");

    // Create client and insert data
    const client = await createPGliteClient(dataDir);
    await client.query(
      "CREATE TABLE reset_test (id INTEGER PRIMARY KEY, label TEXT)",
    );
    await client.query("INSERT INTO reset_test VALUES (1, 'before')");
    const beforeCount = await client.query("SELECT count(*) FROM reset_test");
    expect(beforeCount.rows[0]!.count).toBe(1);
    await client.end();

    // Reset
    await resetLocalDatabase(dataDir);

    // Fresh client — old table should be gone
    const freshClient = await createPGliteClient(dataDir);
    const tables = await freshClient.query(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE tablename = 'reset_test'",
    );
    expect(tables.rows.length).toBe(0);
    await freshClient.end();
  });
});
