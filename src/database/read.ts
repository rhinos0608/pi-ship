/** Shared read-only bounded PostgreSQL query execution. */
import { randomBytes } from "node:crypto";
import { err } from "../core/errors.js";
import { assertPublicQuery } from "./classifier.js";
import type { DatabaseClient, DatabaseClientFactory } from "./client.js";
import { checkAborted, mapSQLError } from "./client.js";
import { buildSafeDetails } from "./output.js";

const MAX_FETCH_LIMIT = 200;
const MIN_FETCH_LIMIT = 1;
const DEFAULT_LIMIT = 100;

export interface ReadQueryOptions {
  sql: string;
  params?: readonly unknown[];
  limit?: number;
  signal?: AbortSignal;
}

export interface ReadQueryResult {
  columns: { name: string; dataTypeID?: number }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  hasMore: boolean;
}

/**
 * Generate a cryptographically random cursor name.
 * Must be a valid PostgreSQL identifier (quoted).
 */
function randomCursorName(): string {
  return `"_pi_cursor_${randomBytes(16).toString("hex")}"`;
}

/** Validate limit is undefined (use default) or within [1, 200]. */
function resolveLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(raw) || raw < MIN_FETCH_LIMIT || raw > MAX_FETCH_LIMIT) {
    throw err("E_CONFIG_INVALID", `limit must be between ${MIN_FETCH_LIMIT} and ${MAX_FETCH_LIMIT}`);
  }
  return raw;
}

/**
 * Execute a read query through a transaction cursor wrapper.
 * Connect, BEGIN, work, and rollback/end failures all go through mapSQLError.
 * No raw error details (message, SQL, params, URL, rows) leaked.
 * Signal is checked before each dispatch; ROLLBACK always completes before
 * final signal check to ensure clean transaction state.
 */
export async function executeReadQuery(
  connectionString: string,
  clientFactory: DatabaseClientFactory,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  const limit = resolveLimit(options.limit);
  const params = options.params ?? [];
  const signal = options.signal;

  // Parse and validate — single read-only statement
  checkAborted(signal);
  const classification = await assertPublicQuery(options.sql, params);

  checkAborted(signal);
  const stmt = classification.statements[0];
  if (!stmt) throw err("E_CONFIG_INVALID", "empty classification");

  let client: DatabaseClient | undefined;
  let began = false;

  try {
    checkAborted(signal);
    client = clientFactory(connectionString);

    checkAborted(signal);
    await client.connect();

    checkAborted(signal);
    await client.query("BEGIN READ ONLY");
    began = true;

    checkAborted(signal);
    await client.query("SET LOCAL statement_timeout = '5000ms'");

    checkAborted(signal);
    await client.query("SET LOCAL lock_timeout = '1000ms'");

    // DECLARE cursor
    checkAborted(signal);
    const cursorName = randomCursorName();
    const declareSql = `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${stmt.sql}`;
    await client.query(declareSql, stmt.paramCount > 0 ? params : undefined);

    // FETCH limit+1 rows to detect hasMore
    checkAborted(signal);
    const fetchSql = `FETCH FORWARD ${limit + 1} FROM ${cursorName}`;
    const result = await client.query(fetchSql);

    // Close cursor (best effort) — no signal check, best-effort cleanup
    try { await client.query(`CLOSE ${cursorName}`); } catch { /* non-critical */ }

    // ROLLBACK always succeeds regardless of signal state
    await client.query("ROLLBACK");
    began = false;

    // NOW check signal — if aborted during query, return E_CANCELLED after clean rollback
    checkAborted(signal);

    // Build normalized output with budget check
    const rawRows = result.rows ?? [];
    const hasMoreRaw = rawRows.length > limit;
    const safe = buildSafeDetails(result.fields, rawRows.slice(0, limit));

    return {
      columns: safe.columns,
      rows: safe.rows,
      rowCount: safe.rowCount,
      hasMore: hasMoreRaw || safe.truncated,
    };
  } catch (cause) {
    // Best-effort rollback if transaction was started
    if (began && client) {
      try { await client.query("ROLLBACK"); } catch { /* ignore rollback error */ }
    }
    mapSQLError(cause);
    throw cause; // unreachable — mapSQLError always throws
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore end error */ }
    }
  }
}
