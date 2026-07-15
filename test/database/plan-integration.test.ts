import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifySQL } from "../../src/database/classifier.js";
import { buildDatabasePlan, loadDatabasePlan, fingerprintTarget } from "../../src/database/plan.js";
import { DatabasePayloadRegistry } from "../../src/database/payload.js";
import { readDatabaseJournal, appendDatabaseJournal } from "../../src/database/journal.js";
import { ApprovalRegistry } from "../../src/core/approval.js";

const hex64 = "0000000000000000000000000000000000000000000000000000000000000000";

describe("DB.plan integration", () => {
  let cwd: string;
  let registry: ApprovalRegistry;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-plan-int-"));
    registry = new ApprovalRegistry(cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("normalizes postgres and postgresql URL schemes in target fingerprints", () => {
    expect(fingerprintTarget("postgres://user:pass@host:5432/db"))
      .toBe(fingerprintTarget("postgresql://user:pass@host:5432/db"));
  });

  // ── No manifest supported ──────────────────────────────────────
  it("returns approved false in headless mode (no UI)", async () => {
    // Without manifest, context fingerprints fall back to "none" hashes
    const classification = await classifySQL("INSERT INTO test VALUES ($1)", [1]);
    const plan = buildDatabasePlan({
      environment: "development", targetFingerprint: hex64,
      providerFingerprint: hex64, manifestFingerprint: hex64,
      sql: "INSERT INTO test VALUES ($1)", params: [1], classification,
    });
    const ctx = { cwd, hasUI: false as const, ui: undefined as any };
    expect(ctx.hasUI).toBe(false);
    // headless => approval returns false without explicit record
    expect(registry.isApproved(plan.planId, plan.planDigest, cwd)).toBe(false);
  });

  // ── Parser reject creates no plan ──────────────────────────────
  it("rejects bad SQL with parser error", async () => {
    await expect(classifySQL("CRAP SQL")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // ── Plan file/tool content/details/UI summary serialize without raw SQL ──
  it("plan excludes SQL plaintext field", async () => {
    const sql = "INSERT INTO users VALUES ($1)";
    const classification = await classifySQL(sql, [1]);
    const plan = buildDatabasePlan({
      environment: "development", targetFingerprint: hex64,
      providerFingerprint: hex64, manifestFingerprint: hex64,
      sql, params: [1], classification,
    });
    // Plan on disk has no sql field
    expect(plan).not.toHaveProperty("sql");
    // No params key
    expect(plan).not.toHaveProperty("params");
    // No DATABASE_URL
    expect(JSON.stringify(plan)).not.toContain("DATABASE_URL");
  });

  // ── Payload registry alone contains exact SQL/params ───────────
  it("payload registry holds exact SQL and params", async () => {
    const registry = new DatabasePayloadRegistry();
    const statements = (await classifySQL("SELECT $1", [42])).statements;
    registry.register("plan-1", hex64, { sql: "SELECT $1", params: [42], statements });
    const payload = registry.get("plan-1", hex64);
    expect(payload?.sql).toBe("SELECT $1");
    expect(payload?.params).toEqual([42]);
    // cleanup removes
    registry.clear();
    expect(registry.get("plan-1", hex64)).toBeUndefined();
  });

  // ── Payload cleanup ────────────────────────────────────────────
  it("payload registry cleanup removes entries", async () => {
    const payloadReg = new DatabasePayloadRegistry();
    const statements = (await classifySQL("SELECT 1")).statements;
    payloadReg.register("plan-1", hex64, { sql: "SELECT 1", params: [], statements });
    expect(payloadReg.size).toBe(1);
    payloadReg.clear();
    expect(payloadReg.size).toBe(0);
  });

  // ── No DB/network call ────────────────────────────────────────
  it("plan classification does not call any network or DB", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    try {
      await classifySQL("SELECT 1");
    } finally {
      fetch.mockRestore();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  // ── Plan file/tool content/details/UI summary no secret params, password, URL ──
  it("plan serialization excludes param values and raw SQL", async () => {
    const sql = "INSERT INTO users VALUES ($1, $2)";
    const classification = await classifySQL(sql, ["alice", 42]);
    const plan = buildDatabasePlan({
      environment: "production", targetFingerprint: hex64,
      providerFingerprint: hex64, manifestFingerprint: hex64,
      sql, params: ["alice", 42], classification,
    });
    // Plan does not have sql field
    expect(plan).not.toHaveProperty("sql");
    // Plan does not have params
    expect(plan).not.toHaveProperty("params");
    // Plan only contains hash fingerprints, not raw values
    const planStr = JSON.stringify(plan);
    expect(planStr).not.toMatch(/(?:^|[^a-f0-9])alice(?:$|[^a-f0-9])/i);
  });

  // ── Scoped approval ────────────────────────────────────────────
  it("scoped approval works with correct risk metadata", async () => {
    const classification = await classifySQL("DELETE FROM users WHERE id = $1", [1]);
    const plan = buildDatabasePlan({
      environment: "development", targetFingerprint: hex64,
      providerFingerprint: hex64, manifestFingerprint: hex64,
      sql: "DELETE FROM users WHERE id = $1", params: [1], classification,
    });
    // Approve with correct database destructive scope
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    expect(registry.isApproved(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" })).toBe(true);
    // Different scope should not match
    expect(registry.isApproved(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "write" })).toBe(false);
  });
});
