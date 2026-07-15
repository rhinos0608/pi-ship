import { describe, expect, it } from "vitest";
import { postgresAdapter } from "../../../src/database/dialect/postgres.js";
import { sqliteAdapter } from "../../../src/database/dialect/sqlite/index.js";
import { mysqlAdapter } from "../../../src/database/dialect/mysql/index.js";
import type { DialectAdapter } from "../../../src/database/dialect/contracts.js";

/**
 * Contract invariants (Task 6 — cross-engine classifier corpus and contract fixtures):
 *
 * 1. Blocked classification never produces a successful result (always throws E_CONFIG_INVALID).
 * 2. Statement index is zero-based.
 * 3. Risk values are valid ("read" | "write" | "destructive" | "blocked").
 * 4. Fingerprints are 64-character lower-case hex strings.
 * 5. Public-query classifier (assertPublicQuery) rejects any non-single-read result.
 */

const ALL_ADAPTERS: DialectAdapter[] = [postgresAdapter, sqliteAdapter, mysqlAdapter];

// ── SQL that should produce a "blocked" classification per dialect ──────
const BLOCKED_SAMPLES: Record<string, Array<{ sql: string; params?: readonly unknown[] }>> = {
  postgres: [
    { sql: "SELECT pg_sleep(1)" },
    { sql: "CREATE EXTENSION hstore" },
    { sql: "SHOW statement_timeout" },
  ],
  sqlite: [
    { sql: "PRAGMA wal_checkpoint" },
    { sql: "PRAGMA unknown_pragma" },
    { sql: "SEL ECT 1" },
  ],
  mysql: [
    { sql: "SHOW TABLES" },
    { sql: "SET NAMES utf8" },
    { sql: "SEL ECT 1" },
  ],
};

// ── SQL that should produce a successful (non-blocked) classification ───
const SUCCESS_SAMPLES: Record<string, Array<{ sql: string; params?: readonly unknown[] }>> = {
  postgres: [
    { sql: "SELECT 1" },
    { sql: "SELECT $1", params: [1] },
    { sql: "INSERT INTO users (name) VALUES ($1)", params: ["alice"] },
    { sql: "DELETE FROM users WHERE id = $1", params: [1] },
  ],
  sqlite: [
    { sql: "SELECT 1" },
    { sql: "SELECT ?", params: [42] },
    { sql: "INSERT INTO users (name) VALUES (?)", params: ["bob"] },
    { sql: "PRAGMA table_info('users')" },
    { sql: "PRAGMA schema_version" },
  ],
  mysql: [
    { sql: "SELECT 1" },
    { sql: "SELECT ?", params: [42] },
    { sql: "INSERT INTO users (name) VALUES (?)", params: ["carol"] },
    { sql: "DELETE FROM users WHERE id = ?", params: [1] },
  ],
};

// ── SQL for public-query contract checks ────────────────────────────────
const PUBLIC_QUERY_VALID: Record<string, Array<{ sql: string; params?: readonly unknown[] }>> = {
  postgres: [{ sql: "SELECT 1" }, { sql: "SELECT $1", params: [1] }],
  sqlite: [{ sql: "SELECT 1" }, { sql: "SELECT ?", params: [42] }],
  mysql: [{ sql: "SELECT 1" }, { sql: "SELECT ?", params: [42] }],
};

const PUBLIC_QUERY_INVALID: Record<string, Array<{ sql: string; params?: readonly unknown[] }>> = {
  postgres: [
    { sql: "SELECT 1; SELECT 2" },
    { sql: "INSERT INTO users (name) VALUES ($1)", params: ["alice"] },
    { sql: "DELETE FROM users WHERE id = $1", params: [1] },
  ],
  sqlite: [
    { sql: "SELECT 1; SELECT 2" },
    { sql: "INSERT INTO users (name) VALUES (?)", params: ["bob"] },
    { sql: "DELETE FROM users WHERE id = ?", params: [1] },
  ],
  mysql: [
    { sql: "SELECT 1; SELECT 2" },
    { sql: "INSERT INTO users (name) VALUES (?)", params: ["carol"] },
    { sql: "DELETE FROM users WHERE id = ?", params: [1] },
  ],
};

// ── SQL for assertPublicPlan contract checks ─────────────────────────────
const PUBLIC_PLAN_VALID_WRITE: Record<string, Array<{ sql: string; params?: readonly unknown[] }>> = {
  postgres: [{ sql: "INSERT INTO users (name) VALUES ($1)", params: ["dave"] }],
  sqlite: [{ sql: "INSERT INTO users (name) VALUES (?)", params: ["dave"] }],
  mysql: [{ sql: "INSERT INTO users (name) VALUES (?)", params: ["dave"] }],
};

const PUBLIC_PLAN_INVALID_READ: Array<{ sql: string; params?: readonly unknown[] }> = [
  { sql: "SELECT 1" },
];

// ── Helper ────────────────────────────────────────────────────────────────
function adapterForDialect(dialect: string): DialectAdapter {
  const adapter = ALL_ADAPTERS.find((a) => a.id === dialect);
  if (!adapter) throw new Error(`no adapter for ${dialect}`);
  return adapter;
}

// ── Contract 1: Blocked never yields a result ────────────────────────────
describe("Contract: blocked never yields a result", () => {
  for (const dialect of Object.keys(BLOCKED_SAMPLES)) {
    const adapter = adapterForDialect(dialect);
    describe(`${adapter.id} (${adapter.label})`, () => {
      for (const sample of BLOCKED_SAMPLES[dialect]!) {
        it(`throws for: ${sample.sql}`, async () => {
          await expect(
            adapter.classify(sample.sql, sample.params ?? []),
          ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
        });
      }
    });
  }
});

// ── Contract 2, 3, 4: Index zero-based, valid risk, 64-hex fingerprint ───
describe("Contract: statement invariants", () => {
  for (const dialect of Object.keys(SUCCESS_SAMPLES)) {
    const adapter = adapterForDialect(dialect);
    describe(`${adapter.id} (${adapter.label})`, () => {
      for (const sample of SUCCESS_SAMPLES[dialect]!) {
        it(`index/risk/fingerprint: ${sample.sql}`, async () => {
          const result = await adapter.classify(sample.sql, sample.params ?? []);

          // Statement index must be zero-based
          for (let i = 0; i < result.statements.length; i++) {
            expect(result.statements[i]!.index).toBe(i);
          }

          // Risk values must be valid
          const validRisks = ["read", "write", "destructive", "blocked"];
          for (const stmt of result.statements) {
            expect(validRisks).toContain(stmt.risk);
          }

          // Fingerprints must be 64-character lowercase hex
          for (const stmt of result.statements) {
            expect(stmt.sqlFingerprint).toMatch(/^[0-9a-f]{64}$/);
          }

          // No blocked statement survives classify without throw
          expect(result.riskLevel).not.toBe("blocked");
        });
      }
    });
  }
});

// ── Contract 5: Public-query classifier rejects non-single-read ──────────
describe("Contract: assertPublicQuery rejects non-single-read", () => {
  for (const dialect of Object.keys(PUBLIC_QUERY_VALID)) {
    const adapter = adapterForDialect(dialect);
    describe(`${adapter.id} (${adapter.label})`, () => {
      // Valid cases must pass
      for (const sample of PUBLIC_QUERY_VALID[dialect]!) {
        it(`accepts single read: ${sample.sql}`, async () => {
          const result = await adapter.assertPublicQuery(sample.sql, sample.params ?? []);
          expect(result.riskLevel).toBe("read");
          expect(result.statements).toHaveLength(1);
        });
      }

      // Invalid cases must throw
      for (const sample of PUBLIC_QUERY_INVALID[dialect]!) {
        it(`rejects non-single-read: ${sample.sql}`, async () => {
          await expect(
            adapter.assertPublicQuery(sample.sql, sample.params ?? []),
          ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
        });
      }
    });
  }
});

// ── assertPublicPlan contract check ───────────────────────────────────────
describe("Contract: assertPublicPlan rejects read-only", () => {
  for (const dialect of Object.keys(PUBLIC_PLAN_VALID_WRITE)) {
    const adapter = adapterForDialect(dialect);
    describe(`${adapter.id} (${adapter.label})`, () => {
      for (const sample of PUBLIC_PLAN_VALID_WRITE[dialect]!) {
        it(`accepts write plan: ${sample.sql}`, async () => {
          const result = await adapter.assertPublicPlan(sample.sql, sample.params ?? []);
          expect(result.riskLevel).not.toBe("read");
        });
      }

      for (const sample of PUBLIC_PLAN_INVALID_READ) {
        it(`rejects read-only plan: ${sample.sql}`, async () => {
          await expect(
            adapter.assertPublicPlan(sample.sql, sample.params ?? []),
          ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
        });
      }
    });
  }
});

// ── MariaDB alias routing (via mysqlAdapter) ─────────────────────────────
describe("MariaDB alias routing", () => {
  it("mysqlAdapter handles mariadb:// URLs via scheme", () => {
    // The adapter declares schemes: ["mysql", "mariadb"] — verify
    expect(mysqlAdapter.schemes).toContain("mariadb");
    expect(mysqlAdapter.schemes).toContain("mysql");
  });

  it("mysqlAdapter classify works same for MySQL SQL", async () => {
    const result = await mysqlAdapter.classify("SELECT 1", []);
    expect(result.riskLevel).toBe("read");
    expect(result.statements).toHaveLength(1);
  });
});
