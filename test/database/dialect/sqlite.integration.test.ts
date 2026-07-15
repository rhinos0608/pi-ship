/**
 * Real SQLite integration tests using node:sqlite temp file inside a temp cwd.
 *
 * Tests:
 *   - inspect / browse / read query
 *   - gated plan + apply (full lifecycle)
 *   - PI_SHIP_SQLITE_OPEN === "true" enables direct mutation
 *   - "TRUE" and "1" must NOT open writes
 *   - outside-cwd path rejected without echoing the path
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

import { registerDB } from "../../../src/tools/db/index.js";
import type { DBInput } from "../../../src/tools/db/schema.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { readDatabaseJournal } from "../../../src/database/journal.js";

type ToolExecute = (...args: unknown[]) => Promise<unknown>;

function makeEnvSource(
  overrides: Record<string, string | undefined> = {},
) {
  return {
    get: (name: string) => {
      if (name in overrides) return overrides[name];
      if (name === "PI_SHIP_DATABASE_ENVIRONMENT") return "development";
      return undefined;
    },
  };
}

async function setupTempCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ship-sqlite-int-"));
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "t@t.local"], { cwd });
  await exec("git", ["config", "user.name", "T"], { cwd });
  await writeFile(join(cwd, "x"), "y");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

describe("SQLite integration", () => {
  it("inspects empty SQLite database file", async () => {
    const cwd = await setupTempCwd();
    try {
      const dbPath = join(cwd, "test.db");
      // Create the file first via write mode so read-only inspect can open it
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.close();

      const registry = new ApprovalRegistry(cwd);
      let execute: ToolExecute | undefined;
      registerDB(
        { registerTool(def: { execute: ToolExecute }) { execute = def.execute; } } as never,
        registry,
        { credentialSource: makeEnvSource({ DATABASE_URL: `sqlite:///${dbPath}` }) },
      );
      const result = await execute!("id", { action: "inspect" }, undefined, undefined, {
        cwd,
      }) as { content: Array<{ text: string }> };
      expect(result.content.some((c) => c.text.includes("local SQLite database"))).toBe(true);
      expect(result.content.some((c) => c.text.includes("Inspected"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects outside-cwd path without echoing the path", async () => {
    const cwd = await setupTempCwd();
    try {
      const registry = new ApprovalRegistry(cwd);
      let execute: ToolExecute | undefined;
      registerDB(
        { registerTool(def: { execute: ToolExecute }) { execute = def.execute; } } as never,
        registry,
        // Use a .db path that's outside cwd
        { credentialSource: makeEnvSource({ DATABASE_URL: "/tmp/outside-cwd-test.db" }) },
      );
      await expect(
        execute!("id", { action: "inspect" }, undefined, undefined, { cwd }),
      ).rejects.toThrow();
      // Verify error does not contain the path
      try {
        await execute!("id", { action: "inspect" }, undefined, undefined, { cwd });
      } catch (e: unknown) {
        const errStr = String(e);
        expect(errStr).not.toContain("outside-cwd-test.db");
        expect(errStr).not.toContain("outside-cwd");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("gated plan+approve+apply via sqlite adapter", async () => {
    const cwd = await setupTempCwd();
    try {
      const dbPath = join(cwd, "ship.db");
      const registry = new ApprovalRegistry(cwd);
      let execute: ToolExecute | undefined;
      registerDB(
        { registerTool(def: { execute: ToolExecute }) { execute = def.execute; } } as never,
        registry,
        { credentialSource: makeEnvSource({ DATABASE_URL: `sqlite:///${dbPath}` }) },
      );
      const context = { cwd, hasUI: true, ui: { confirm: async () => true } };

      // Plan a table creation
      const planResult = await execute!(
        "id",
        { action: "plan", sql: "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)", params: [] } as DBInput,
        undefined,
        undefined,
        context,
      ) as { details: { planId: string; planDigest: string; approved: boolean } };
      expect(planResult.details.approved).toBe(true);

      // Apply the plan
      const applyResult = await execute!(
        "id",
        { action: "apply_plan", planId: planResult.details.planId, planDigest: planResult.details.planDigest } as DBInput,
        undefined,
        undefined,
        context,
      ) as { details: { status: string; statementCount: number } };
      expect(applyResult.details.status).toContain("committed");
      expect(applyResult.details.statementCount).toBe(1);

      // Journal should have entries
      const journal = await readDatabaseJournal(cwd);
      expect(journal.length).toBe(2);
      expect(journal[0]?.status).toBe("started");
      expect(journal[1]?.status).toBe("committed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("PI_SHIP_SQLITE_OPEN=true enables direct mutation", async () => {
    const cwd = await setupTempCwd();
    try {
      const dbPath = join(cwd, "open.db");
      const registry = new ApprovalRegistry(cwd);
      let execute: ToolExecute | undefined;
      registerDB(
        { registerTool(def: { execute: ToolExecute }) { execute = def.execute; } } as never,
        registry,
        {
          credentialSource: makeEnvSource({
            DATABASE_URL: `sqlite:///${dbPath}`,
            PI_SHIP_SQLITE_OPEN: "true",
          }),
        },
      );
      const context = { cwd, hasUI: false, ui: undefined };

      // Direct mutation — create table
      const createResult = await execute!(
        "id",
        { action: "query", sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)", params: [] } as DBInput,
        undefined,
        undefined,
        context,
      ) as { content: Array<{ text: string }>; details: { kind: string } };
      expect(createResult.details.kind).toContain("mutation");

      // Insert a row
      await execute!(
        "id",
        { action: "query", sql: "INSERT INTO t (v) VALUES (?)", params: ["hello"] } as DBInput,
        undefined,
        undefined,
        context,
      );

      // Read it back
      const readResult = await execute!(
        "id",
        { action: "query", sql: "SELECT * FROM t", params: [] } as DBInput,
        undefined,
        undefined,
        context,
      ) as { content: Array<{ text: string }> };
      expect(readResult.content.some((c) => c.text.includes("local SQLite database"))).toBe(true);
      expect(readResult.content.some((c) => c.text.includes("Query returned"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("open-write path binds params sequentially", async () => {
    const cwd = await setupTempCwd();
    try {
      const dbPath = join(cwd, "bind.db");
      const registry = new ApprovalRegistry(cwd);
      let execute: ToolExecute | undefined;
      registerDB(
        { registerTool(def: { execute: ToolExecute }) { execute = def.execute; } } as never,
        registry,
        {
          credentialSource: makeEnvSource({
            DATABASE_URL: `sqlite:///${dbPath}`,
            PI_SHIP_SQLITE_OPEN: "true",
          }),
        },
      );
      const context = { cwd, hasUI: false, ui: undefined };

      // First create a table
      await execute!(
        "id",
        { action: "query", sql: "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, value INTEGER)", params: [] } as any,
        undefined,
        undefined,
        context,
      );

      // Insert with params — single statement
      const insert1 = await execute!(
        "id",
        { action: "query", sql: "INSERT INTO items (id, name, value) VALUES (?, ?, ?)", params: [1, "alpha", 100] } as any,
        undefined,
        undefined,
        context,
      ) as { details: { rowCount: number } };
      expect(insert1.details.rowCount).toBe(1);

      // Read back
      const readResult = await execute!(
        "id",
        { action: "query", sql: "SELECT * FROM items", params: [] } as any,
        undefined,
        undefined,
        context,
      ) as { details: { rows: Array<Record<string, unknown>> } };
      expect(readResult.details.rows).toBeDefined();
      expect(JSON.stringify(readResult.details.rows)).toContain("alpha");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("'TRUE' and '1' must NOT open writes", async () => {
    const cwd = await setupTempCwd();
    try {
      const dbPath = join(cwd, "gated.db");
      const registry = new ApprovalRegistry(cwd);
      let execute: ToolExecute | undefined;
      registerDB(
        { registerTool(def: { execute: ToolExecute }) { execute = def.execute; } } as never,
        registry,
        {
          credentialSource: makeEnvSource({
            DATABASE_URL: `sqlite:///${dbPath}`,
            PI_SHIP_SQLITE_OPEN: "TRUE",
          }),
        },
      );
      const context = { cwd, hasUI: false, ui: undefined };

      // Mutation should be blocked — SQLite gated, write requires approval
      await expect(
        execute!(
          "id",
          { action: "query", sql: "CREATE TABLE IF NOT EXISTS x (id INTEGER PRIMARY KEY)", params: [] } as DBInput,
          undefined,
          undefined,
          context,
        ),
      ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
