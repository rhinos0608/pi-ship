import { mkdtemp, rm, writeFile, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifySQL } from "../../src/database/classifier.js";
import { buildDatabasePlan, persistDatabasePlan, fingerprintTarget, fingerprintSQL, fingerprintParams, hash } from "../../src/database/plan.js";
import type { DatabasePlan } from "../../src/database/plan.js";
import { DatabasePayloadRegistry } from "../../src/database/payload.js";
import type { DBScalar } from "../../src/database/payload.js";
import { applyDatabasePlan } from "../../src/database/apply.js";
import type { ApplyDatabasePlanOptions, ApplyDatabasePlanResult } from "../../src/database/apply.js";
import { readDatabaseJournal, appendDatabaseJournal, databaseJournalPath } from "../../src/database/journal.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import type { DatabaseClient } from "../../src/database/client.js";
import type { Environment } from "../../src/core/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const TEST_DB_URL = "postgres://user:pass@localhost:5432/testdb";
const TEST_TARGET_FP = fingerprintTarget(TEST_DB_URL);

function makeZeroClient(): DatabaseClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ fields: [], rows: [], rowCount: 0, command: "SELECT" }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSpyClient(): { client: DatabaseClient; connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  const connect = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue({ fields: [], rows: [], rowCount: 0, command: "SELECT" });
  const end = vi.fn().mockResolvedValue(undefined);
  return { client: { connect, query, end }, connect, query, end };
}

async function buildAndRegister(
  cwd: string,
  sql: string,
  params: DBScalar[],
  overrides: Partial<{
    environment: Environment;
    targetFingerprint: string;
    providerFingerprint: string;
    manifestFingerprint: string;
  }> = {},
): Promise<{ plan: DatabasePlan; payloads: DatabasePayloadRegistry; registry: ApprovalRegistry }> {
  const classification = await classifySQL(sql, params);
  const plan = buildDatabasePlan({
    environment: overrides.environment ?? "development",
    targetFingerprint: overrides.targetFingerprint ?? TEST_TARGET_FP,
    providerFingerprint: overrides.providerFingerprint ?? hash("none::provider"),
    manifestFingerprint: overrides.manifestFingerprint ?? hash("none::manifest"),
    sql,
    params,
    classification,
  });
  await persistDatabasePlan(cwd, plan);
  const payloads = new DatabasePayloadRegistry();
  payloads.register(plan.planId, plan.planDigest, { sql, params, statements: classification.statements });
  const registry = new ApprovalRegistry(cwd);
  const risk = plan.riskLevel === "destructive" ? "destructive" : "write";
  registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk });
  return { plan, payloads, registry };
}

function makeApplyPlan(plan: DatabasePlan, overrides: Partial<ApplyDatabasePlanOptions> = {}): ApplyDatabasePlanOptions {
  return {
    cwd: "",
    planId: plan.planId,
    planDigest: plan.planDigest,
    environment: plan.environment,
    databaseUrl: TEST_DB_URL,
    providerFingerprint: plan.providerFingerprint,
    manifestFingerprint: plan.manifestFingerprint,
    productionFlag: undefined,
    registry: new ApprovalRegistry(""),
    payloads: new DatabasePayloadRegistry(),
    clientFactory: () => makeZeroClient(),
    signal: undefined,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("applyDatabasePlan preflight failures (zero client)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-apply-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("rejects plan digest mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, planDigest: "0000000000000000000000000000000000000000000000000000000000000001", payloads, registry, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects approval with wrong domain", async () => {
    const { plan, payloads } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "write" });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects approval with wrong risk level", async () => {
    const { plan, payloads } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects missing production flag when environment is production", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], {
      environment: "production",
    });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, environment: "production", productionFlag: undefined, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects production flag values other than exact 'true'", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], {
      environment: "production",
    });
    const factorySpy = vi.fn(makeZeroClient);
    for (const flag of ["TRUE", "1", "true ", "yes", ""]) {
      await expect(applyDatabasePlan(makeApplyPlan(plan, {
        cwd, environment: "production", productionFlag: flag, registry, payloads, clientFactory: factorySpy,
      }))).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    }
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("accepts exact 'true' production flag", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], {
      environment: "production",
    });
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const result = await applyDatabasePlan(makeApplyPlan(plan, {
      cwd, environment: "production", productionFlag: "true", registry, payloads,
      clientFactory: () => client,
    }));
    expect(result.status).toBe("committed");
    expect(query).toHaveBeenCalled();
  });

  it("rejects environment mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], {
      environment: "production",
    });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, environment: "development", registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects target fingerprint mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const otherUrl = "postgres://other:pass@otherhost:5432/otherdb";
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, databaseUrl: otherUrl, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects provider fingerprint mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, providerFingerprint: hash("other-provider"), registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects manifest fingerprint mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, manifestFingerprint: hash("other-manifest"), registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects missing payload (restart scenario)", async () => {
    const { plan, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const factorySpy = vi.fn(makeZeroClient);
    const emptyPayloads = new DatabasePayloadRegistry();
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads: emptyPayloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects SQL fingerprint mismatch (payload tamper)", async () => {
    const { plan, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    // Register tampered payload with different SQL
    const tamperedPayloads = new DatabasePayloadRegistry();
    const tamperedStatements = (await classifySQL("INSERT INTO t VALUES ($1)", [1])).statements;
    tamperedPayloads.register(plan.planId, plan.planDigest, {
      sql: "INSERT INTO t VALUES ($1)", // Same actual SQL, but we need different fingerprint
      params: [1],
      statements: tamperedStatements,
    });
    // This doesn't actually change the fingerprint - need different SQL
    const diffPayloads = new DatabasePayloadRegistry();
    const diffStatements = (await classifySQL("DELETE FROM t", [])).statements;
    diffPayloads.register(plan.planId, plan.planDigest, {
      sql: "DELETE FROM t",
      params: [],
      statements: diffStatements,
    });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads: diffPayloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects replay of committed plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint,
      providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "committed",
      at: new Date().toISOString(),
    });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects replay of ambiguous plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint,
      providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "ambiguous",
      at: new Date().toISOString(), errorCode: "E_STATE_CONFLICT",
    });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("rejects replay of dangling started plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint,
      providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "started",
      at: new Date().toISOString(),
    });
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("allows retry after failed plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint,
      providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "failed", at: new Date().toISOString(), errorCode: "E_PROVIDER",
    });
    const { client } = makeSpyClient();
    const result = await applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client,
    }));
    expect(result.status).toBe("committed");
  });
});

describe("applyDatabasePlan execution", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-apply-exec-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("uses exactly one client for success path", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, connect, query, end } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const result = await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    expect(result.status).toBe("committed");
    expect(result.statementCount).toBe(1);
    expect(result.affectedRows).toBe(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("executes BEGIN, SET LOCAL timeouts before statements", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    const sqlCalls = query.mock.calls.map((c: unknown[]) => c[0]);
    expect(sqlCalls[0]).toBe("BEGIN");
    expect(sqlCalls[1]).toBe("SET LOCAL statement_timeout = '30000ms'");
    expect(sqlCalls[2]).toBe("SET LOCAL lock_timeout = '5000ms'");
    expect(sqlCalls[3]).toBe("INSERT INTO t VALUES ($1)");
    expect(sqlCalls[4]).toBe("COMMIT");
  });

  it("binds params as exact prefix of payload params", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1, $2)", [10, 20]);
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    const boundParams = query.mock.calls[3][1];
    expect(boundParams).toEqual([10, 20]);
  });

  it("runs multi-statement plan in single transaction", async () => {
    // Use $1 in both statements so contiguous param ref is satisfied
    // accumulatedParamCount = 1 + 1 = 2 (one per statement)
    const sql = "INSERT INTO a VALUES ($1); UPDATE b SET x = $1 WHERE id = $1";
    const params = [1, 1];
    const classification = await classifySQL(sql, params);
    const plan = buildDatabasePlan({
      environment: "development", targetFingerprint: TEST_TARGET_FP,
      providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest"),
      sql, params, classification,
    });
    await persistDatabasePlan(cwd, plan);
    const payloads = new DatabasePayloadRegistry();
    payloads.register(plan.planId, plan.planDigest, { sql, params, statements: classification.statements });
    const registry = new ApprovalRegistry(cwd);
    const risk = plan.riskLevel === "destructive" ? "destructive" : "write";
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk });
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    // BEGIN, SET x 2, stmt1, stmt2, COMMIT
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls[3][0]).toContain("INSERT INTO a");
    expect(query.mock.calls[4][0]).toContain("UPDATE b");
    expect(query.mock.calls[5][0]).toBe("COMMIT");
  });

  it("does not retry on query failure", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("pg error"), { code: "23505" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    // Only 1 INSERT attempt — no retry
    const insertCalls = query.mock.calls.filter((c: unknown[]) => (c[0] as string).includes("INSERT"));
    expect(insertCalls).toHaveLength(1);
  });

  it("does not return SQL, params, URL, or rows in results", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client } = makeSpyClient();
    const result = await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    const json = JSON.stringify(result);
    expect(json).not.toContain("INSERT");
    expect(json).not.toContain("password");
    expect(json).not.toContain("localhost");
    expect(result).toEqual({
      planId: plan.planId,
      planDigest: plan.planDigest,
      status: "committed",
      statementCount: 1,
      affectedRows: 0,
    });
  });

  it("concurrent same-plan applies: one mutation max, second blocked", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client: client1, query: q1 } = makeSpyClient();
    const { client: client2, query: q2 } = makeSpyClient();
    q1.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    q2.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });

    // Start both concurrently — one must succeed, one must be blocked
    const results = await Promise.allSettled([
      applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client1 })),
      applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client2 })),
    ]);

    const committed = results.filter((r) => r.status === "fulfilled" && r.value.status === "committed");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(committed.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0] && "reason" in rejected[0]) {
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "E_STATE_CONFLICT" });
    }
  });
});

describe("applyDatabasePlan failure semantics", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-apply-fail-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("abort before write dispatch: failed E_CANCELLED, manual retry", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const ac = new AbortController();
    const { client, query } = makeSpyClient();
    ac.abort(); // Pre-abort before any call
    const factorySpy = vi.fn(() => client);
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy, signal: ac.signal,
    }))).rejects.toMatchObject({ code: "E_CANCELLED" });
    // No journal entry — abort happened before started append
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.length).toBe(0);
    // Manual retry allowed — no journal entry, no replay block
    const { client: client2, query: q2 } = makeSpyClient();
    q2.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const result = await applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client2,
    }));
    expect(result.status).toBe("committed");
  });

  it("SQLSTATE (non-08) during statement: rollback + failed, no auto retry", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    // ROLLBACK should have been attempted
    const rollbackCalls = query.mock.calls.filter((c: unknown[]) => c[0] === "ROLLBACK");
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    // Journal should show failed with SQLSTATE
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("failed");
    expect(matching.at(-1)?.errorCode).toBe("23505");
  });

  it("transport error during statement after write dispatch: ambiguous", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    // Journal should show ambiguous
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("ambiguous");
  });

  it("57014 (query cancelled) during statement: failed, not ambiguous", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("cancelled"), { code: "57014" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_CANCELLED" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("failed");
    expect(matching.at(-1)?.errorCode).toBe("57014");
  });

  it("transport error during COMMIT: ambiguous", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) return { fields: [], rows: [], rowCount: 1, command: "INSERT" };
      if (idx === 5) throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("ambiguous");
  });

  it("connect failure: started entry exists, no DB mutation", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const connect = vi.fn().mockRejectedValue(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }));
    const end = vi.fn();
    const client = { connect, query: vi.fn(), end };
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    // started entry exists (appended before connect), plus failed entry
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.length).toBe(2);
    expect(matching[0]?.status).toBe("started");
    expect(matching[1]?.status).toBe("failed");
    // Connect failed, began=false, so no BEGIN/ROLLBACK
    expect(client.query).not.toHaveBeenCalled();
    // End is best-effort
    expect(end).toHaveBeenCalled();
  });
});

describe("applyDatabasePlan journal integrity", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-apply-jrnl-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("journal chain contains no SQL/params/password/URL", async () => {
    const { plan, payloads, registry } = await buildAndRegister(
      cwd,
      "INSERT INTO users (password) VALUES ($1)",
      ["secret123"],
    );
    const { client } = makeSpyClient();
    await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    const journal = await readDatabaseJournal(cwd);
    const journalText = JSON.stringify(journal);
    expect(journalText).not.toContain("secret123");
    expect(journalText).not.toContain("password");
    expect(journalText).not.toContain("INSERT");
    expect(journalText).not.toContain("localhost");
    expect(journalText).not.toContain("postgres://");
  });

  it("journal chain hash integrity after successful apply", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });

    await applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client }));
    const journal = await readDatabaseJournal(cwd);
    expect(journal.length).toBe(2);
    expect(journal[0]?.status).toBe("started");
    expect(journal[1]?.status).toBe("committed");
    expect(journal[0]?.hash).toBe(journal[1]?.previousHash);
  });
});

describe("applyDatabasePlan additional safety tests", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-apply-safety-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("factory throw: started+failed, safe message, end unavailable", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const factoryErr = Object.assign(new Error("factory explosion"), { code: "CONNECTION_FAILURE" });
    const factorySpy = vi.fn().mockImplementation(() => { throw factoryErr; });
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: factorySpy,
    }))).rejects.toMatchObject({ code: "E_PROVIDER" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.length).toBe(2);
    expect(matching[0]?.status).toBe("started");
    expect(matching[1]?.status).toBe("failed");
    const jText = JSON.stringify(journal);
    expect(jText).not.toContain("factory explosion");
    expect(jText).not.toContain("localhost");
    expect(jText).not.toContain("password");
  });

  it("abort after write with rollback success: failed E_CANCELLED, manual retry", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const ac = new AbortController();
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async (text: string) => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) {
        ac.abort();
        throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
      }
      if (idx === 5) return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" }; // rollback succeeds
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client, signal: ac.signal,
    }))).rejects.toMatchObject({ code: "E_CANCELLED" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("failed");
    expect(matching.at(-1)?.errorCode).toBe("E_CANCELLED");
    // Manual retry allowed
    const { client: client2, query: q2 } = makeSpyClient();
    q2.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const result = await applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client2,
    }));
    expect(result.status).toBe("committed");
  });

  it("abort after write with rollback failure: ambiguous", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const ac = new AbortController();
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async (text: string) => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) {
        ac.abort();
        throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
      }
      // ROLLBACK (idx=5) fails
      if (idx === 5) throw Object.assign(new Error("rollback failed"), { code: "08000" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client, signal: ac.signal,
    }))).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("ambiguous");
  });

  it("SQLSTATE handler calls end exactly once", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query, end } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("transport error handler calls end exactly once", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query, end } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("conn lost"), { code: "ECONNRESET" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("affectedRows counts only write/destructive statements", async () => {
    const sql = "INSERT INTO t VALUES ($1); SELECT 1";
    const classification = await classifySQL(sql, [1]);
    const plan = buildDatabasePlan({
      environment: "development", targetFingerprint: TEST_TARGET_FP,
      providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest"),
      sql, params: [1], classification,
    });
    await persistDatabasePlan(cwd, plan);
    const payloads = new DatabasePayloadRegistry();
    payloads.register(plan.planId, plan.planDigest, { sql, params: [1], statements: classification.statements });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "write" });
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) return { fields: [], rows: [], rowCount: 5, command: "INSERT" };
      if (idx === 5) return { fields: [], rows: [], rowCount: 1, command: "SELECT" };
      if (idx === 6) return { fields: [], rows: [], rowCount: 0, command: "COMMIT" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const result = await applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client,
    }));
    expect(result.affectedRows).toBe(5);
    expect(result.statementCount).toBe(2);
  });

  it("ambiguous plan blocks second call with zero client", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    // First: transport error after write dispatch => ambiguous
    const { client: c1, query: q1 } = makeSpyClient();
    let idx1 = 0;
    q1.mockImplementation(async () => {
      idx1++;
      if (idx1 === 4) throw Object.assign(new Error("conn reset"), { code: "ECONNRESET" });
      if (idx1 === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx1 === 2 || idx1 === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => c1 })))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    // Second: zero client created
    const factorySpy = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: factorySpy })))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("A: successful statement then abort before COMMIT: rollback, failed E_CANCELLED, manual retry", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const ac = new AbortController();
    const { client, query, end } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) { ac.abort(); return { fields: [], rows: [], rowCount: 1, command: "INSERT" }; }
      if (idx === 5) return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => client, signal: ac.signal,
    }))).rejects.toMatchObject({ code: "E_CANCELLED" });
    // ROLLBACK was issued
    expect(query.mock.calls.some((c: unknown[]) => c[0] === "ROLLBACK")).toBe(true);
    // Journal: started + failed E_CANCELLED
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("failed");
    expect(matching.at(-1)?.errorCode).toBe("E_CANCELLED");
    // end called once
    expect(end).toHaveBeenCalledTimes(1);
    // Manual retry succeeds
    const { client: c2, query: q2 } = makeSpyClient();
    q2.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const result = await applyDatabasePlan(makeApplyPlan(plan, {
      cwd, registry, payloads, clientFactory: () => c2,
    }));
    expect(result.status).toBe("committed");
  });

  it("B: SET LOCAL failure after BEGIN: rollback, failed, end once", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query, end } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2) throw Object.assign(new Error("bad parameter"), { code: "22003" });
      if (idx === 3) return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    // ROLLBACK was issued
    expect(query.mock.calls.some((c: unknown[]) => c[0] === "ROLLBACK")).toBe(true);
    // Journal: started + failed
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("failed");
    // end called once
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SQLSTATE failure writes exactly one terminal entry and ends once", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query, end } = makeSpyClient();
    query.mockImplementation(async (text: string) => {
      if (text === "INSERT INTO t VALUES ($1)") throw Object.assign(new Error("dup"), { code: "23505" });
      if (text === "BEGIN") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (text.startsWith("SET")) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (text === "ROLLBACK") return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    // end called once
    expect(end).toHaveBeenCalledTimes(1);
    // Only one terminal journal entry (started + failed = 2 total)
    const journal = await readDatabaseJournal(cwd);
    expect(journal.length).toBe(2);
    expect(journal[0]?.status).toBe("started");
    expect(journal[1]?.status).toBe("failed");
  });

  it("terminal journal append failure returns E_STATE_CONFLICT and leaves replay blocked", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query, end } = makeSpyClient();
    const journalPath = databaseJournalPath(cwd);
    const backupPath = `${journalPath}.backup`;
    let journalReplaced = false;

    query.mockImplementation(async (text: string) => {
      if (text === "INSERT INTO t VALUES ($1)") {
        await rename(journalPath, backupPath);
        await mkdir(journalPath);
        journalReplaced = true;
        throw Object.assign(new Error("dup"), { code: "23505" });
      }
      if (text === "BEGIN") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (text.startsWith("SET")) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (text === "ROLLBACK") return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });

    try {
      await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
        .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    } finally {
      if (journalReplaced) {
        await rm(journalPath, { recursive: true, force: true });
        await rename(backupPath, journalPath);
      }
    }

    expect(end).toHaveBeenCalledTimes(1);
    const journal = await readDatabaseJournal(cwd);
    expect(journal.map((entry) => entry.status)).toEqual(["started"]);

    const secondFactory = vi.fn(makeZeroClient);
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: secondFactory })))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(secondFactory).not.toHaveBeenCalled();
  });

  it("every error path calls end exactly once on connect failure", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const end = vi.fn();
    const client = { connect: vi.fn().mockRejectedValue(Object.assign(new Error("fail"), { code: "ECONNREFUSED" })), query: vi.fn(), end };
    await expect(applyDatabasePlan(makeApplyPlan(plan, { cwd, registry, payloads, clientFactory: () => client })))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("Railway legacy migration via DB tool handler", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "db-apply-rwy-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("plan env mismatch blocks before execution", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd });
    await writeFile(join(cwd, "x"), "y");
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({
      name: "rwy-env-test", provider: "railway", project: "rwy-env-test",
      run: { command: ["node", "server.js"] },
      db: { migrate: { command: ["npx", "prisma", "migrate", "deploy"], allowProductionMigrations: true } },
    }));

    const { registerDB } = await import("../../src/tools/db/index.js");
    const registry = new ApprovalRegistry(cwd);
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = { registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } };
    const clientFactory = () => makeZeroClient();
    registerDB(pi as never, registry, {
      credentialSource: {
        get: (name: string) => {
          if (name === "PI_SHIP_DATABASE_ENVIRONMENT") return "production";
          if (name === "DATABASE_URL") return "postgres://u:p@localhost:5432/db";
          if (name === "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES") return "true";
          return undefined;
        },
      },
      clientFactory,
    });
    if (!execute) throw new Error("not registered");

    // First create a migration plan (plan_migration)
    const planResult = await execute!("id", { action: "plan_migration" }, undefined, undefined, { cwd, hasUI: true, ui: { confirm: async () => true } }) as { details: { planId: string; planDigest: string } };

    // Now try to apply with wrong environment override
    // The handler derives environment from source, so we need a different source
    // Register a second tool with development environment
    let execute2: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi2 = { registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute2 = def.execute; } };
    const reg2 = new ApprovalRegistry(cwd);
    reg2.approve(planResult.details.planId, planResult.details.planDigest, cwd);
    registerDB(pi2 as never, reg2, {
      credentialSource: {
        get: (name: string) => {
          if (name === "PI_SHIP_DATABASE_ENVIRONMENT") return "development";
          if (name === "DATABASE_URL") return "postgres://u:p@localhost:5432/db";
          return undefined;
        },
      },
      clientFactory,
    });

    if (!execute2) throw new Error("not registered");
    await expect(execute2!("id", { action: "apply_plan", planId: planResult.details.planId, planDigest: planResult.details.planDigest }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("production plan with allowProductionMigrations true denies missing production flag", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd });
    await writeFile(join(cwd, "x"), "y");
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({
      name: "rwy-prod-test", provider: "railway", project: "rwy-prod-test",
      run: { command: ["node", "server.js"] },
      db: { migrate: { command: ["npx", "prisma", "migrate", "deploy"], allowProductionMigrations: true } },
    }));

    const { registerDB } = await import("../../src/tools/db/index.js");
    const registry = new ApprovalRegistry(cwd);
    let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = { registerTool(def: { execute: (...args: unknown[]) => Promise<unknown> }) { execute = def.execute; } };
    registerDB(pi as never, registry, {
      credentialSource: {
        get: (name: string) => {
          if (name === "PI_SHIP_DATABASE_ENVIRONMENT") return "production";
          if (name === "DATABASE_URL") return "postgres://u:p@localhost:5432/db";
          // PI_SHIP_ALLOW_PRODUCTION_DB_WRITES not set
          return undefined;
        },
      },
      clientFactory: makeZeroClient,
    });
    if (!execute) throw new Error("not registered");

    // plan_migration with production environment
    const planResult = await execute!("id", { action: "plan_migration" }, undefined, undefined, { cwd, hasUI: true, ui: { confirm: async () => true } }) as { details: { planId: string; planDigest: string } };
    registry.approve(planResult.details.planId, planResult.details.planDigest, cwd);

    // Apply with missing production flag
    await expect(execute!("id", { action: "apply_plan", planId: planResult.details.planId, planDigest: planResult.details.planDigest }, undefined, undefined, { cwd }))
      .rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });
});
