/** Browse-style SELECT generation and execution. */
import { err } from "../core/errors.js";
import type { DBFilter, DBOrder } from "../tools/db/schema.js";
import type { DatabaseClientFactory } from "./client.js";
import { quoteIdentifier } from "./identifiers.js";
import { executeReadQuery, type ReadQueryResult } from "./read.js";

interface BrowseParams {
  schema?: string;
  table: string;
  columns?: string[];
  filters?: DBFilter[];
  orderBy?: DBOrder[];
  limit: number;
  offset: number;
}

interface BrowseResult extends ReadQueryResult {
  schema: string;
  table: string;
}

/** Direction literals are safe enum values — no quoting needed. */
const DIRECTION_VALUES = new Set(["asc", "desc", "ASC", "DESC"]);
const NULLS_VALUES = new Set(["first", "last", "FIRST", "LAST"]);

/** Operator map — value is [SQL operator, requiresValue]. */
const OP_MAP: Record<
  string,
  { sql: string; requiresValue: boolean }
> = {
  eq: { sql: "=", requiresValue: true },
  neq: { sql: "<>", requiresValue: true },
  lt: { sql: "<", requiresValue: true },
  lte: { sql: "<=", requiresValue: true },
  gt: { sql: ">", requiresValue: true },
  gte: { sql: ">=", requiresValue: true },
  like: { sql: "LIKE", requiresValue: true },
  ilike: { sql: "ILIKE", requiresValue: true },
  is_null: { sql: "IS NULL", requiresValue: false },
  not_null: { sql: "IS NOT NULL", requiresValue: false },
};

/**
 * Build a SELECT statement and params for browse.
 * All identifiers validated through quoteIdentifier.
 * Filter values become bound parameters.
 * SQL LIMIT is requested limit + 1 so cursor FETCH also limit+1 for hasMore.
 */
function buildBrowseQuery(params: BrowseParams): { sql: string; bindParams: unknown[]; limitPlusOne: number } {
  const schemaName = params.schema ?? "public";
  const tableName = params.table;
  const safeSchema = quoteIdentifier(schemaName);
  const safeTable = quoteIdentifier(tableName);

  // Columns
  let columnsClause: string;
  if (params.columns && params.columns.length > 0) {
    columnsClause = params.columns.map((c) => quoteIdentifier(c)).join(", ");
  } else {
    columnsClause = "*";
  }

  // FROM
  const fromClause = `${safeSchema}.${safeTable}`;

  // WHERE
  const whereClauses: string[] = [];
  const bindParams: unknown[] = [];
  const filters = params.filters ?? [];

  for (const filter of filters) {
    const safeCol = quoteIdentifier(filter.column);
    const op = OP_MAP[filter.op];
    if (!op) {
      throw err("E_CONFIG_INVALID", `unsupported operator: ${filter.op}`);
    }

    if (op.requiresValue) {
      // like/ilike require string value
      if ((filter.op === "like" || filter.op === "ilike") && typeof filter.value !== "string") {
        throw err("E_CONFIG_INVALID", `${filter.op} operator requires string value`);
      }
      whereClauses.push(`${safeCol} ${op.sql} $${bindParams.length + 1}`);
      bindParams.push((filter as { value: unknown }).value);
    } else {
      whereClauses.push(`${safeCol} ${op.sql}`);
    }
  }

  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // ORDER BY
  const orderClauses: string[] = [];
  const orderBy = params.orderBy ?? [];

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
      clause += ` NULLS ${ord.nulls}`;
    }
    orderClauses.push(clause);
  }

  const orderClause = orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(", ")}` : "";

  // Build final SQL (no LIMIT/OFFSET here — they go as bound params into executeReadQuery)
  const sql = `SELECT ${columnsClause} FROM ${fromClause} ${whereClause} ${orderClause}`.replace(/\s+/g, " ").trim();

  return { sql, bindParams, limitPlusOne: params.limit + 1 };
}

/**
 * Execute a browse query against the database.
 * Validates identifiers, builds SELECT, runs through cursor read path.
 * SQL LIMIT is set to requested limit + 1 for hasMore detection.
 */
export async function executeBrowse(
  connectionString: string,
  clientFactory: DatabaseClientFactory,
  params: BrowseParams,
  signal?: AbortSignal,
): Promise<BrowseResult> {
  // Validate schema identifier if provided
  if (params.schema !== undefined && params.schema !== "") {
    quoteIdentifier(params.schema);
  }
  quoteIdentifier(params.table);

  if (params.columns) {
    for (const c of params.columns) quoteIdentifier(c);
  }
  if (params.filters) {
    for (const f of params.filters) {
      quoteIdentifier(f.column);
      if (f.op === "like" || f.op === "ilike") {
        if (typeof f.value !== "string") {
          throw err("E_CONFIG_INVALID", `${f.op} requires string value`);
        }
      }
    }
  }
  if (params.orderBy) {
    for (const o of params.orderBy) {
      quoteIdentifier(o.column);
    }
  }

  const { sql, bindParams, limitPlusOne } = buildBrowseQuery(params);

  // LIMIT = requested + 1, OFFSET as bound params
  const offset = params.offset ?? 0;
  const fullSql = `${sql} LIMIT $${bindParams.length + 1} OFFSET $${bindParams.length + 2}`;
  const allParams = [...bindParams, limitPlusOne, offset];

  const result = await executeReadQuery(connectionString, clientFactory, {
    sql: fullSql,
    params: allParams,
    limit: params.limit,
    signal,
  });

  return {
    ...result,
    schema: params.schema ?? "public",
    table: params.table,
  };
}
