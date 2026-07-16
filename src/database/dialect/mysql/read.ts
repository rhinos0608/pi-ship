/** MySQL/MariaDB read-only bounded query execution. */
import { err } from "../../../core/errors.js";
import type { DatabaseClient } from "../../client.js";
import { checkAborted } from "../../client.js";
import { mapMySQLError } from "./error.js";
import { buildSafeDetails } from "../../output.js";
import { createMySQLClient, parseMySQLURL } from "./client.js";
import type { ReadQueryOptions, ReadQueryResult } from "../../read.js";
import type { DatabaseTarget } from "../../target.js";

const MAX_FETCH_LIMIT = 200;
const MIN_FETCH_LIMIT = 1;
const DEFAULT_LIMIT = 100;

function resolveLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(raw) || raw < MIN_FETCH_LIMIT || raw > MAX_FETCH_LIMIT) {
    throw err("E_CONFIG_INVALID", `limit must be between ${MIN_FETCH_LIMIT} and ${MAX_FETCH_LIMIT}`);
  }
  return raw;
}

/**
 * Execute a read query against MySQL/MariaDB.
 * Connect → START TRANSACTION READ ONLY → bounded query → ROLLBACK → end.
 * No PostgreSQL cursor SQL used.
 */
export async function executeMySQLRead(
  target: DatabaseTarget,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  if (target.kind !== "remote") {
    throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
  }

  const limit = resolveLimit(options.limit);
  const params = options.params ?? [];
  const signal = options.signal;

  const opts = parseMySQLURL(target.url);
  let client: DatabaseClient | undefined;
  let began = false;

  try {
    checkAborted(signal);
    client = await createMySQLClient(opts);

    checkAborted(signal);
    await client.connect();

    checkAborted(signal);
    await client.query("START TRANSACTION READ ONLY");
    began = true;

    // Execute with limit+1 for hasMore detection
    checkAborted(signal);
    const trimmedSql = options.sql.trim().replace(/;?\s*$/, "");
    const hasExplicitLimit = /\bLIMIT\b/i.test(trimmedSql);
    const boundedSql = hasExplicitLimit ? trimmedSql : `${trimmedSql} LIMIT ?`;
    const allParams = hasExplicitLimit ? params : [...params, limit + 1];
    const result = await client.query(boundedSql, allParams);

    await client.query("ROLLBACK");
    began = false;

    checkAborted(signal);

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
    if (began && client) {
      try { await client.query("ROLLBACK"); } catch { /* ignore rollback error */ }
    }
    mapMySQLError(cause);
    throw cause;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore end error */ }
    }
  }
}
