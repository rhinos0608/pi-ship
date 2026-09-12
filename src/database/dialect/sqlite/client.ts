/** SQLite DatabaseClient wrapping node:sqlite DatabaseSync. */
import { DatabaseSync } from "node:sqlite";
import type { DatabaseClient, DatabaseQueryResult } from "../../client.js";
import { KNOWN_READ_PRAGMAS } from "./classifier.js";

export interface SQLiteConnection {
  db: DatabaseSync;
  mode: "read" | "write";
}

/**
 * Open SQLite database in read-only or read-write mode.
 * Read connection uses { readOnly: true }.
 * Write connection installs setAuthorizer defense-in-depth.
 */
export function isSQLiteAuthorizerSupported(db: DatabaseSync): boolean {
  return typeof (db as unknown as { setAuthorizer?: unknown }).setAuthorizer === "function";
}

export function openSQLite(path: string, mode: "read" | "write"): DatabaseSync {
  const db = mode === "read" ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  if (mode === "write" && isSQLiteAuthorizerSupported(db)) {
    // Defense-in-depth: deny-list on write connections per ADR 0011.
    // Return values: 0 = SQLITE_OK (allow), 1 = SQLITE_DENY (deny with error).
    // SQLITE_ATTACH = 24, SQLITE_DETACH = 25, SQLITE_PRAGMA = 19.
    db.setAuthorizer((actionCode: number, detail1: string | null, _detail2: string | null, _detail3: string | null, _triggerView: string | null) => {
      // SQLITE_ATTACH = 24 — deny ATTACH DATABASE
      if (actionCode === 24) return 1;
      // SQLITE_DETACH = 25 — deny DETACH DATABASE
      if (actionCode === 25) return 1;
      // SQLITE_PRAGMA = 19 — only allow known-read pragmas
      if (actionCode === 19) {
        const pragmaName = (detail1 ?? "").toLowerCase();
        return KNOWN_READ_PRAGMAS.has(pragmaName) ? 0 : 1;
      }
      // Allow everything else (DML, DDL, etc.)
      return 0; // SQLITE_OK
    });
  }
  return db;
}

/** Create a DatabaseClient wrapping a node:sqlite DatabaseSync. */
export function createSQLiteClient(db: DatabaseSync): DatabaseClient {
  return {
    async connect() {
      // DatabaseSync is already connected after construction
    },
    async query(
      text: string,
      params?: readonly unknown[],
    ): Promise<DatabaseQueryResult> {
      // Query-layer deny-list: covers runtimes where setAuthorizer is
      // unavailable (e.g. Node 22.19) and direct client.query callers.
      // Matches authorizer behavior: ATTACH/DETACH always denied.
      if (/^\s*(ATTACH|DETACH)\b/i.test(text)) {
        throw new Error("SQLite ATTACH/DETACH blocked by deny-list");
      }
      const stmt = db.prepare(text);
      const cols = stmt.columns();
      const inputParams = (params ?? []) as any[];

      if (cols.length > 0) {
        // Row-returning statement (SELECT / read-only PRAGMA)
        const rows = stmt.all(...inputParams) as Record<string, unknown>[];
        return {
          fields: cols.map((c) => ({
            name: c.name,
            dataTypeID: 0,
          })),
          rows: rows.map((r) => ({ ...r })),
          rowCount: rows.length,
          command: "SELECT",
        };
      }

      const info = stmt.run(...inputParams);
      const command = text.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      return {
        fields: [],
        rows: [],
        rowCount: Number(info.changes),
        command,
      };
    },
    async end() {
      db.close();
    },
  };
}
