/** MySQL/MariaDB schema inspection using fixed information_schema queries. */
import type { DatabaseClient } from "../../client.js";
import { checkAborted } from "../../client.js";
import { mapMySQLError } from "./error.js";
import { err } from "../../../core/errors.js";
import { normalizeCell } from "../../output.js";
import type { InspectResult } from "../../inspect.js";
import { parseMySQLURL, createMySQLClient } from "./client.js";
import type { DatabaseTarget } from "../../target.js";

const CATEGORY_LIMIT = 500;
const OUTPUT_MAX_BYTES = 512 * 1024;

const SCHEMAS_SQL = `
SELECT SCHEMA_NAME AS name
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY SCHEMA_NAME
LIMIT 501
`;

const TABLES_SQL = `
SELECT TABLE_SCHEMA AS schema,
       TABLE_NAME AS name,
       TABLE_TYPE AS kind
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY TABLE_SCHEMA, TABLE_NAME
LIMIT 501
`;

const COLUMNS_SQL = `
SELECT TABLE_SCHEMA AS schema,
       TABLE_NAME AS table_name,
       COLUMN_NAME AS name,
       DATA_TYPE AS type,
       IS_NULLABLE AS nullable,
       COLUMN_DEFAULT AS default_value,
       EXTRA AS extra
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
LIMIT 501
`;

const INDEXES_SQL = `
SELECT s.TABLE_SCHEMA AS schema,
       s.TABLE_NAME AS table_name,
       s.INDEX_NAME AS name,
       NOT s.NON_UNIQUE AS unique_index,
       s.INDEX_NAME = 'PRIMARY' AS primary_index,
       GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX SEPARATOR '|') AS columns
FROM information_schema.STATISTICS s
WHERE s.TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
GROUP BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.NON_UNIQUE
ORDER BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME
LIMIT 501
`;

const CONSTRAINTS_SQL = `
SELECT k.TABLE_SCHEMA AS schema,
       k.TABLE_NAME AS table_name,
       k.CONSTRAINT_NAME AS name,
       k.CONSTRAINT_TYPE AS type,
       GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '|') AS columns,
       k.REFERENCED_TABLE_SCHEMA AS ref_schema,
       k.REFERENCED_TABLE_NAME AS ref_table,
       GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '|') AS ref_columns
FROM information_schema.KEY_COLUMN_USAGE k
WHERE k.TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
  AND k.CONSTRAINT_NAME <> 'PRIMARY'
GROUP BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.CONSTRAINT_TYPE,
         k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME
ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME
LIMIT 501
`;

/** Split pipe-separated column string into array. */
function splitColumns(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return value.split("|").filter(Boolean);
  return [];
}

/**
 * Enforce global serialized output budget <= 512KiB.
 * Drops entries from the end of categories until under budget.
 */
function enforceTotalBudget(result: InspectResult, maxBytes: number = OUTPUT_MAX_BYTES): InspectResult {
  const categoryKeys: (keyof InspectResult)[] = [
    "schemas", "relations", "columns", "indexes", "enums",
    "constraints", "triggers", "policies",
  ];

  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return result;

  for (let i = categoryKeys.length - 1; i >= 0; i--) {
    const key = categoryKeys[i]!;
    const arr = result[key] as unknown[];
    if (arr.length === 0) continue;
    const catName = key as string;
    if (!result.truncatedCategories.includes(catName)) {
      result.truncatedCategories.push(catName);
    }
    while (arr.length > 0) {
      const half = Math.max(1, Math.floor(arr.length / 2));
      arr.splice(-half);
      const check = JSON.stringify(result);
      if (Buffer.byteLength(check, "utf8") <= maxBytes) return result;
    }
  }
  return result;
}

function normalizeBoolean(value: unknown): boolean {
  if (value === true || value === 1 || value === "t" || value === "T" || value === "1" || value === "YES") return true;
  return false;
}

/**
 * Inspect a MySQL/MariaDB database using fixed information_schema queries.
 * Returns up to 500 entries per category.
 * PG-only categories (enums, triggers, policies) return empty arrays.
 */
export async function inspectMySQL(
  target: DatabaseTarget,
  signal?: AbortSignal,
): Promise<InspectResult> {
  if (target.kind !== "remote") {
    throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
  }

  const options = parseMySQLURL(target.url);
  let client: DatabaseClient | undefined;
  let began = false;

  try {
    checkAborted(signal);
    client = await createMySQLClient(options);

    checkAborted(signal);
    await client.connect();

    checkAborted(signal);
    await client.query("START TRANSACTION READ ONLY");
    began = true;

    const result: InspectResult = {
      schemas: [], relations: [], columns: [], indexes: [], enums: [],
      constraints: [], triggers: [], policies: [], truncatedCategories: [],
    };

    // Schemas
    checkAborted(signal);
    const schemasQR = await client.query(SCHEMAS_SQL);
    const schemasRaw = schemasQR.rows ?? [];
    if (schemasRaw.length > CATEGORY_LIMIT) result.truncatedCategories.push("schemas");
    result.schemas = schemasRaw.slice(0, CATEGORY_LIMIT).map((r: Record<string, unknown>) => ({
      name: normalizeCell(r.name) as string,
    }));

    // Tables/views (relations)
    checkAborted(signal);
    const tablesQR = await client.query(TABLES_SQL);
    const tablesRaw = tablesQR.rows ?? [];
    if (tablesRaw.length > CATEGORY_LIMIT) result.truncatedCategories.push("relations");
    result.relations = tablesRaw.slice(0, CATEGORY_LIMIT).map((r: Record<string, unknown>) => ({
      schema: normalizeCell(r.schema) as string,
      name: normalizeCell(r.name) as string,
      kind: r.kind === "VIEW" ? "view" : "table",
      rlsEnabled: false,
    }));

    // Columns
    checkAborted(signal);
    const columnsQR = await client.query(COLUMNS_SQL);
    const columnsRaw = columnsQR.rows ?? [];
    if (columnsRaw.length > CATEGORY_LIMIT) result.truncatedCategories.push("columns");
    result.columns = columnsRaw.slice(0, CATEGORY_LIMIT).map((r: Record<string, unknown>) => ({
      schema: normalizeCell(r.schema) as string,
      table: normalizeCell(r.table_name) as string,
      name: normalizeCell(r.name) as string,
      type: normalizeCell(r.type) as string,
      nullable: normalizeCell(r.nullable) !== "NO",
      default: r.default_value != null ? String(normalizeCell(r.default_value)) : undefined,
      isIdentity: false,
      isGenerated: typeof r.extra === "string" && r.extra.includes("auto_increment"),
    }));

    // Indexes
    checkAborted(signal);
    const indexesQR = await client.query(INDEXES_SQL);
    const indexesRaw = indexesQR.rows ?? [];
    if (indexesRaw.length > CATEGORY_LIMIT) result.truncatedCategories.push("indexes");
    result.indexes = indexesRaw.slice(0, CATEGORY_LIMIT).map((r: Record<string, unknown>) => ({
      schema: normalizeCell(r.schema) as string,
      table: normalizeCell(r.table_name) as string,
      name: normalizeCell(r.name) as string,
      unique: normalizeBoolean(r.unique_index),
      primary: normalizeBoolean(r.primary_index),
      valid: true,
      columns: splitColumns(r.columns),
    }));

    // Constraints (foreign key, unique, check)
    checkAborted(signal);
    const constraintsQR = await client.query(CONSTRAINTS_SQL);
    const constraintsRaw = constraintsQR.rows ?? [];
    if (constraintsRaw.length > CATEGORY_LIMIT) result.truncatedCategories.push("constraints");
    result.constraints = constraintsRaw.slice(0, CATEGORY_LIMIT).map((r: Record<string, unknown>) => ({
      schema: normalizeCell(r.schema) as string,
      table: normalizeCell(r.table_name) as string,
      name: normalizeCell(r.name) as string,
      type: r.type === "FOREIGN KEY" ? "foreign_key" :
            r.type === "UNIQUE" ? "unique" :
            r.type === "CHECK" ? "check" :
            (normalizeCell(r.type) as string).toLowerCase(),
      columns: splitColumns(r.columns),
      refSchema: r.ref_schema != null ? normalizeCell(r.ref_schema) as string : undefined,
      refTable: r.ref_table != null ? normalizeCell(r.ref_table) as string : undefined,
      refColumns: r.ref_columns ? splitColumns(r.ref_columns) : undefined,
      deferrable: false,
      deferred: false,
    }));

    // PG-only categories — empty arrays
    result.enums = [];
    result.triggers = [];
    result.policies = [];

    await client.query("ROLLBACK");
    began = false;

    return enforceTotalBudget(result);
  } catch (cause) {
    if (began && client) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
    mapMySQLError(cause);
    throw cause;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore end error */ }
    }
  }
}
