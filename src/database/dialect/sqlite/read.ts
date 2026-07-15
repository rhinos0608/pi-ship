/** SQLite bounded read query execution using DatabaseClient. */
import { err } from "../../../core/errors.js";
import type { DatabaseClient } from "../../client.js";
import type { ReadQueryOptions, ReadQueryResult } from "../../read.js";
import { buildSafeDetails } from "../../output.js";
import { assertSQLitePublicQuery } from "./classifier.js";

const MAX_FETCH_LIMIT = 200;
const MIN_FETCH_LIMIT = 1;
const DEFAULT_LIMIT = 100;

/** Validate limit is within [1, 200]. */
function resolveLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(raw) || raw < MIN_FETCH_LIMIT || raw > MAX_FETCH_LIMIT) {
    throw err(
      "E_CONFIG_INVALID",
      `limit must be between ${MIN_FETCH_LIMIT} and ${MAX_FETCH_LIMIT}`,
    );
  }
  return raw;
}

/**
 * Execute a read query against SQLite.
 * Validates SQL as single read-only statement, then executes with limit+1
 * for hasMore detection. Results normalized through buildSafeDetails.
 */
export async function executeSQLiteReadQuery(
  client: DatabaseClient,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  const limit = resolveLimit(options.limit);
  const params = options.params ?? [];

  // Classify — single read-only statement
  const classification = await assertSQLitePublicQuery(options.sql, params);
  const stmt = classification.statements[0];
  if (!stmt) throw err("E_CONFIG_INVALID", "empty classification");

  // Execute with limit + 1 to detect hasMore
  const sqlText = stmt.sql;
  const limitPlusOne = limit + 1;
  const result = await client.query(sqlText, params);

  const rawRows = result.rows ?? [];
  const hasMoreRaw = rawRows.length > limit;
  const safe = buildSafeDetails(result.fields, rawRows.slice(0, limit));

  return {
    columns: safe.columns,
    rows: safe.rows,
    rowCount: safe.rowCount,
    hasMore: hasMoreRaw || safe.truncated,
  };
}
