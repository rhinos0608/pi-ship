import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySQL } from "../../../src/database/classifier.js";
import { classifySQLiteSQL } from "../../../src/database/dialect/sqlite/classifier.js";
import { classifyMySQLSQL } from "../../../src/database/dialect/mysql/classifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "../../fixtures/database/dialect-classification.json");

interface FixtureExpect {
  riskLevel?: string;
  statementCount?: number;
  error?: boolean;
}

interface FixtureEntry {
  dialect: string | string[];
  sql: string;
  params?: readonly unknown[];
  expect: FixtureExpect;
}

/** Load and validate the fixture corpus. */
function loadFixtures(): FixtureEntry[] {
  const raw = JSON.parse(readFileSync(fixturePath, "utf-8"));
  return raw.filter((entry: unknown): entry is FixtureEntry => {
    if (typeof entry === "string") return false; // skip comments
    return entry !== null && typeof entry === "object" && "sql" in (entry as any);
  });
}

const fixtures = loadFixtures();

/** Return the list of dialects an entry targets. */
function targetDialects(dialect: string | string[]): string[] {
  return Array.isArray(dialect) ? dialect : [dialect];
}

/** Pick the correct classify function for the dialect. */
function classifyForDialect(dialect: string, sql: string, params: readonly unknown[]): Promise<any> {
  switch (dialect) {
    case "postgres":
      return classifySQL(sql, params);
    case "sqlite":
      return classifySQLiteSQL(sql, params);
    case "mysql":
      return classifyMySQLSQL(sql, params);
    default:
      throw new Error(`unknown dialect: ${dialect}`);
  }
}

// ── Group fixtures by dialect for reporting ──────────────────────────────
describe("dialect-classification.json fixtures", () => {
  const dialects = ["postgres", "sqlite", "mysql"];

  for (const dialect of dialects) {
    describe(dialect, () => {
      const cases = fixtures.filter((f) => targetDialects(f.dialect).includes(dialect));

      if (cases.length === 0) {
        it("has no fixture entries", () => {});
        return;
      }

      for (let i = 0; i < cases.length; i++) {
        const entry = cases[i]!;
        const label = entry.sql.length > 80 ? entry.sql.slice(0, 77) + "..." : entry.sql;

        it(`${i}: ${label}`, async () => {
          const params = entry.params ?? [];

          if (entry.expect.error) {
            await expect(
              classifyForDialect(dialect, entry.sql, params),
            ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
          } else {
            const result = await classifyForDialect(dialect, entry.sql, params);
            if (entry.expect.riskLevel !== undefined) {
              expect(result.riskLevel).toBe(entry.expect.riskLevel);
            }
            if (entry.expect.statementCount !== undefined) {
              expect(result.statements).toHaveLength(entry.expect.statementCount);
            }
            // Verify all statements have valid indexes
            for (let s = 0; s < result.statements.length; s++) {
              expect(result.statements[s]!.index).toBe(s);
            }
            // Verify all fingerprints are 64-char lowercase hex
            for (const stmt of result.statements) {
              expect(stmt.sqlFingerprint).toMatch(/^[0-9a-f]{64}$/);
            }
            // Verify valid risk values
            for (const stmt of result.statements) {
              expect(["read", "write", "destructive", "blocked"]).toContain(stmt.risk);
            }
            // Check paramCount consistency
            expect(result.maxParamRef).toBeGreaterThanOrEqual(0);
          }
        });
      }
    });
  }
});
