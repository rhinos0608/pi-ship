/** MySQL/MariaDB SQL classifier using node-sql-parser MySQL dialect. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { err } from "../../../core/errors.js";
import type { Classification, ClassifiedStatement, RiskLevel } from "../../classifier.js";

const require = createRequire(import.meta.url);

let _Parser: ReturnType<typeof require> | null = null;

function getParser(): any {
  if (!_Parser) {
    _Parser = require("node-sql-parser");
  }
  return _Parser;
}

/** Statement types from node-sql-parser that are allowed for public queries. */
const READ_TYPES = new Set(["select"]);

/** Statement types from node-sql-parser that are allowed write operations. */
const WRITE_TYPES = new Set(["insert", "update", "replace"]);

/** Statement types that are always destructive regardless of content. */
const DESTRUCTIVE_TYPES = new Set(["drop", "truncate", "alter", "create"]);

/** Statement types from node-sql-parser that are never allowed. */
const BLOCKED_TYPES = new Set(["show", "set", "call", "rename", "load"]);

const rank: Record<string, number> = { read: 0, write: 1, destructive: 2, blocked: 3 };

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Recursively count `?` placeholder occurrences in parsed AST.
 * node-sql-parser represents `?` as `{ type: "origin", value: "?" }`.
 */
function countPlaceholders(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((s: number, n: unknown) => s + countPlaceholders(n), 0);
  const obj = node as Record<string, unknown>;
  if (obj.type === "origin" && obj.value === "?") return 1;
  let count = 0;
  for (const key of Object.keys(obj)) {
    count += countPlaceholders(obj[key]);
  }
  return count;
}

/**
 * Extract table names from a parsed AST node.
 * Deduplicates and returns sorted array.
 */
function extractTables(node: Record<string, unknown>): string[] {
  const tables = new Set<string>();

  function addFrom(arr: unknown) {
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (t && typeof t === "object" && (t as Record<string, unknown>).table) {
          const r = t as Record<string, unknown>;
          tables.add(r.db ? `${r.db}.${r.table}` : `${r.table}`);
        }
      }
    }
  }

  function addName(arr: unknown) {
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (t && typeof t === "object" && (t as Record<string, unknown>).table) {
          const r = t as Record<string, unknown>;
          tables.add(r.db ? `${r.db}.${r.table}` : `${r.table}`);
        }
      }
    }
  }

  // select
  addFrom(node.from);
  // insert
  addName(node.table);
  // update — tables in table and from
  addName(node.table);
  addFrom(node.from);
  // delete
  addFrom(node.from);
  addName(node.table);
  // drop/truncate
  addName(node.name);
  // create
  addName(node.table);
  // alter
  addName(node.table);

  return [...tables].sort();
}

/**
 * Classify a single parsed AST node into risk level with reasons.
 */
function classifyNode(node: Record<string, unknown>): { risk: RiskLevel; reasons: string[]; tag: string } {
  const type = node.type as string | undefined;

  if (!type) {
    return { risk: "blocked", reasons: ["unknown AST node — missing type"], tag: "unknown" };
  }

  if (READ_TYPES.has(type)) {
    // Select — check for INTO or locking
    if (node.into && (node.into as Record<string, unknown>).position !== null) {
      return { risk: "write", reasons: ["SELECT INTO"], tag: type };
    }
    if (node.locking_read) {
      return { risk: "write", reasons: ["locking SELECT"], tag: type };
    }
    return { risk: "read", reasons: [], tag: type };
  }

  if (WRITE_TYPES.has(type)) {
    return { risk: "write", reasons: [], tag: type };
  }

  if (type === "delete") {
    // DELETE without WHERE is destructive
    if (!node.where) {
      return { risk: "destructive", reasons: ["DELETE"], tag: type };
    }
    return { risk: "write", reasons: [], tag: type };
  }

  if (DESTRUCTIVE_TYPES.has(type)) {
    const reason = type === "drop" ? "DROP" :
      type === "truncate" ? "TRUNCATE" :
      type === "alter" ? "ALTER" :
      type === "create" ? "CREATE" : type.toUpperCase();
    return { risk: "destructive", reasons: [reason], tag: type };
  }

  if (BLOCKED_TYPES.has(type)) {
    return { risk: "blocked", reasons: [type.toUpperCase()], tag: type };
  }

  return { risk: "blocked", reasons: [`unsupported statement type: ${type}`], tag: type };
}

/**
 * Classify a MySQL/MariaDB SQL string using node-sql-parser.
 * Fail closed on parse error, unknown node, unsupported statement, or placeholder mismatch.
 */
export async function classifyMySQLSQL(sql: string, params: readonly unknown[] = []): Promise<Classification> {
  // Validate params before parsing
  if (params.some((p) => {
    if (p === null || typeof p === "boolean") return false;
    if (typeof p === "number") return !Number.isFinite(p);
    if (typeof p === "string") return false;
    return true;
  })) {
    throw err("E_CONFIG_INVALID", "SQL parameters must be finite scalar values");
  }

  const { Parser } = getParser();
  const parser = new Parser();

  let parsed: { ast: unknown };
  try {
    parsed = parser.parse(sql, { database: "mysql" }) as { ast: unknown };
  } catch {
    throw err("E_CONFIG_INVALID", "SQL parser rejected input");
  }

  const rawStatements = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
  if (!rawStatements.length || rawStatements.length > 20) {
    throw err(
      "E_CONFIG_INVALID",
      !rawStatements.length ? "SQL must contain at least one statement" : "SQL has too many statements (max 20)",
    );
  }

  const classifiedStatements: ClassifiedStatement[] = [];
  let overallRisk: RiskLevel = "read";
  let accumulatedParamCount = 0;

  for (let i = 0; i < rawStatements.length; i++) {
    const raw = rawStatements[i] as Record<string, unknown>;
    const { risk, reasons, tag } = classifyNode(raw);
    const tables = extractTables(raw);

    // Count ? placeholders in the raw SQL text
    const paramCount = countPlaceholders(raw);
    accumulatedParamCount += paramCount;

    if (rank[risk] > rank[overallRisk]) overallRisk = risk;

    classifiedStatements.push({
      index: i,
      tag,
      risk,
      tables,
      sqlFingerprint: fingerprint(sql),
      paramCount,
      reasons,
      sql: sql,
    });
  }

  // Validate param count matches (sum across statements for sequential ? placeholders)
  if (params.length !== accumulatedParamCount) {
    throw err("E_CONFIG_INVALID", "SQL parameters must exactly match references");
  }

  if (classifiedStatements.some((s) => s.risk === "blocked")) {
    throw err("E_CONFIG_INVALID", "SQL contains blocked statement");
  }

  return {
    riskLevel: overallRisk,
    statements: classifiedStatements,
    destructiveReasons: classifiedStatements
      .filter((s) => s.risk === "destructive")
      .flatMap((s) => s.reasons),
    maxParamRef: accumulatedParamCount,
  };
}
