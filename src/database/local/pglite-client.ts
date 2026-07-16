import type { DatabaseClient, DatabaseQueryResult } from "../client.js";
import { getPGliteInstance } from "./instance-cache.js";

/**
 * SQL statement types that return rows (not affectedRows).
 */
const READ_COMMANDS = new Set([
  "SELECT",
  "WITH",
  "VALUES",
  "EXPLAIN",
  "SHOW",
  "DESCRIBE",
]);

/**
 * Extract the SQL command (first keyword) from a SQL statement.
 * Strips leading whitespace and comments, returns the first word uppercased.
 */
function extractCommand(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return "SELECT";
  // Skip leading single-line comments (-- ...) and block comments (/* ... */)
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === "-" && trimmed[i + 1] === "-") {
      const nl = trimmed.indexOf("\n", i);
      if (nl === -1) return "SELECT";
      i = nl + 1;
    } else if (trimmed[i] === "/" && trimmed[i + 1] === "*") {
      const end = trimmed.indexOf("*/", i + 2);
      if (end === -1) return "SELECT";
      i = end + 2;
    } else if (trimmed[i] === " " || trimmed[i] === "\t" || trimmed[i] === "\n" || trimmed[i] === "\r") {
      i++;
    } else {
      break;
    }
  }
  const wordEnd = trimmed.indexOf(" ", i);
  const word = wordEnd === -1 ? trimmed.slice(i) : trimmed.slice(i, wordEnd);
  return word.toUpperCase();
}

/**
 * Create a DatabaseClient backed by a cached PGlite instance.
 * The dataDir is used as the cache key; the PGlite instance is
 * auto-created on first access.
 * `connect()` is a no-op (PGlite initializes on construction).
 * `end()` is a no-op (instances are process-scoped).
 */
export async function createPGliteClient(dataDir: string): Promise<DatabaseClient> {
  const pg = await getPGliteInstance(dataDir);

  return {
    async connect(): Promise<void> {
      // PGlite initializes at construction; no explicit connect needed.
    },

    async query(text: string, params?: readonly unknown[]): Promise<DatabaseQueryResult> {
      const result = await pg.query(text, params as unknown[] | undefined);
      const command = extractCommand(text);
      const isRead = READ_COMMANDS.has(command);
      const rowCount = isRead
        ? result.rows.length
        : (result.affectedRows ?? result.rows.length);
      return {
        fields: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataTypeID: (f as { dataTypeID?: number }).dataTypeID ?? 0,
        })),
        rows: result.rows as Record<string, unknown>[],
        rowCount,
        command,
      };
    },

    async end(): Promise<void> {
      // No-op. Instances are process-scoped and cleaned up on exit.
    },
  };
}
