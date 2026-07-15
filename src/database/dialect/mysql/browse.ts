/** MySQL/MariaDB browse-style SELECT generation and execution. */
import { err } from "../../../core/errors.js";
import { checkAborted } from "../../client.js";
import { mapMySQLError } from "./error.js";
import { buildSafeDetails } from "../../output.js";
import { createMySQLClient, parseMySQLURL } from "./client.js";
import type { DialectBrowseInput, DialectBrowseResult } from "../contracts.js";
import type { DatabaseTarget } from "../../target.js";

/** Backtick-quote a MySQL identifier. */
function backtickQuote(value: string): string {
  if (!value || typeof value !== "string") {
    throw err("E_CONFIG_INVALID", "invalid identifier");
  }
  // Validate identifier: alphanumeric, underscore, dollar
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(value)) {
    throw err("E_CONFIG_INVALID", `invalid identifier: ${value}`);
  }
  return `\`${value}\``;
}

/** Direction literals are safe enum values — no quoting needed. */
const DIRECTION_VALUES = new Set(["asc", "desc", "ASC", "DESC"]);

/**
 * Operator allowlist for MySQL.
 * No ILIKE (MySQL LIKE is case-insensitive by default for non-binary columns).
 * No NULLS FIRST/LAST syntax.
 */
const OP_MAP: Record<string, { sql: string; requiresValue: boolean }> = {
  eq: { sql: "=", requiresValue: true },
  neq: { sql: "<>", requiresValue: true },
  lt: { sql: "<", requiresValue: true },
  lte: { sql: "<=", requiresValue: true },
  gt: { sql: ">", requiresValue: true },
  gte: { sql: ">=", requiresValue: true },
  like: { sql: "LIKE", requiresValue: true },
  is_null: { sql: "IS NULL", requiresValue: false },
  not_null: { sql: "IS NOT NULL", requiresValue: false },
};

/**
 * Build a SELECT statement and params for MySQL browse.
 * Uses backtick quoting and `?` placeholders.
 */
function buildMySQLBrowseQuery(input: DialectBrowseInput): { sql: string; bindParams: unknown[] } {
  const schemaName = input.schema ?? "public";
  const safeSchema = backtickQuote(schemaName);
  const safeTable = backtickQuote(input.table);

  // Columns
  let columnsClause: string;
  if (input.columns && input.columns.length > 0) {
    columnsClause = input.columns.map((c) => backtickQuote(c)).join(", ");
  } else {
    columnsClause = "*";
  }

  // FROM
  const fromClause = `${safeSchema}.${safeTable}`;

  // WHERE
  const whereClauses: string[] = [];
  const bindParams: unknown[] = [];
  const filters = input.filters ?? [];

  for (const filter of filters) {
    const safeCol = backtickQuote(filter.column);
    const op = OP_MAP[filter.op];
    if (!op) {
      throw err("E_CONFIG_INVALID", `unsupported operator: ${filter.op}`);
    }

    if (op.requiresValue) {
      if (filter.op === "like" && typeof filter.value !== "string") {
        throw err("E_CONFIG_INVALID", "like operator requires string value");
      }
      whereClauses.push(`${safeCol} ${op.sql} ?`);
      bindParams.push(filter.value);
    } else {
      whereClauses.push(`${safeCol} ${op.sql}`);
    }
  }

  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // ORDER BY — no NULLS FIRST/LAST syntax (MySQL doesn't support it)
  const orderClauses: string[] = [];
  const orderBy = input.orderBy ?? [];

  for (const ord of orderBy) {
    const safeCol = backtickQuote(ord.column);
    const dir = ord.direction;
    if (!DIRECTION_VALUES.has(dir)) {
      throw err("E_CONFIG_INVALID", `invalid sort direction: ${dir}`);
    }
    orderClauses.push(`${safeCol} ${dir}`);
  }

  const orderClause = orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(", ")}` : "";

  const sql = `SELECT ${columnsClause} FROM ${fromClause} ${whereClause} ${orderClause}`.replace(/\s+/g, " ").trim();

  return { sql, bindParams };
}

/**
 * Execute a browse query against MySQL/MariaDB.
 * Connect → START TRANSACTION READ ONLY → browse query → ROLLBACK → end.
 */
export async function executeMySQLBrowse(
  target: DatabaseTarget,
  input: DialectBrowseInput,
  signal?: AbortSignal,
): Promise<DialectBrowseResult> {
  if (target.kind !== "remote") {
    throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
  }

  // Validate identifiers pre-flight
  if (input.schema !== undefined && input.schema !== "") {
    backtickQuote(input.schema);
  }
  backtickQuote(input.table);
  if (input.columns) {
    for (const c of input.columns) backtickQuote(c);
  }
  if (input.filters) {
    for (const f of input.filters) backtickQuote(f.column);
  }
  if (input.orderBy) {
    for (const o of input.orderBy) backtickQuote(o.column);
  }

  const { sql, bindParams } = buildMySQLBrowseQuery(input);

  const offset = input.offset ?? 0;
  const limitPlusOne = input.limit + 1;
  const fullSql = `${sql} LIMIT ? OFFSET ?`;
  const allParams = [...bindParams, limitPlusOne, offset];

  const opts = parseMySQLURL(target.url);
  let client: import("../../client.js").DatabaseClient | undefined;
  let began = false;

  try {
    checkAborted(signal);
    client = await createMySQLClient(opts);

    checkAborted(signal);
    await client.connect();

    checkAborted(signal);
    await client.query("START TRANSACTION READ ONLY");
    began = true;

    checkAborted(signal);
    const result = await client.query(fullSql, allParams);

    await client.query("ROLLBACK");
    began = false;

    checkAborted(signal);

    const rawRows = result.rows ?? [];
    const hasMoreRaw = rawRows.length > input.limit;
    const safe = buildSafeDetails(result.fields, rawRows.slice(0, input.limit));

    return {
      columns: safe.columns,
      rows: safe.rows,
      rowCount: safe.rowCount,
      hasMore: hasMoreRaw || safe.truncated,
      schema: input.schema ?? "public",
      table: input.table,
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
