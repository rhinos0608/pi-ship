import type { DatabaseClient, DatabaseQueryResult } from "../client.js";
import { getPGliteInstance } from "./instance-cache.js";

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
      return {
        fields: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataTypeID: (f as { dataTypeID?: number }).dataTypeID ?? 0,
        })),
        rows: result.rows as Record<string, unknown>[],
        rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
        command: (result as { command?: string }).command ?? "SELECT",
      };
    },

    async end(): Promise<void> {
      // No-op. Instances are process-scoped and cleaned up on exit.
    },
  };
}
