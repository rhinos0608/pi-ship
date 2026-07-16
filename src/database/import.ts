import { readFile, stat } from "node:fs/promises";
import { err } from "../core/errors.js";
import { quoteIdentifier } from "./identifiers.js";
import type { DatabaseClient } from "./client.js";
import { checkAborted } from "./client.js";

const MAX_ROWS = 5_000;
const MAX_TOTAL_CELL_BYTES = 512 * 1024; // 512KiB total

// ── Import dialect contract ────────────────────────────────────────────

export interface ImportDialect {
  /** Quote an identifier (table/column name) for this dialect. */
  quoteIdentifier(value: string): string;
  /** Return the placeholder string for the given 0-based column index. */
  placeholder(index: number): string;
  /** Infer the SQL column type from a sample value. */
  inferredType(value: unknown): string;
  /** Serialize a value for the INSERT (e.g. JSON.stringify for JSONB). */
  serializeValue(value: unknown, colType: string): unknown;
}

/** Default import dialect: PostgreSQL/PGlite behavior ($n, JSONB). */
export const postgresImportDialect: ImportDialect = {
  quoteIdentifier,
  placeholder(index: number): string {
    return `$${index + 1}`;
  },
  inferredType(value: unknown): string {
    if (value === null || value === undefined) return "TEXT";
    if (typeof value === "boolean") return "BOOLEAN";
    if (typeof value === "number") {
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return "BIGINT";
      return "DOUBLE PRECISION";
    }
    if (typeof value === "string") return "TEXT";
    if (Array.isArray(value) || typeof value === "object") return "JSONB";
    return "TEXT";
  },
  serializeValue(value: unknown, colType: string): unknown {
    if (colType === "JSONB" && value !== null && (typeof value === "object" || Array.isArray(value))) {
      return JSON.stringify(value);
    }
    return value ?? null;
  },
};

/** SQLite import dialect: ? placeholders, INTEGER/REAL/TEXT, JSON string storage. */
export const sqliteImportDialect: ImportDialect = {
  quoteIdentifier,
  placeholder(_index: number): string {
    return "?";
  },
  inferredType(value: unknown): string {
    if (value === null || value === undefined) return "TEXT";
    if (typeof value === "boolean") return "INTEGER";
    if (typeof value === "number") {
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return "INTEGER";
      return "REAL";
    }
    if (typeof value === "string") return "TEXT";
    if (Array.isArray(value) || typeof value === "object") return "TEXT"; // JSON stored as text
    return "TEXT";
  },
  serializeValue(value: unknown, _colType: string): unknown {
    // Convert booleans to 0/1 for SQLite (does not accept JS booleans)
    if (typeof value === "boolean") return value ? 1 : 0;
    // Serialize objects to JSON strings
    if (value !== null && value !== undefined && typeof value === "object") {
      return JSON.stringify(value);
    }
    return value ?? null;
  },
};

// ── Import implementation ──────────────────────────────────────────────

interface ImportOptions {
  table: string;
  format: "json" | "csv";
  path?: string;
  rows?: Record<string, unknown>[];
  mode?: "create" | "append";
}

export interface ImportResult {
  table: string;
  rowsImported: number;
  created: boolean;
}

/**
 * Parse CSV text into an array of header-keyed row objects.
 * Handles quoted fields (containing commas, newlines) and
 * double-quote escaping.
 */
function parseCSV(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const lines: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        current.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
        if (ch === "\r") i++; // skip \n of \r\n
        current.push(field);
        field = "";
        lines.push(current);
        current = [];
      } else if (ch !== "\r") {
        field += ch;
      }
    }
  }
  // Flush last field + line if not already handled
  current.push(field);
  if (current.length > 1 || current[0] !== "") {
    lines.push(current);
  }

  if (lines.length < 2) {
    throw err("E_CONFIG_INVALID", "import CSV file must have header and at least one data row");
  }
  const headers = lines[0]!.map((h) => h.trim());
  for (let i = 1; i < lines.length; i++) {
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = lines[i]![j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Load rows from the import options.
 * - inline `rows` array passed directly
 * - `path` reads a file (JSON or CSV)
 * Validates row caps and cell byte budget.
 */
async function loadRows(options: ImportOptions): Promise<Record<string, unknown>[]> {
  if (options.rows && options.path) {
    throw err("E_CONFIG_INVALID", "import requires exactly one of rows or path, not both");
  }

  let rawRows: Record<string, unknown>[];

  if (options.path) {
    // Reject clearly oversized files before buffering them in memory.
    const fileStat = await stat(options.path);
    if (fileStat.size > MAX_TOTAL_CELL_BYTES * 4) {
      throw err("E_CONFIG_INVALID", `import file size ${fileStat.size} exceeds byte budget`);
    }
    const content = await readFile(options.path, "utf8");
    if (options.format === "json") {
      try {
        const parsed = JSON.parse(content);
        rawRows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw err("E_CONFIG_INVALID", "import JSON file is not valid JSON");
      }
    } else {
      rawRows = parseCSV(content);
    }
  } else if (options.rows) {
    rawRows = options.rows;
  } else {
    throw err("E_CONFIG_INVALID", "import requires rows or path");
  }

  if (rawRows.length > MAX_ROWS) {
    throw err("E_CONFIG_INVALID", `import limited to ${MAX_ROWS} rows`);
  }
  if (rawRows.length === 0) {
    throw err("E_CONFIG_INVALID", "import requires at least one row");
  }

  // Byte budget check — account for JSON serialization of non-string values
  let totalBytes = 0;
  for (const row of rawRows) {
    for (const val of Object.values(row)) {
      if (typeof val === "string") {
        totalBytes += Buffer.byteLength(val, "utf8");
      } else if (val !== null && val !== undefined && (Array.isArray(val) || typeof val === "object")) {
        totalBytes += Buffer.byteLength(JSON.stringify(val), "utf8");
      } else if (val !== null && val !== undefined) {
        totalBytes += Buffer.byteLength(String(val), "utf8");
      }
    }
  }
  if (totalBytes > MAX_TOTAL_CELL_BYTES) {
    throw err("E_CONFIG_INVALID", "import data over byte budget");
  }

  return rawRows;
}

/**
 * Infer column names and types from sample rows using the dialect's type inference.
 * Null/undefined values fall back to TEXT.
 */
function inferSchema(
  rows: Record<string, unknown>[],
  dialect: ImportDialect,
): { columns: string[]; types: string[] } {
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  const columns = [...columnSet];
  const types = columns.map((col) => {
    for (const row of rows) {
      const val = row[col];
      if (val !== null && val !== undefined) return dialect.inferredType(val);
    }
    return "TEXT";
  });
  return { columns, types };
}

/**
 * Import rows into a local table.
 * Auto-creates table with inferred schema when mode is "create" (default)
 * or table does not exist. Appends when mode is "append".
 * All identifiers validated via quoteIdentifier.
 * Rows inserted in parameterized batches of 100.
 *
 * The `dialect` parameter allows per-engine SQL generation without changing
 * the core import logic. Defaults to PostgreSQL/PGlite behavior.
 */
export async function importData(
  client: DatabaseClient,
  options: ImportOptions,
  signal?: AbortSignal,
  dialect: ImportDialect = postgresImportDialect,
): Promise<ImportResult> {
  checkAborted(signal);

  const rows = await loadRows(options);
  const table = options.table;
  dialect.quoteIdentifier(table); // validate

  const { columns, types } = inferSchema(rows, dialect);

  // Validate all column names
  for (const col of columns) {
    dialect.quoteIdentifier(col);
  }

  const mode = options.mode ?? "create";
  let created = false;

  checkAborted(signal);

  if (mode === "create") {
    // Create table with dialect-specific column types
    const colDefs = columns
      .map((col, i) => `${dialect.quoteIdentifier(col)} ${types[i]}`)
      .join(", ");
    const createSQL = `CREATE TABLE ${dialect.quoteIdentifier(table)} (${colDefs})`;
    try {
      await client.query(createSQL);
      created = true;
    } catch (e) {
      const code = (e as unknown as Record<string, unknown>).code;
      if (code === "42P07") {
        // Table already exists — not created by this import
        created = false;
      } else {
        throw e;
      }
    }
  }

  // Insert in batches of 100
  const colList = columns.map((c) => dialect.quoteIdentifier(c)).join(", ");
  const placeholders = (rowIdx: number) =>
    columns.map((_, i) => dialect.placeholder(rowIdx * columns.length + i)).join(", ");

  const BATCH_SIZE = 100;
  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    checkAborted(signal);
    const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);

    const valueGroups = batch.map((_, i) => `(${placeholders(i)})`).join(", ");
    const insertSQL = `INSERT INTO ${dialect.quoteIdentifier(table)} (${colList}) VALUES ${valueGroups}`;

    const allParams: unknown[] = [];
    for (const row of batch) {
      for (let ci = 0; ci < columns.length; ci++) {
        const val = row[columns[ci]!];
        const colType = types[ci]!;
        allParams.push(dialect.serializeValue(val, colType));
      }
    }

    await client.query(insertSQL, allParams);
  }

  return { table, rowsImported: rows.length, created };
}
