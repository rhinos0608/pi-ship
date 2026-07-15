/** SQLite browse-style SELECT generation and execution. */
import { err } from "../../../core/errors.js";
import type { DatabaseClient } from "../../client.js";
import type { DialectBrowseInput, DialectBrowseResult } from "../contracts.js";
import { quoteIdentifier } from "../../identifiers.js";
import { executeSQLiteReadQuery } from "./read.js";

/** Direction literals are safe enum values. */
const DIRECTION_VALUES = new Set(["asc", "desc", "ASC", "DESC"]);
const NULLS_VALUES = new Set(["first", "last", "FIRST", "LAST"]);

/**
 * Operator map — SQLite-compatible operator subset.
 * Note: No ILIKE — SQLite LIKE is case-insensitive for ASCII by default.
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
 * Build a SELECT statement and params for SQLite browse.
 * Uses ? placeholders and quoted identifiers.
 */
function buildBrowseQuery(
  input: DialectBrowseInput,
): { sql: string; bindParams: unknown[] } {
  const schemaName = input.schema ?? "main";
  const safeSchema = quoteIdentifier(schemaName);
  const safeTable = quoteIdentifier(input.table);

  // Columns
  const columnsClause =
    input.columns && input.columns.length > 0
      ? input.columns.map((c) => quoteIdentifier(c)).join(", ")
      : "*";

  // FROM
  const fromClause = `${safeSchema}.${safeTable}`;

  // WHERE
  const whereClauses: string[] = [];
  const bindParams: unknown[] = [];
  const filters = input.filters ?? [];

  for (const filter of filters) {
    const safeCol = quoteIdentifier(filter.column);
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

  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // ORDER BY
  const orderClauses: string[] = [];
  const orderBy = input.orderBy ?? [];

  for (const ord of orderBy) {
    const safeCol = quoteIdentifier(ord.column);
    const dir = ord.direction;
    if (!DIRECTION_VALUES.has(dir)) {
      throw err("E_CONFIG_INVALID", `invalid sort direction: ${dir}`);
    }
    let clause = `${safeCol} ${dir}`;
    if (ord.nulls !== undefined) {
      if (!NULLS_VALUES.has(ord.nulls)) {
        throw err("E_CONFIG_INVALID", `invalid nulls ordering: ${ord.nulls}`);
      }
      // SQLite supports NULLS FIRST/LAST (3.30+)
      clause += ` NULLS ${ord.nulls}`;
    }
    orderClauses.push(clause);
  }

  const orderClause =
    orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(", ")}` : "";

  // Build SQL with LIMIT/OFFSET bound params
  const sql = `SELECT ${columnsClause} FROM ${fromClause} ${whereClause} ${orderClause}`
    .replace(/\s+/g, " ")
    .trim();

  return { sql, bindParams };
}

/**
 * Execute a browse query against SQLite.
 * Uses ? binds, quoted identifiers, LIKE not ILIKE.
 * LIMIT is requested limit + 1 for hasMore detection.
 */
export async function executeSQLiteBrowse(
  client: DatabaseClient,
  input: DialectBrowseInput,
): Promise<DialectBrowseResult> {
  // Validate identifiers
  if (input.schema !== undefined && input.schema !== "") {
    quoteIdentifier(input.schema);
  }
  quoteIdentifier(input.table);
  if (input.columns) {
    for (const c of input.columns) quoteIdentifier(c);
  }
  if (input.filters) {
    for (const f of input.filters) {
      quoteIdentifier(f.column);
      if (f.op === "like" && typeof f.value !== "string") {
        throw err("E_CONFIG_INVALID", "like requires string value");
      }
    }
  }
  if (input.orderBy) {
    for (const o of input.orderBy) {
      quoteIdentifier(o.column);
    }
  }

  const { sql, bindParams } = buildBrowseQuery(input);
  const limitPlusOne = input.limit + 1;
  const offset = input.offset ?? 0;

  const fullSql = `${sql} LIMIT ? OFFSET ?`;
  const allParams = [...bindParams, limitPlusOne, offset];

  const result = await executeSQLiteReadQuery(client, {
    sql: fullSql,
    params: allParams,
    limit: input.limit,
  });

  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    hasMore: result.hasMore,
    schema: input.schema ?? "main",
    table: input.table,
  };
}
