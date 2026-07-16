import type { DatabaseClient, DatabaseClientFactory } from "./client.js";
import { checkAborted, mapSQLError } from "./client.js";
import { classifySQL } from "./classifier.js";
import { executeReadQuery } from "./read.js";
import { err } from "../core/errors.js";

export interface LocalQueryResult {
  /** Distinguish read vs write result shape. */
  kind: "read" | "mutation";
  columns?: { name: string; dataTypeID?: number }[];
  rows?: Record<string, unknown>[];
  rowCount: number;
  hasMore?: boolean;
  statementCount: number;
}

/**
 * Execute a classified query directly against a local DatabaseClient.
 * - read → delegates to executeReadQuery (cursor transaction)
 * - write/destructive → direct BEGIN/COMMIT transaction, no approval/journal
 * - blocked → refused
 * The client is already connected (local PGlite).
 * Since executeReadQuery takes a connectionString + factory, we create a
 * single-use factory that returns the provided client.
 */
export async function executeLocalQuery(
  client: DatabaseClient,
  sql: string,
  params: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<LocalQueryResult> {
  checkAborted(signal);
  const classification = await classifySQL(sql, params);

  if (classification.riskLevel === "blocked") {
    throw err("E_CONFIG_INVALID", "SQL contains blocked statement");
  }

  if (classification.riskLevel === "read") {
    if (classification.statements.length !== 1) {
      throw err("E_CONFIG_INVALID", "multi-statement read queries are not supported; send one SELECT at a time");
    }
    // Use existing cursor read path. Provide a factory that returns this client
    // (executeReadQuery calls connect() which is a no-op for PGlite).
    const factory: DatabaseClientFactory = () => client;
    const readResult = await executeReadQuery(
      "pglite://local", // dummy — factory ignores it
      factory,
      { sql: classification.statements[0]!.sql, params, signal },
    );
    return {
      kind: "read",
      columns: readResult.columns,
      rows: readResult.rows,
      rowCount: readResult.rowCount,
      hasMore: readResult.hasMore,
      statementCount: 1,
    };
  }

  // write or destructive — direct transaction
  checkAborted(signal);
  let began = false;
  let totalAffected = 0;

  try {
    await client.query("BEGIN");
    began = true;

    await client.query("SET LOCAL statement_timeout = '30000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");

    let paramOffset = 0;
    for (const stmt of classification.statements) {
      checkAborted(signal);
      const boundParams = params.slice(paramOffset, paramOffset + stmt.paramCount);
      paramOffset += stmt.paramCount;
      const result = await client.query(stmt.sql, boundParams);
      if (result.rowCount !== null) totalAffected += result.rowCount;
    }

    checkAborted(signal);
    await client.query("COMMIT");
    began = false;

    return {
      kind: "mutation",
      rowCount: totalAffected,
      statementCount: classification.statements.length,
    };
  } catch (cause) {
    if (began) {
      try { await client.query("ROLLBACK"); } catch { /* best-effort */ }
    }
    mapSQLError(cause);
    throw cause; // unreachable — mapSQLError always throws
  }
}
