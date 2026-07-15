import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonicalize } from "../core/canonicalize.js";
import { err } from "../core/errors.js";
import { persistPlan, loadPlan } from "../persistence/plan-store.js";
import type { Environment } from "../core/types.js";
import type { Classification, RiskLevel, StatementDescriptor } from "./classifier.js";
import type { DatabaseTarget } from "./target.js";
import { fingerprintLocalTarget } from "./target.js";

export function hash(v: unknown): string {
  return createHash("sha256").update(typeof v === "string" ? v : canonicalize(v)).digest("hex");
}

/** Convenience: hash SQL string. */
export function fingerprintSQL(sql: string): string {
  return hash(sql);
}

/** Convenience: hash params array. */
export function fingerprintParams(params: readonly unknown[]): string {
  return hash(params);
}

// Hex fingerprint regex: exactly 64 lowercase hex characters
const hex64 = /^[0-9a-f]{64}$/;
const hex64String = { pattern: "^[0-9a-f]{64}$" } as const;

const strict = { additionalProperties: false } as const;

export const DatabasePlanSchema = Type.Object({
  kind: Type.Literal("db-plan/1"),
  version: Type.Literal(1),
  planId: Type.String({ minLength: 1, maxLength: 200 }),
  planDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  providerFingerprint: Type.String(hex64String),
  manifestFingerprint: Type.String(hex64String),
  environment: Type.Union([
    Type.Literal("development"),
    Type.Literal("preview"),
    Type.Literal("production"),
  ]),
  targetFingerprint: Type.String(hex64String),
  statements: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0, maximum: 100 }),
    tag: Type.String({ minLength: 1, maxLength: 200 }),
    risk: Type.Union([
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("destructive"),
    ]),
    tables: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    sqlFingerprint: Type.String(hex64String),
    paramCount: Type.Integer({ minimum: 0, maximum: 100 }),
    reasons: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 100 }),
  }, strict), { minItems: 1, maxItems: 20 }),
  sqlFingerprint: Type.String(hex64String),
  paramFingerprint: Type.String(hex64String),
  paramCount: Type.Integer({ minimum: 0, maximum: 100 }),
  riskLevel: Type.Union([
    Type.Literal("write"),
    Type.Literal("destructive"),
  ]),
  destructiveReasons: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 100 }),
  createdAt: Type.String({ minLength: 1, maxLength: 100 }),
}, strict);

export type DatabasePlan = Static<typeof DatabasePlanSchema>;

export function computeDatabasePlanDigest(plan: Omit<DatabasePlan, "planDigest"> | DatabasePlan): string {
  const { planDigest: _ignored, ...rest } = plan as DatabasePlan;
  return hash(rest);
}

export function isDatabasePlan(value: unknown): value is DatabasePlan {
  if (!Value.Check(DatabasePlanSchema, value)) return false;
  const plan = value as Record<string, unknown>;
  // Semantics: verify all 64-hex fingerprints
  for (const key of ["planDigest", "providerFingerprint", "manifestFingerprint", "targetFingerprint", "sqlFingerprint", "paramFingerprint"]) {
    if (typeof plan[key] !== "string" || !hex64.test(plan[key] as string)) return false;
  }
  // createdAt must be canonical ISO timestamp.
  if (typeof plan.createdAt !== "string") return false;
  let canonicalCreatedAt: string;
  try { canonicalCreatedAt = new Date(plan.createdAt).toISOString(); } catch { return false; }
  if (canonicalCreatedAt !== plan.createdAt) return false;
  // Semantics: plan riskLevel must equal max statement risk
  const statements = plan.statements as Array<Record<string, unknown>>;
  if (!Array.isArray(statements) || statements.length === 0 || statements.length > 20) return false;
  const rank: Record<string, number> = { read: 0, write: 1, destructive: 2 };
  let maxStmtRisk = "read";
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i] as Record<string, unknown>;
    // Index must be contiguous starting 0
    if (s.index !== i) return false;
    // Statement risk never blocked (already in schema)
    if (rank[s.risk as string] === undefined) return false;
    if (rank[s.risk as string] > rank[maxStmtRisk]) maxStmtRisk = s.risk as string;
    // paramCount <= 100 (enforced by schema min/max)
    if (typeof s.paramCount !== "number" || s.paramCount < 0 || s.paramCount > 100) return false;
    // fingerprint must be 64-hex
    if (typeof s.sqlFingerprint !== "string" || !hex64.test(s.sqlFingerprint)) return false;
    // reasons must be string array
    if (!Array.isArray(s.reasons)) return false;
  }
  // Plan paramCount equals max statement paramCount
  const maxParam = statements.reduce((mx, s) => Math.max(mx, (s as Record<string, unknown>).paramCount as number), 0);
  if ((plan.paramCount as number) !== maxParam) return false;
  // Plan riskLevel equals max statement risk
  if (plan.riskLevel !== maxStmtRisk) return false;
  // destructiveReasons: planar deterministic flatten of destructive statement reasons
  const flatReasons: string[] = [];
  for (const s of statements) {
    if ((s as Record<string, unknown>).risk === "destructive") {
      flatReasons.push(...((s as Record<string, unknown>).reasons as string[]));
    }
  }
  const planReasons = plan.destructiveReasons as string[];
  if (!Array.isArray(planReasons)) return false;
  if (planReasons.length !== flatReasons.length) return false;
  for (let i = 0; i < planReasons.length; i++) {
    if (planReasons[i] !== flatReasons[i]) return false;
  }
  // Write plans must have no destructiveReasons; destructive plans must have nonempty
  if (plan.riskLevel === "write" && planReasons.length !== 0) return false;
  if (plan.riskLevel === "destructive" && planReasons.length === 0) return false;
  return computeDatabasePlanDigest(plan as DatabasePlan) === plan.planDigest;
}

export function validateDatabasePlan(value: unknown): DatabasePlan {
  if (!isDatabasePlan(value)) {
    throw err("E_CONFIG_INVALID", "database plan has invalid shape");
  }
  return value;
}

export function buildDatabasePlan(input: {
  environment: Environment;
  targetFingerprint: string;
  providerFingerprint: string;
  manifestFingerprint: string;
  sql: string;
  params: readonly unknown[];
  classification: Classification;
}): DatabasePlan {
  const cls = input.classification;
  if (cls.riskLevel === "read" || cls.riskLevel === "blocked") {
    throw err("E_CONFIG_INVALID", "plan requires write or destructive statements");
  }
  const riskLevel: DatabasePlan["riskLevel"] = cls.riskLevel === "destructive" ? "destructive" : "write";
  const statements: DatabasePlan["statements"] = cls.statements.map(({ sql: _sql, risk, ...statement }) => {
    if (risk !== "read" && risk !== "write" && risk !== "destructive") {
      throw err("E_CONFIG_INVALID", "plan contains blocked statement");
    }
    return { ...statement, risk };
  });
  const paramCount = cls.maxParamRef;
  const plan: DatabasePlan = {
    kind: "db-plan/1",
    version: 1,
    planId: randomUUID(),
    planDigest: "",
    providerFingerprint: input.providerFingerprint,
    manifestFingerprint: input.manifestFingerprint,
    environment: input.environment,
    targetFingerprint: input.targetFingerprint,
    statements,
    sqlFingerprint: hash(input.sql),
    paramFingerprint: hash(input.params),
    paramCount,
    riskLevel,
    destructiveReasons: cls.destructiveReasons,
    createdAt: new Date().toISOString(),
  };
  plan.planDigest = computeDatabasePlanDigest(plan);
  if (!isDatabasePlan(plan)) {
    throw err("E_CONFIG_INVALID", "built database plan failed validation");
  }
  return plan;
}

export async function persistDatabasePlan(cwd: string, plan: DatabasePlan): Promise<void> {
  validateDatabasePlan(plan);
  await persistPlan(cwd, plan, { isValid: isDatabasePlan, computeDigest: (value: unknown) => computeDatabasePlanDigest(validateDatabasePlan(value)) });
}

export async function loadDatabasePlan(cwd: string, planId: string): Promise<DatabasePlan> {
  return validateDatabasePlan(await loadPlan(cwd, planId, { isValid: isDatabasePlan, computeDigest: (value: unknown) => computeDatabasePlanDigest(validateDatabasePlan(value)) }));
}

/**
 * Compute a deterministic fingerprint for the database target.
 * Accepts a URL string, a DatabaseTarget object, or undefined.
 * Normalize postgres/postgresql protocol identity for remote targets.
 * Throws E_AUTH_MISSING when undefined, E_CONFIG_INVALID when malformed.
 * URL/password never appear in result or error messages.
 */
export function fingerprintTarget(target: string | DatabaseTarget | undefined): string {
  if (target === undefined) throw err("E_AUTH_MISSING", "DATABASE_URL missing");
  if (typeof target === "object") {
    if (target.kind === "remote") return fingerprintRemoteURL(target.url);
    if (target.kind === "local") return fingerprintLocalTarget(target.dataDir);
    return hash({ kind: "file", dialect: "sqlite", path: target.path });
  }
  return fingerprintRemoteURL(target);
}

function fingerprintRemoteURL(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const protocol = url.protocol.slice(0, -1);
    if (protocol !== "postgres" && protocol !== "postgresql") throw new Error("protocol");
    if (!url.hostname || !url.pathname || url.pathname === "/" || !url.username) throw new Error("target");
    const ssl = [...url.searchParams.entries()]
      .filter(([key]) => /^(sslmode|ssl|sslrootcert|sslcert|sslkey)$/i.test(key))
      .sort();
    return hash({
      protocol: "postgres",
      host: url.hostname.toLowerCase(),
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      ssl,
    });
  } catch {
    throw err("E_CONFIG_INVALID", "database target URL invalid");
  }
}
