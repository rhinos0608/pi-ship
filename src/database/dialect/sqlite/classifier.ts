/** SQLite classifier using sqlite3-parser (exact-pinned 0.7.1). */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { err } from "../../../core/errors.js";
import type {
  Classification,
  ClassifiedStatement,
  RiskLevel,
} from "../../classifier.js";

const require = createRequire(import.meta.url);
const { parse } = require("sqlite3-parser") as {
  parse(sql: string): {
    status: string;
    root?: { type: string; cmds?: unknown[] };
  };
};

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const rank: Record<RiskLevel, number> = {
  read: 0,
  write: 1,
  destructive: 2,
  blocked: 3,
};

/** Known read-only PRAGMA allowlist — safe for inspection. */
export const KNOWN_READ_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "table_exists",
  "database_list",
  "schema_version",
  "user_version",
  "compile_options",
  "function_list",
  "module_list",
  "pragma_list",
  "page_count",
  "page_size",
  "encoding",
  "data_version",
  "freelist_count",
  "collation_list",
  "stats",
  "integrity_check",
  "quick_check",
]);

/** Walk AST collecting table names from QualifiedName nodes. */
function collectTables(node: unknown, depth = 0, maxDepth = 20): string[] {
  const tables = new Set<string>();
  function walk(value: unknown, d: number): void {
    if (!value || typeof value !== "object" || d > maxDepth) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, d + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "QualifiedName") {
      const obj = record.objName as Record<string, unknown> | undefined;
      if (obj && typeof obj.text === "string") {
        tables.add(obj.text);
      }
    }
    for (const key of Object.keys(record)) {
      if (key !== "type") walk(record[key], d + 1);
    }
  }
  walk(node, depth);
  return [...tables].sort();
}

/** Count ? parameter placeholders in SQL text. */
function countQuestionMarks(sql: string): number {
  // Simple count: every '?' is a parameter placeholder
  // SQLite only uses ? (not $1 or :name for positional)
  let count = 0;
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      if (ch === stringChar && sql[i - 1] !== "\\") {
        inString = false;
      }
    } else if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
    } else if (ch === "?") {
      count++;
    }
  }
  return count;
}

/**
 * Classify a single SQLite command (from CmdList.cmds entry).
 * Returns { tag, risk, reasons, tables, paramCount, sqlFingerprint, sqlText }.
 */
function classifyCommand(
  sql: string,
  cmd: unknown,
): {
  tag: string;
  risk: RiskLevel;
  reasons: string[];
  tables: string[];
  paramCount: number;
  sqlFingerprint: string;
  sqlText: string;
} {
  const record = cmd as Record<string, unknown>;
  const type = record.type as string | undefined;

  if (!type) {
    return {
      tag: "unknown",
      risk: "blocked",
      reasons: ["unknown SQL statement type"],
      tables: [],
      paramCount: 0,
      sqlFingerprint: fingerprint(sql),
      sqlText: sql,
    };
  }

  // Extract text span for fingerprinting (sqlite3-parser adds span to each node)
  const span = record.span as
    | { offset: number; length: number }
    | undefined;
  const sqlText =
    span && typeof span.offset === "number" && typeof span.length === "number"
      ? sql.slice(span.offset, span.offset + span.length)
      : sql;
  const fp = fingerprint(sqlText);
  const tables = collectTables(cmd);
  const paramCount = countQuestionMarks(sqlText);

  switch (type) {
    case "SelectStmt":
      return {
        tag: "SELECT",
        risk: "read",
        reasons: [],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };

    case "InsertStmt":
      return {
        tag: "INSERT",
        risk: "write",
        reasons: [],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };

    case "UpdateStmt": {
      // UPDATE is always write per plan; only destructive concern is DELETE
      return {
        tag: "UPDATE",
        risk: "write",
        reasons: [],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };
    }

    case "DeleteStmt": {
      const hasWhere =
        record.whereClause !== undefined && record.whereClause !== null;
      if (hasWhere) {
        return {
          tag: "DELETE",
          risk: "write",
          reasons: [],
          tables,
          paramCount,
          sqlFingerprint: fp,
          sqlText,
        };
      }
      return {
        tag: "DELETE",
        risk: "destructive",
        reasons: ["DELETE without WHERE"],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };
    }

    case "DropTableStmt":
    case "DropIndexStmt":
    case "DropViewStmt":
    case "DropTriggerStmt":
      return {
        tag: type,
        risk: "destructive",
        reasons: ["DROP"],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };

    case "CreateTableStmt":
    case "CreateIndexStmt":
    case "CreateViewStmt":
    case "CreateTriggerStmt":
      return {
        tag: type,
        risk: "destructive",
        reasons: ["CREATE"],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };

    case "AlterTableStmt":
      return {
        tag: type,
        risk: "destructive",
        reasons: ["ALTER"],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };

    case "PragmaStmt": {
      const nameNode = record.name as
        | { type: string; objName?: { type: string; text: string } }
        | undefined;
      const pragmaName = nameNode?.objName?.text;
      // Setting a PRAGMA via = (EqualsPragmaBody) is a write
      const body = record.body as { type?: string } | undefined;
      if (body?.type === "EqualsPragmaBody") {
        return {
          tag: "PRAGMA",
          risk: "write",
          reasons: [],
          tables,
          paramCount,
          sqlFingerprint: fp,
          sqlText,
        };
      }
      // Reading a PRAGMA — allowlist check
      if (pragmaName && KNOWN_READ_PRAGMAS.has(pragmaName)) {
        return {
          tag: "PRAGMA",
          risk: "read",
          reasons: [],
          tables,
          paramCount,
          sqlFingerprint: fp,
          sqlText,
        };
      }
      return {
        tag: "PRAGMA",
        risk: "blocked",
        reasons: [
          pragmaName
            ? `unknown/unsafe PRAGMA: ${pragmaName}`
            : "unknown PRAGMA",
        ],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };
    }

    default:
      return {
        tag: type,
        risk: "blocked",
        reasons: [`unsupported statement: ${type}`],
        tables,
        paramCount,
        sqlFingerprint: fp,
        sqlText,
      };
  }
}

/**
 * Classify SQLite SQL into Classification.
 *
 * Rules per plan:
 *   SELECT / known-read PRAGMA → read
 *   INSERT / UPDATE → write
 *   DELETE-with-WHERE → write
 *   DELETE-without-WHERE, DROP, TRUNCATE, ALTER, CREATE → destructive
 *   unknown/unsafe PRAGMA → blocked (E_CONFIG_INVALID)
 *   parse failure → blocked (E_CONFIG_INVALID)
 *
 * Validates ? placeholder count exactly against supplied params.
 */
export async function classifySQLiteSQL(
  sql: string,
  params: readonly unknown[] = [],
): Promise<Classification> {
  // Validate params are scalar/finite
  if (
    params.some((p) => {
      if (p === null || typeof p === "boolean") return false;
      if (typeof p === "number") return !Number.isFinite(p);
      if (typeof p === "string") return false;
      return true;
    })
  ) {
    throw err("E_CONFIG_INVALID", "SQL parameters must be finite scalar values");
  }

  let parsed: { status: string; root?: { type: string; cmds?: unknown[] } };
  try {
    parsed = parse(sql);
  } catch {
    throw err("E_CONFIG_INVALID", "SQL parser rejected input");
  }

  if (parsed.status !== "ok" || !parsed.root) {
    throw err("E_CONFIG_INVALID", "SQL parser rejected input");
  }

  const cmds = parsed.root.cmds ?? [];
  if (!cmds.length || cmds.length > 20) {
    throw err(
      "E_CONFIG_INVALID",
      !cmds.length
        ? "SQL must contain at least one statement"
        : "SQL has too many statements (max 20)",
    );
  }

  const statements: ClassifiedStatement[] = [];
  let overall: RiskLevel = "read";
  let accumulatedParamCount = 0;

  for (let index = 0; index < cmds.length; index++) {
    const cmd = cmds[index]!;
    const classified = classifyCommand(sql, cmd);

    if (rank[classified.risk] > rank[overall]) {
      overall = classified.risk;
    }

    accumulatedParamCount += classified.paramCount;

    statements.push({
      index,
      tag: classified.tag,
      risk: classified.risk,
      tables: classified.tables,
      sqlFingerprint: classified.sqlFingerprint,
      paramCount: classified.paramCount,
      reasons: classified.reasons,
      sql: classified.sqlText,
    });
  }

  // Validate ? placeholder count matches supplied params
  if (params.length !== accumulatedParamCount) {
    throw err(
      "E_CONFIG_INVALID",
      `SQL parameter count mismatch: statement references ${accumulatedParamCount} placeholders, supplied ${params.length} params`,
    );
  }

  // Blocked statement → throw
  if (statements.some((s) => s.risk === "blocked")) {
    const reasons = statements
      .filter((s) => s.risk === "blocked")
      .flatMap((s) => s.reasons);
    throw err(
      "E_CONFIG_INVALID",
      `SQL contains blocked statement: ${reasons.join("; ")}`,
    );
  }

  return {
    riskLevel: overall,
    statements,
    destructiveReasons: statements
      .filter((s) => s.risk === "destructive")
      .flatMap((s) => s.reasons),
    maxParamRef: accumulatedParamCount,
  };
}

/** Assert SQL is a single read-only statement. */
export async function assertSQLitePublicQuery(
  sql: string,
  params: readonly unknown[] = [],
): Promise<Classification> {
  const result = await classifySQLiteSQL(sql, params);
  if (result.statements.length !== 1 || result.riskLevel !== "read") {
    throw err("E_CONFIG_INVALID", "query requires exactly one read statement");
  }
  return result;
}

/** Assert SQL has write or destructive statements. */
export async function assertSQLitePublicPlan(
  sql: string,
  params: readonly unknown[] = [],
): Promise<Classification> {
  const result = await classifySQLiteSQL(sql, params);
  if (result.riskLevel === "read") {
    throw err(
      "E_CONFIG_INVALID",
      "plan requires write or destructive statement",
    );
  }
  return result;
}
