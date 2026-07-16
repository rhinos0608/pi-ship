/** Tests for dialect-generic applyDialectPlan. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { classifySQL } from "../../../src/database/classifier.js";
import { buildDatabasePlan, persistDatabasePlan, fingerprintTarget, fingerprintSQL, fingerprintParams, hash } from "../../../src/database/plan.js";
import type { DatabasePlan } from "../../../src/database/plan.js";
import { DatabasePayloadRegistry } from "../../../src/database/payload.js";
import type { DBScalar } from "../../../src/database/payload.js";
import { readDatabaseJournal, appendDatabaseJournal } from "../../../src/database/journal.js";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import type { DatabaseClient, DatabaseQueryResult } from "../../../src/database/client.js";
import type { Environment } from "../../../src/core/types.js";
import { applyDialectPlan, type DialectMutationExecutor, type DialectError } from "../../../src/database/dialect/apply.js";
import type { DialectApplyInput } from "../../../src/database/dialect/contracts.js";
import type { Classification } from "../../../src/database/classifier.js";

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

/**
 * Build a fake executor that delegates to the given client.
 * classifyError returns a DialectError with code from the thrown error.
 */
function makeFakeExecutor(overrides?: Partial<DialectMutationExecutor>): DialectMutationExecutor {
  return {
    paramBinding: 'positional-prefix',
    classifyError(cause: unknown): DialectError {
      if (cause instanceof Error) {
        const code = (cause as unknown as Record<string, unknown>).code;
        if (typeof code === "string") {
          const upper = code.toUpperCase();
          if (upper === "ERR_ABORTED") return { code, shipCode: "E_CANCELLED", retryable: false, definitive: true };
          if (upper === "57014") return { code, shipCode: "E_CANCELLED", retryable: true, definitive: true };
          if (upper.startsWith("08") || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(upper)) {
            return { code, shipCode: "E_PROVIDER", retryable: true, definitive: false };
          }
          if (/^[0-9A-Z]{5}$/.test(upper)) return { code, shipCode: "E_PROVIDER", retryable: false, definitive: true };
          return { code, shipCode: "E_PROVIDER", retryable: false, definitive: false };
        }
      }
      return { code: "E_PROVIDER", shipCode: "E_PROVIDER", retryable: false, definitive: false };
    },
    async begin(client: DatabaseClient): Promise<void> {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '30000ms'");
      await client.query("SET LOCAL lock_timeout = '5000ms'");
    },
    execute(client: DatabaseClient, sql: string, params: readonly unknown[]): Promise<DatabaseQueryResult> {
      return client.query(sql, params);
    },
    async commit(client: DatabaseClient): Promise<void> {
      await client.query("COMMIT");
    },
    async rollback(client: DatabaseClient): Promise<boolean> {
      try { await client.query("ROLLBACK"); return true; }
      catch { return false; }
    },
    ...overrides,
  };
}

/** Simplified classify that re-wraps classifySQL for the generic kernel. */
async function pgClassify(sql: string, params: readonly unknown[]): Promise<Classification> {
  return classifySQL(sql, params);
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

function makeApplyInput(
  plan: DatabasePlan,
  overrides: Partial<DialectApplyInput> & { targetFingerprint?: string } = {},
): { input: DialectApplyInput; targetFingerprint: string; classify: typeof pgClassify; executor: DialectMutationExecutor; connect: () => Promise<DatabaseClient> } {
  return {
    input: {
      cwd: "",
      planId: plan.planId,
      planDigest: plan.planDigest,
      environment: plan.environment,
      providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      productionFlag: undefined,
      registry: new ApprovalRegistry(""),
      payloads: new DatabasePayloadRegistry(),
      signal: undefined,
      ...overrides,
    },
    targetFingerprint: overrides.targetFingerprint ?? TEST_TARGET_FP,
    classify: pgClassify,
    executor: makeFakeExecutor(),
    connect: async () => {
      const { client } = makeSpyClient();
      return client;
    },
  };
}

async function createAndApply(
  cwd: string,
  sql: string,
  params: DBScalar[],
  overrides: Partial<DialectApplyInput> & { targetFingerprint?: string } = {},
): Promise<ReturnType<typeof applyDialectPlan>> {
  const { plan, payloads, registry } = await buildAndRegister(cwd, sql, params);
  const args = makeApplyInput(plan, {
    cwd,
    registry,
    payloads,
    ...overrides,
    targetFingerprint: overrides.targetFingerprint ?? TEST_TARGET_FP,
  });
  return applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("applyDialectPlan preflight failures", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "dialect-apply-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("rejects plan digest mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const args = makeApplyInput(plan, { cwd, payloads, registry, planDigest: "0000000000000000000000000000000000000000000000000000000000000001" });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
  });

  it("rejects approval with wrong domain", async () => {
    const { plan, payloads } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "deployment", risk: "write" });
    const args = makeApplyInput(plan, { cwd, payloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });

  it("rejects approval with wrong risk level", async () => {
    const { plan, payloads } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    const args = makeApplyInput(plan, { cwd, payloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });

  it("rejects missing production flag when environment is production", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], { environment: "production" });
    const args = makeApplyInput(plan, { cwd, payloads, registry, environment: "production", productionFlag: undefined });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
  });

  it("rejects production flag values other than exact 'true'", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], { environment: "production" });
    for (const flag of ["TRUE", "1", "true ", "yes", ""]) {
      const args = makeApplyInput(plan, { cwd, payloads, registry, environment: "production", productionFlag: flag });
      await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
        .rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    }
  });

  it("rejects environment mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], { environment: "production" });
    const args = makeApplyInput(plan, { cwd, payloads, registry, environment: "development" });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects target fingerprint mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const otherFp = fingerprintTarget("postgres://other:pass@otherhost:5432/otherdb");
    const args = makeApplyInput(plan, { cwd, payloads, registry, targetFingerprint: otherFp });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects provider fingerprint mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const args = makeApplyInput(plan, { cwd, payloads, registry, providerFingerprint: hash("other-provider") });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects manifest fingerprint mismatch", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const args = makeApplyInput(plan, { cwd, payloads, registry, manifestFingerprint: hash("other-manifest") });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects missing payload (restart scenario)", async () => {
    const { plan, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const emptyPayloads = new DatabasePayloadRegistry();
    const args = makeApplyInput(plan, { cwd, registry, payloads: emptyPayloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects replay of committed plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint, providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "committed", at: new Date().toISOString(),
    });
    const args = makeApplyInput(plan, { cwd, payloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects replay of ambiguous plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint, providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "ambiguous", at: new Date().toISOString(), errorCode: "E_STATE_CONFLICT",
    });
    const args = makeApplyInput(plan, { cwd, payloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects replay of dangling started plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint, providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "started", at: new Date().toISOString(),
    });
    const args = makeApplyInput(plan, { cwd, payloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, args.executor, args.connect))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("allows retry after failed plan", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    await appendDatabaseJournal(cwd, {
      version: 1, planId: plan.planId, planDigest: plan.planDigest,
      targetFingerprint: plan.targetFingerprint, providerFingerprint: plan.providerFingerprint,
      manifestFingerprint: plan.manifestFingerprint,
      sqlFingerprint: plan.sqlFingerprint, paramFingerprint: plan.paramFingerprint,
      environment: plan.environment, risk: plan.riskLevel, statementCount: plan.statements.length,
      status: "failed", at: new Date().toISOString(), errorCode: "E_PROVIDER",
    });
    await createAndApply(cwd, "INSERT INTO t VALUES ($1)", [1]);
  });
});

describe("applyDialectPlan execution with fake executor", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "dialect-apply-exec-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("executes BEGIN, SET timeouts before statements via executor", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client);
    const sqlCalls = query.mock.calls.map((c: unknown[]) => c[0]);
    expect(sqlCalls[0]).toBe("BEGIN");
    expect(sqlCalls[1]).toBe("SET LOCAL statement_timeout = '30000ms'");
    expect(sqlCalls[2]).toBe("SET LOCAL lock_timeout = '5000ms'");
    expect(sqlCalls[3]).toBe("INSERT INTO t VALUES ($1)");
    expect(sqlCalls[4]).toBe("COMMIT");
  });

  it("bind params as exact prefix", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1, $2)", [10, 20]);
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client);
    const boundParams = query.mock.calls[3][1];
    expect(boundParams).toEqual([10, 20]);
  });

  it("returns committed result with statement count and affectedRows", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    const result = await applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client);
    expect(result.status).toBe("committed");
    expect(result.statementCount).toBe(1);
    expect(result.affectedRows).toBe(1);
  });

  it("does not retry on query failure — SQLSTATE error", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("dup"), { code: "23505" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    const insertCalls = query.mock.calls.filter((c: unknown[]) => (c[0] as string).includes("INSERT"));
    expect(insertCalls).toHaveLength(1);
  });

  it("concurrent same-plan applies: one mutation max, second blocked", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client: c1, query: q1 } = makeSpyClient();
    const { client: c2, query: q2 } = makeSpyClient();
    q1.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    q2.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });
    const args = makeApplyInput(plan, { cwd, registry, payloads });

    const results = await Promise.allSettled([
      applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => c1),
      applyDialectPlan({ ...args.input }, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => c2),
    ]);

    const committed = results.filter((r) => r.status === "fulfilled" && r.value.status === "committed");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(committed.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0] && "reason" in rejected[0]) {
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "E_STATE_CONFLICT" });
    }
  });

  it("does not return SQL, params, URL, or rows in results", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client } = makeSpyClient();
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    const result = await applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client);
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

  it("affectedRows counts only write/destructive statements", async () => {
    const sql = "INSERT INTO t VALUES ($1); SELECT 1";
    const classification = await classifySQL(sql, [1]);
    const plan = buildDatabasePlan({
      environment: "development" as const, targetFingerprint: TEST_TARGET_FP,
      providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest"),
      sql, params: [1], classification,
    });
    await persistDatabasePlan(cwd, plan as any);
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
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    const result = await applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client);
    expect(result.affectedRows).toBe(5);
    expect(result.statementCount).toBe(2);
  });
});

describe("applyDialectPlan failure semantics", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "dialect-apply-fail-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("abort before write dispatch: failed E_CANCELLED, manual retry", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const ac = new AbortController();
    ac.abort();
    const args = makeApplyInput(plan, { cwd, registry, payloads, signal: ac.signal });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => makeZeroClient()))
      .rejects.toMatchObject({ code: "E_CANCELLED" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.length).toBe(0);
    // Manual retry succeeds
    await createAndApply(cwd, "INSERT INTO t VALUES ($1)", [1]);
  });

  it("SQLSTATE (non-08) during statement: rollback + failed, no auto retry", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("dup"), { code: "23505" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    const rollbackCalls = query.mock.calls.filter((c: unknown[]) => c[0] === "ROLLBACK");
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
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
      if (idx === 4) throw Object.assign(new Error("conn lost"), { code: "ECONNRESET" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
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
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
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
      if (idx === 5) throw Object.assign(new Error("conn lost"), { code: "ECONNRESET" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("ambiguous");
  });

  it("connect failure: started entry exists, no DB mutation", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const connect = vi.fn().mockRejectedValue(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }));
    const query = vi.fn();
    const end = vi.fn();
    const client = { connect, query, end };
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.length).toBe(2);
    expect(matching[0]?.status).toBe("started");
    expect(matching[1]?.status).toBe("failed");
    expect(client.query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
  });
});

describe("applyDialectPlan journal integrity", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "dialect-apply-jrnl-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("journal chain contains no SQL/params/password/URL", async () => {
    await createAndApply(cwd, "INSERT INTO users (password) VALUES ($1)", ["secret123"]);
    const journal = await readDatabaseJournal(cwd);
    const journalText = JSON.stringify(journal);
    expect(journalText).not.toContain("secret123");
    expect(journalText).not.toContain("password");
    expect(journalText).not.toContain("INSERT");
    expect(journalText).not.toContain("localhost");
    expect(journalText).not.toContain("postgres://");
  });

  it("journal chain hash integrity after successful apply", async () => {
    await createAndApply(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const journal = await readDatabaseJournal(cwd);
    expect(journal.length).toBe(2);
    expect(journal[0]?.status).toBe("started");
    expect(journal[1]?.status).toBe("committed");
    expect(journal[0]?.hash).toBe(journal[1]?.previousHash);
  });
});

describe("applyDialectPlan safety and edge cases", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "dialect-apply-safety-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("connect function throw: started+failed, safe message, end unavailable", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const connectErr = Object.assign(new Error("factory explosion"), { code: "CONNECTION_FAILURE" });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => { throw connectErr; }))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
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
      if (idx === 5) return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads, signal: ac.signal });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_CANCELLED" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("failed");
    expect(matching.at(-1)?.errorCode).toBe("E_CANCELLED");
    // Manual retry
    await createAndApply(cwd, "INSERT INTO t VALUES ($1)", [1]);
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
      if (idx === 5) throw Object.assign(new Error("rollback failed"), { code: "08000" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads, signal: ac.signal });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    const journal = await readDatabaseJournal(cwd);
    const matching = journal.filter((e) => e.planId === plan.planId);
    expect(matching.at(-1)?.status).toBe("ambiguous");
  });

  it("end called exactly once on SQLSTATE error", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const { client, query, end } = makeSpyClient();
    let idx = 0;
    query.mockImplementation(async () => {
      idx++;
      if (idx === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx === 2 || idx === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (idx === 4) throw Object.assign(new Error("dup"), { code: "23505" });
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("end called exactly once on connect failure", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const end = vi.fn();
    const client = { connect: vi.fn().mockRejectedValue(Object.assign(new Error("fail"), { code: "ECONNREFUSED" })), query: vi.fn(), end };
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => client))
      .rejects.toMatchObject({ code: "E_PROVIDER" });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("wrong target fingerprint blocks before connect", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const otherFp = fingerprintTarget("postgres://other:pass@otherhost:5432/otherdb");
    let connected = false;
    const args = makeApplyInput(plan, { cwd, payloads, registry, targetFingerprint: otherFp });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => {
      connected = true;
      return makeZeroClient();
    })).rejects.toThrow();
    expect(connected).toBe(false);
  });

  it("unapproved plan blocks before connect", async () => {
    const { plan, payloads } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    const registry = new ApprovalRegistry(cwd);
    // No approval given
    let connected = false;
    const args = makeApplyInput(plan, { cwd, payloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => {
      connected = true;
      return makeZeroClient();
    })).rejects.toThrow();
    expect(connected).toBe(false);
  });

  it("production guard exact lowercase 'true'", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1], { environment: "production" });
    let connected = false;
    const args = makeApplyInput(plan, { cwd, payloads, registry, environment: "production", productionFlag: "TRUE" });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => {
      connected = true;
      return makeZeroClient();
    })).rejects.toMatchObject({ code: "E_APPROVAL_REQUIRED" });
    expect(connected).toBe(false);
  });

  it("parser reclassification drift blocks", async () => {
    // Build a write plan that will reclassify differently when payload is tampered
    const sql = "INSERT INTO t VALUES ($1)";
    const params: DBScalar[] = [42];
    const classification = await classifySQL(sql, params);
    const plan = buildDatabasePlan({
      environment: "development", targetFingerprint: TEST_TARGET_FP,
      providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest"),
      sql, params, classification,
    });
    await persistDatabasePlan(cwd, plan);
    // Register payload with DIFFERENT SQL that would reclassify differently
    const badSql = "DELETE FROM t";
    const badClassification = await classifySQL(badSql, []);
    const tamperedPayloads = new DatabasePayloadRegistry();
    tamperedPayloads.register(plan.planId, plan.planDigest, { sql: badSql, params: [], statements: badClassification.statements });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "write" });
    let connected = false;
    const args = makeApplyInput(plan, { cwd, payloads: tamperedPayloads, registry });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => {
      connected = true;
      return makeZeroClient();
    })).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
    expect(connected).toBe(false);
  });

  it("definitive error is failed, ambiguous is not retryable", async () => {
    const { plan, payloads, registry } = await buildAndRegister(cwd, "INSERT INTO t VALUES ($1)", [1]);
    // Transport error => ambiguous, blocks replay
    const { client: c1, query: q1 } = makeSpyClient();
    let idx1 = 0;
    q1.mockImplementation(async () => {
      idx1++;
      if (idx1 === 4) throw Object.assign(new Error("conn reset"), { code: "ECONNRESET" });
      if (idx1 === 1) return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (idx1 === 2 || idx1 === 3) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      return { fields: [], rows: [], rowCount: 0, command: "" };
    });
    const args = makeApplyInput(plan, { cwd, registry, payloads });
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), async () => c1))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    // Second attempt blocked
    const connectSpy = vi.fn(async () => makeZeroClient());
    await expect(applyDialectPlan(args.input, args.targetFingerprint, args.classify, makeFakeExecutor(), connectSpy))
      .rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("sequential param binding: slices params cumulatively across statements", async () => {
    // Two statements, each with 1 param — sequential binding must pass correct slices
    // Use SQLite classifier since it understands ? placeholders
    const { classifySQLiteSQL } = await import("../../../src/database/dialect/sqlite/classifier.js");
    const { hash, computeDatabasePlanDigest } = await import("../../../src/database/plan.js");
    const sql = "INSERT INTO t VALUES (?); INSERT INTO u VALUES (?)";
    const allParams = [10, 20];
    const classification = await classifySQLiteSQL(sql, allParams);
    expect(classification.statements).toHaveLength(2);
    expect(classification.statements[0]!.paramCount).toBe(1);
    expect(classification.statements[1]!.paramCount).toBe(1);

    // Manual plan: schema requires plan.paramCount === max(stmt.paramCount).
    // The executor's sequential slicing uses statement-level paramCount at runtime.
    const targetFp = "0000000000000000000000000000000000000000000000000000000000000000";
    const providerFp = "0000000000000000000000000000000000000000000000000000000000000000";
    const manifestFp = "0000000000000000000000000000000000000000000000000000000000000000";
    const planId = randomUUID();
    const plan = {
      kind: "db-plan/1" as const,
      version: 1,
      planId,
      planDigest: "",
      providerFingerprint: providerFp,
      manifestFingerprint: manifestFp,
      environment: "development",
      targetFingerprint: targetFp,
      statements: classification.statements.map((s, i) => ({
        index: i,
        tag: s.tag,
        risk: s.risk as "write" | "read" | "destructive",
        tables: s.tables,
        sqlFingerprint: s.sqlFingerprint,
        paramCount: s.paramCount,
        reasons: s.reasons,
      })),
      sqlFingerprint: hash(sql),
      paramFingerprint: hash(allParams),
      paramCount: 1, // max of stmt paramCounts (plan schema invariant)
      riskLevel: "write" as const,
      destructiveReasons: [],
      createdAt: new Date().toISOString(),
    };
    plan.planDigest = computeDatabasePlanDigest(plan as any);
    await persistDatabasePlan(cwd, plan as any);
    const payloads = new DatabasePayloadRegistry();
    payloads.register(plan.planId, plan.planDigest, { sql, params: allParams, statements: classification.statements });
    const registry = new ApprovalRegistry(cwd);
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "write" });

    const { client, query } = makeSpyClient();
    query.mockResolvedValue({ fields: [], rows: [], rowCount: 1, command: "INSERT" });

    await applyDialectPlan(
      {
        cwd,
        planId: plan.planId as string,
        planDigest: plan.planDigest as string,
        environment: plan.environment as any,
        providerFingerprint: plan.providerFingerprint,
        manifestFingerprint: plan.manifestFingerprint,
        productionFlag: undefined,
        registry,
        payloads,
        signal: undefined,
      },
      plan.targetFingerprint,
      classifySQLiteSQL,
      makeFakeExecutor({ paramBinding: 'sequential' }),
      async () => client,
    );

    // First statement should get params.slice(0, 1) = [10]
    // Second statement should get params.slice(1, 2) = [20]
    expect(query).toHaveBeenCalledTimes(6); // BEGIN, SET x2, stmt1, stmt2, COMMIT
    const stmt1Params = query.mock.calls[3][1];
    const stmt2Params = query.mock.calls[4][1];
    expect(stmt1Params).toEqual([10]);
    expect(stmt2Params).toEqual([20]);
  });
});
