/** Schema inspection using fixed pg_catalog queries. No user SQL. */
import type { DatabaseClient, DatabaseClientFactory } from "./client.js";
import { checkAborted, mapSQLError } from "./client.js";
import { normalizeCell } from "./output.js";

const CATEGORY_LIMIT = 500;
const OUTPUT_MAX_BYTES = 512 * 1024;

export interface InspectResult {
  schemas: { name: string; owner?: string }[];
  relations: {
    schema: string; name: string; kind: string; rlsEnabled: boolean;
  }[];
  columns: {
    schema: string; table: string; name: string; type: string; nullable: boolean;
    default?: string; isIdentity: boolean; isGenerated: boolean;
  }[];
  indexes: {
    schema: string; table: string; name: string; unique: boolean; primary: boolean; valid: boolean; columns: string[];
  }[];
  enums: {
    schema: string; name: string; labels: string[];
  }[];
  constraints: {
    schema: string; table: string; name: string; type: string;
    columns: string[];
    refSchema?: string; refTable?: string; refColumns?: string[];
    deferrable: boolean; deferred: boolean;
  }[];
  triggers: {
    schema: string; table: string; name: string; timing: string; events: string[]; row: boolean; enabled: boolean;
  }[];
  policies: {
    schema: string; table: string; name: string; permissive: boolean; command: string; roles: string[];
  }[];
  truncatedCategories: string[];
}

const SCHEMA_SQL = `
SELECT n.nspname AS name,
       pg_catalog.pg_get_userbyid(n.nspowner) AS owner
FROM pg_catalog.pg_namespace n
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname
LIMIT 501
`;

const RELATIONS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS name,
       CASE c.relkind
         WHEN 'r' THEN 'table'
         WHEN 'p' THEN 'partitioned_table'
         WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized_view'
         WHEN 'f' THEN 'foreign_table'
         ELSE 'unknown'
       END AS kind,
       c.relrowsecurity AS rls_enabled
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
  AND c.relkind IN ('r','p','v','m','f')
ORDER BY n.nspname, c.relname
LIMIT 501
`;

const COLUMNS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table,
       a.attname AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       NOT a.attnotnull AS nullable,
       left(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), 8192) AS default_expr,
       a.attidentity IN ('a','d') AS is_identity,
       a.attgenerated IN ('s') AS is_generated
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
  AND c.relkind IN ('r','p','v','m','f')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY n.nspname, c.relname, a.attnum
LIMIT 501
`;

const INDEXES_SQL = `
SELECT n.nspname AS schema,
       t.relname AS table_name,
       i.relname AS name,
       ix.indisunique AS unique,
       ix.indisprimary AS primary,
       ix.indisvalid AS valid,
       (SELECT coalesce(string_agg(a.attname, '|' ORDER BY un.array_position), '')
        FROM pg_catalog.pg_attribute a
        JOIN unnest(ix.indkey) WITH ORDINALITY un(elem, array_position) ON a.attnum = un.elem
        WHERE a.attrelid = t.oid) AS columns
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
  AND t.relkind IN ('r','p')
ORDER BY n.nspname, t.relname, i.relname
LIMIT 501
`;

const ENUMS_SQL = `
SELECT n.nspname AS schema,
       t.typname AS name,
       ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
  AND t.typtype = 'e'
ORDER BY n.nspname, t.typname
LIMIT 501
`;

const CONSTRAINTS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table_name,
       con.conname AS name,
       CASE con.contype
         WHEN 'p' THEN 'primary_key'
         WHEN 'u' THEN 'unique'
         WHEN 'f' THEN 'foreign_key'
         WHEN 'c' THEN 'check'
         WHEN 't' THEN 'trigger'
         WHEN 'x' THEN 'exclusion'
         ELSE con.contype
       END AS type,
       (SELECT coalesce(string_agg(a.attname, '|' ORDER BY un.array_position), '')
        FROM unnest(con.conkey) WITH ORDINALITY un(elem, array_position)
        JOIN pg_catalog.pg_attribute a ON a.attnum = un.elem AND a.attrelid = con.conrelid) AS columns,
       refn.nspname AS ref_schema,
       refc.relname AS ref_table,
       (SELECT coalesce(string_agg(refa.attname, '|' ORDER BY un2.array_position), '')
        FROM unnest(con.confkey) WITH ORDINALITY un2(elem, array_position)
        JOIN pg_catalog.pg_attribute refa ON refa.attnum = un2.elem AND refa.attrelid = con.confrelid) AS ref_columns,
       con.condeferrable AS deferrable,
       con.condeferred AS deferred
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_class refc ON refc.oid = con.confrelid
LEFT JOIN pg_catalog.pg_namespace refn ON refn.oid = refc.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname, c.relname, con.conname
LIMIT 501
`;

const TRIGGERS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table_name,
       t.tgname AS name,
       CASE
         WHEN t.tgtype::integer & 2 = 2 THEN 'BEFORE'
         WHEN t.tgtype::integer & 64 = 64 THEN 'INSTEAD OF'
         ELSE 'AFTER'
       END AS timing,
       (SELECT string_agg(ev, ',' ORDER BY ev) FROM (
         SELECT CASE WHEN t.tgtype::integer & 4 = 4 THEN 'INSERT' END AS ev
         UNION ALL SELECT CASE WHEN t.tgtype::integer & 8 = 8 THEN 'DELETE' END
         UNION ALL SELECT CASE WHEN t.tgtype::integer & 16 = 16 THEN 'UPDATE' END
         UNION ALL SELECT CASE WHEN t.tgtype::integer & 32 = 32 THEN 'TRUNCATE' END
       ) e WHERE ev IS NOT NULL) AS events,
       t.tgtype::integer & 1 = 1 AS row_trigger,
       NOT t.tgenabled = 'D' AS enabled
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT t.tgisinternal
ORDER BY n.nspname, c.relname, t.tgname
LIMIT 501
`;

const POLICIES_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table_name,
       p.polname AS name,
       p.polpermissive AS permissive,
       CASE p.polcmd
         WHEN 'r' THEN 'SELECT'
         WHEN 'a' THEN 'INSERT'
         WHEN 'w' THEN 'UPDATE'
         WHEN 'd' THEN 'DELETE'
         ELSE '*'
       END AS command,
       (SELECT coalesce(string_agg(coalesce(r.rolname, 'public'), ',' ORDER BY coalesce(r.rolname, 'public')), 'public')
        FROM unnest(p.polroles) AS role_oid
        LEFT JOIN pg_catalog.pg_roles r ON r.oid = role_oid) AS roles
FROM pg_catalog.pg_policy p
JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname, c.relname, p.polname
LIMIT 501
`;

interface CategoryQuery {
  name: string;
  sql: string;
  map: (row: Record<string, unknown>) => Record<string, unknown>;
}

/** Split pipe-separated column string into array. */
function splitColumns(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return value.split("|").filter(Boolean);
  return [];
}

const CATEGORIES: CategoryQuery[] = [
  {
    name: "schemas",
    sql: SCHEMA_SQL,
    map: (r) => ({ name: normalizeCell(r.name), owner: r.owner ?? undefined }),
  },
  {
    name: "relations",
    sql: RELATIONS_SQL,
    map: (r) => ({
      schema: r.schema, name: r.name, kind: r.kind,
      rlsEnabled: r.rls_enabled === true || r.rls_enabled === "t",
    }),
  },
  {
    name: "columns",
    sql: COLUMNS_SQL,
    map: (r) => ({
      schema: r.schema, table: r.table, name: r.name, type: r.type,
      nullable: r.nullable === true || r.nullable === "t",
      default: typeof r.default_expr === "string" ? String(normalizeCell(r.default_expr)) : undefined,
      isIdentity: r.is_identity === true || r.is_identity === "t",
      isGenerated: r.is_generated === true || r.is_generated === "t",
    }),
  },
  {
    name: "indexes",
    sql: INDEXES_SQL,
    map: (r) => ({
      schema: r.schema, table: r.table_name, name: r.name,
      unique: r.unique === true || r.unique === "t",
      primary: r.primary === true || r.primary === "t",
      valid: r.valid === true || r.valid === "t",
      columns: splitColumns(r.columns),
    }),
  },
  {
    name: "enums",
    sql: ENUMS_SQL,
    map: (r) => ({
      schema: r.schema, name: r.name,
      labels: Array.isArray(r.labels) ? r.labels.map((l: unknown) => String(normalizeCell(l))) : [],
    }),
  },
  {
    name: "constraints",
    sql: CONSTRAINTS_SQL,
    map: (r) => ({
      schema: r.schema, table: r.table_name, name: r.name, type: r.type,
      columns: splitColumns(r.columns),
      refSchema: r.ref_schema ?? undefined,
      refTable: r.ref_table ?? undefined,
      refColumns: r.ref_columns ? splitColumns(r.ref_columns) : undefined,
      deferrable: r.deferrable === true || r.deferrable === "t",
      deferred: r.deferred === true || r.deferred === "t",
    }),
  },
  {
    name: "triggers",
    sql: TRIGGERS_SQL,
    map: (r) => ({
      schema: r.schema, table: r.table_name, name: r.name, timing: r.timing,
      events: typeof r.events === "string" && r.events.length > 0 ? r.events.split(",").filter(Boolean) : [],
      row: r.row_trigger === true || r.row_trigger === "t",
      enabled: r.enabled === true || r.enabled === "t",
    }),
  },
  {
    name: "policies",
    sql: POLICIES_SQL,
    map: (r) => ({
      schema: r.schema, table: r.table_name, name: r.name,
      permissive: r.permissive === true || r.permissive === "t",
      command: r.command,
      roles: typeof r.roles === "string" && r.roles.length > 0 ? r.roles.split(",").filter(Boolean) : ["public"],
    }),
  },
];

/**
 * Enforce global serialized output budget <= 512KiB across categories.
 * Serializes once and if over budget, removes entries from the end (policies -> triggers -> ...)
 * in a divide-and-conquer fashion to avoid O(n²). Never throws.
 */
function enforceTotalBudget(
  result: InspectResult,
  maxBytes: number = OUTPUT_MAX_BYTES,
): InspectResult {
  const categoryKeys: (keyof InspectResult)[] = [
    "schemas", "relations", "columns", "indexes", "enums",
    "constraints", "triggers", "policies",
  ];

  // Compute total serialized size
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return result;

  // Over budget: drop half of each category from the end until under budget
  // Iterate from the last category backward, dropping 50% at a time
  for (let i = categoryKeys.length - 1; i >= 0; i--) {
    const key = categoryKeys[i]!;
    const arr = result[key] as unknown[];
    if (arr.length === 0) continue;

    const catName = key as string;
    if (!result.truncatedCategories.includes(catName)) {
      result.truncatedCategories.push(catName);
    }

    // Drop until this category is empty or budget fits
    while (arr.length > 0) {
      const half = Math.max(1, Math.floor(arr.length / 2));
      arr.splice(-half);
      const check = JSON.stringify(result);
      if (Buffer.byteLength(check, "utf8") <= maxBytes) return result;
    }
  }

  return result;
}

/**
 * Inspect database schema via fixed pg_catalog queries.
 * Returns up to 500 entries per category.
 * Uses shared mapSQLError for consistent error handling.
 * Final serialized result always <=512KiB; excess entries silently dropped
 * with affected categories listed in truncatedCategories.
 */
export async function inspectDatabase(
  connectionString: string,
  clientFactory: DatabaseClientFactory,
  signal?: AbortSignal,
): Promise<InspectResult> {
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

    const result: InspectResult = {
      schemas: [], relations: [], columns: [], indexes: [], enums: [],
      constraints: [], triggers: [], policies: [], truncatedCategories: [],
    };

    for (const cat of CATEGORIES) {
      checkAborted(signal);
      const qr = await client.query(cat.sql);
      const raw = qr.rows ?? [];
      if (raw.length > CATEGORY_LIMIT) {
        result.truncatedCategories.push(cat.name);
      }
      const mapped = raw.slice(0, CATEGORY_LIMIT).map(cat.map);
      const key = cat.name as keyof InspectResult;
      (result as unknown as Record<string, unknown>)[key] = mapped;
    }

    await client.query("ROLLBACK");
    began = false;

    // Enforce global output budget
    return enforceTotalBudget(result);
  } catch (cause) {
    if (began && client) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
    mapSQLError(cause);
    throw cause;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore end error */ }
    }
  }
}
