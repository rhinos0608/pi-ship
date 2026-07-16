/** Dialect-aware shared preflight/journal lifecycle. */
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { err, isShipError } from "../../core/errors.js";
import { checkAborted } from "../client.js";
import type { DatabaseClient, DatabaseQueryResult } from "../client.js";
import type { DatabasePlan } from "../plan.js";
import { loadDatabasePlan, fingerprintSQL, fingerprintParams } from "../plan.js";
import { databaseJournalPath, appendDatabaseJournal, readDatabaseJournal } from "../journal.js";
import type { DatabaseJournalEntry } from "../journal.js";
import type { Classification } from "../classifier.js";
import type { DialectApplyInput } from "./contracts.js";

// ── Result type ──

export interface ApplyDatabasePlanResult {
  /** Unique plan identifier. */
  planId: string;
  /** SHA-256 hex digest of the plan. */
  planDigest: string;
  /** Terminal status: "committed" on success. */
  status: "committed" | "failed" | "ambiguous";
  /** Number of statements executed. */
  statementCount: number;
  /** Total rows affected by write/destructive statements. */
  affectedRows: number;
}

// ── Injected executor interface ──

export interface DialectError {
  /** Raw code from driver (SQLSTATE, errno, etc.). Never contains SQL or params. */
  code: string;
  /** Mapped ship error code: E_PROVIDER, E_CANCELLED, E_AUTH_MISSING. */
  shipCode: string;
  /** Whether the operation may succeed on retry. */
  retryable: boolean;
  /**
   * True when the error definitively indicates the statement failed
   * (e.g. constraint violation, known SQLSTATE). False for transport
   * errors where the statement may have been executed.
   */
  definitive: boolean;
}

export interface DialectMutationExecutor {
  /** Normalize a driver error to a safe DialectError. Never copies SQL/params/message. */
  classifyError(cause: unknown): DialectError;
  /** Open a transaction and set dialect-specific session parameters. */
  begin(client: DatabaseClient): Promise<void>;
  /** Execute one statement with bound params. */
  execute(client: DatabaseClient, sql: string, params: readonly unknown[]): Promise<DatabaseQueryResult>;
  /** Commit the open transaction. */
  commit(client: DatabaseClient): Promise<void>;
  /** Rollback the open transaction. Returns true if rollback was attempted. */
  rollback(client: DatabaseClient): Promise<boolean>;
  /**
   * Parameter binding strategy:
   * - 'positional-prefix': each statement gets params.slice(0, stmt.paramCount)
   *   (e.g. PostgreSQL with $n prefix placeholders — all statements share the same pool)
   * - 'sequential': params are consumed cumulatively across statements
   *   (e.g. SQLite/MySQL with ? placeholders — each statement's params are a sequential slice)
   */
  paramBinding: 'positional-prefix' | 'sequential';

  /**
   * Whether the executor supports fully atomic (transactional) execution.
   * When false, plans containing non-atomic statements (e.g. DDL with
   * implicit-commit behavior) are rejected before begin().
   * @default true
   */
  atomic?: boolean;
}

// ── Internal helpers ──

function isSqlstate(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code.toUpperCase());
}

function throwMapped(de: DialectError): never {
  if (de.shipCode === "E_CANCELLED") throw err("E_CANCELLED", "database operation cancelled", de.retryable);
  if (de.shipCode === "E_AUTH_MISSING") throw err("E_AUTH_MISSING", "database authentication failed", false);
  throw err("E_PROVIDER", "database operation failed", de.retryable);
}

function journalBase(plan: DatabasePlan): Omit<DatabaseJournalEntry, "previousHash" | "hash" | "status" | "at" | "errorCode"> {
  return {
    version: 1,
    planId: plan.planId,
    planDigest: plan.planDigest,
    targetFingerprint: plan.targetFingerprint,
    providerFingerprint: plan.providerFingerprint,
    manifestFingerprint: plan.manifestFingerprint,
    sqlFingerprint: plan.sqlFingerprint,
    paramFingerprint: plan.paramFingerprint,
    environment: plan.environment,
    risk: plan.riskLevel,
    statementCount: plan.statements.length,
  };
}

async function appendStarted(plan: DatabasePlan, cwd: string): Promise<void> {
  await appendDatabaseJournal(cwd, { ...journalBase(plan), status: "started", at: new Date().toISOString() });
}

async function appendCommitted(plan: DatabasePlan, cwd: string): Promise<void> {
  await appendDatabaseJournal(cwd, { ...journalBase(plan), status: "committed", at: new Date().toISOString() });
}

async function appendFailed(plan: DatabasePlan, cwd: string, errorCode: string): Promise<void> {
  await appendDatabaseJournal(cwd, { ...journalBase(plan), status: "failed", at: new Date().toISOString(), errorCode });
}

async function appendAmbiguous(plan: DatabasePlan, cwd: string): Promise<void> {
  await appendDatabaseJournal(cwd, { ...journalBase(plan), status: "ambiguous", at: new Date().toISOString(), errorCode: "E_STATE_CONFLICT" });
}

async function preflight(
  input: DialectApplyInput,
  targetFingerprint: string,
  classify: (sql: string, params: readonly unknown[]) => Promise<Classification>,
): Promise<{ plan: DatabasePlan; payload: import("../payload.js").DatabasePayload; reclass: Classification }> {
  const { cwd, planId, planDigest, environment, providerFingerprint, manifestFingerprint, productionFlag, registry, payloads } = input;

  const plan = await loadDatabasePlan(cwd, planId);
  if (plan.planDigest !== planDigest) throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  if (environment !== plan.environment) throw err("E_STATE_CONFLICT", "plan environment differs from current environment");

  if (targetFingerprint !== plan.targetFingerprint) throw err("E_STATE_CONFLICT", "database target fingerprint mismatch; re-plan required");
  if (providerFingerprint !== plan.providerFingerprint) throw err("E_STATE_CONFLICT", "provider fingerprint mismatch; re-plan required");
  if (manifestFingerprint !== plan.manifestFingerprint) throw err("E_STATE_CONFLICT", "manifest fingerprint mismatch; re-plan required");

  const risk = plan.riskLevel === "destructive" ? "destructive" : "write";
  if (!registry.isApproved(planId, planDigest, cwd, { domain: "database", risk })) throw err("E_APPROVAL_REQUIRED", "database plan has not been approved");
  if (plan.environment === "production" && productionFlag !== "true") throw err("E_APPROVAL_REQUIRED", "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES must be 'true' for production database writes");

  const payload = payloads.require(planId, planDigest);
  const reclass = await classify(payload.sql, payload.params);

  if (fingerprintSQL(payload.sql) !== plan.sqlFingerprint) throw err("E_DIGEST_MISMATCH", "SQL fingerprint mismatch between payload and plan");
  if (fingerprintParams(payload.params) !== plan.paramFingerprint) throw err("E_DIGEST_MISMATCH", "parameter fingerprint mismatch between payload and plan");
  if (reclass.maxParamRef !== plan.paramCount) throw err("E_PLAN_STALE", "parameter count mismatch between reclassified payload and plan");
  if (reclass.riskLevel !== plan.riskLevel) throw err("E_PLAN_STALE", "risk level mismatch between reclassified payload and plan");
  const prevReasons = plan.destructiveReasons;
  const currReasons = reclass.destructiveReasons;
  if (prevReasons.length !== currReasons.length || prevReasons.some((r, i) => r !== currReasons[i])) throw err("E_PLAN_STALE", "destructive reasons mismatch between reclassified payload and plan");
  if (reclass.statements.length !== plan.statements.length) throw err("E_PLAN_STALE", "statement count mismatch between reclassified payload and plan");
  for (let i = 0; i < plan.statements.length; i++) {
    const ps = plan.statements[i];
    const rs = reclass.statements[i];
    if (rs.index !== ps.index) throw err("E_PLAN_STALE", `statement ${i} index mismatch`);
    if (rs.tag !== ps.tag) throw err("E_PLAN_STALE", `statement ${i} tag mismatch`);
    if (rs.sqlFingerprint !== ps.sqlFingerprint) throw err("E_DIGEST_MISMATCH", `statement ${i} SQL fingerprint mismatch`);
    if (rs.paramCount !== ps.paramCount) throw err("E_PLAN_STALE", `statement ${i} parameter count mismatch`);
    if (rs.risk !== ps.risk) throw err("E_PLAN_STALE", `statement ${i} risk level mismatch`);
    if (rs.tables.length !== ps.tables.length || rs.tables.some((t, j) => t !== ps.tables[j])) throw err("E_PLAN_STALE", `statement ${i} tables mismatch`);
    if (rs.reasons.length !== ps.reasons.length || rs.reasons.some((r, j) => r !== ps.reasons[j])) throw err("E_PLAN_STALE", `statement ${i} reasons mismatch`);
  }

  const entries = await readDatabaseJournal(cwd);
  const matching = entries.filter((e) => e.planId === planId && e.planDigest === planDigest);
  if (matching.some((e) => e.status === "committed" || e.status === "ambiguous") || matching.at(-1)?.status === "started") {
    throw err("E_STATE_CONFLICT", "database plan replay blocked by journal state");
  }

  return { plan, payload, reclass };
}

async function safeAppendStarted(plan: DatabasePlan, cwd: string): Promise<void> {
  try { await appendStarted(plan, cwd); }
  catch { throw err("E_PROVIDER", "database operation failed", false); }
}

async function safeAppendTerminal(plan: DatabasePlan, cwd: string, status: "failed" | "ambiguous" | "committed", errorCode?: string): Promise<void> {
  try {
    if (status === "failed") await appendFailed(plan, cwd, errorCode ?? "E_PROVIDER");
    else if (status === "ambiguous") await appendAmbiguous(plan, cwd);
    else await appendCommitted(plan, cwd);
  } catch {
    throw err("E_STATE_CONFLICT", "database operation result uncertain", false);
  }
}

async function safeRollback(client: DatabaseClient | undefined, executor: DialectMutationExecutor): Promise<boolean> {
  if (!client) return false;
  try { return await executor.rollback(client); }
  catch { return false; }
}

function isMutationRisk(risk: string): boolean {
  return risk === "write" || risk === "destructive";
}

/**
 * Apply a database plan using a dialect-specific classifier and mutation executor.
 *
 * Handles full preflight, journal lifecycle, transaction execution, error mapping,
 * and cleanup. The caller supplies the target fingerprint, classifier, executor,
 * and a createClient function that returns a fresh (unconnected) client.
 * The kernel calls client.connect() separately so that the client object is
 * available for cleanup even when connect fails.
 */
export async function applyDialectPlan(
  input: DialectApplyInput,
  targetFingerprint: string,
  classify: (sql: string, params: readonly unknown[]) => Promise<Classification>,
  executor: DialectMutationExecutor,
  createClient: () => Promise<DatabaseClient>,
): Promise<ApplyDatabasePlanResult> {
  return withFileMutationQueue(databaseJournalPath(input.cwd), async () => {
    const { plan, payload, reclass } = await preflight(input, targetFingerprint, classify);
    checkAborted(input.signal);

    let client: DatabaseClient | undefined;
    let began = false;
    let writeDispatched = false;
    let commitAcknowledged = false;
    let startedAppended = false;
    let terminalAppended = false;

    try {
      await safeAppendStarted(plan, input.cwd);
      startedAppended = true;

      client = await createClient();
      await client.connect();

      // Validate atomicity before begin
      if (executor.atomic === false && plan.statements.some(s => s.risk === "destructive")) {
        await safeAppendTerminal(plan, input.cwd, "failed", "E_CONFIG_INVALID");
        terminalAppended = true;
        throw err("E_CONFIG_INVALID", "plan contains non-atomic DDL not supported by this dialect");
      }

      await executor.begin(client);
      began = true;

      let totalAffectedRows = 0;

      let paramOffset = 0;
      for (let i = 0; i < plan.statements.length; i++) {
        checkAborted(input.signal);
        const stmt = plan.statements[i];
        const sqlText = reclass.statements[i].sql;
        const boundParams = executor.paramBinding === 'sequential'
          ? payload.params.slice(paramOffset, paramOffset + stmt.paramCount)
          : payload.params.slice(0, stmt.paramCount);
        if (executor.paramBinding === 'sequential') paramOffset += stmt.paramCount;
        const isMutation = isMutationRisk(stmt.risk);
        if (isMutation) writeDispatched = true;

        try {
          const result = await executor.execute(client, sqlText, boundParams);
          if (result.rowCount !== null && isMutation) totalAffectedRows += result.rowCount;
        } catch (queryErr: unknown) {
          const de = executor.classifyError(queryErr);
          const rollbackOk = await safeRollback(client, executor);
          const sqlstate = isSqlstate(de.code);

          if (!writeDispatched || (de.definitive && (sqlstate || de.shipCode !== "E_CANCELLED"))) {
            if (de.shipCode === "E_CANCELLED" && !sqlstate) {
              await safeAppendTerminal(plan, input.cwd, "failed", "E_CANCELLED");
              terminalAppended = true;
              throw err("E_CANCELLED", "database operation cancelled", de.retryable);
            }
            await safeAppendTerminal(plan, input.cwd, "failed", de.code);
            terminalAppended = true;
            throwMapped(de);
          }

          if (de.shipCode === "E_CANCELLED") {
            if (rollbackOk) {
              await safeAppendTerminal(plan, input.cwd, "failed", "E_CANCELLED");
              terminalAppended = true;
              throw err("E_CANCELLED", "database operation cancelled", true);
            }
            await safeAppendTerminal(plan, input.cwd, "ambiguous");
            terminalAppended = true;
            throw err("E_STATE_CONFLICT", "database operation result uncertain after cancellation", false);
          }

          await safeAppendTerminal(plan, input.cwd, "ambiguous");
          terminalAppended = true;
          throw err("E_STATE_CONFLICT", "database operation result uncertain after transport error", false);
        }
      }

      checkAborted(input.signal);

      try {
        await executor.commit(client);
        commitAcknowledged = true;
        began = false;
      } catch (commitErr: unknown) {
        const de = executor.classifyError(commitErr);
        await safeRollback(client, executor);
        if (de.definitive) {
          await safeAppendTerminal(plan, input.cwd, "failed", de.code);
          terminalAppended = true;
          throwMapped(de);
        }
        await safeAppendTerminal(plan, input.cwd, "ambiguous");
        terminalAppended = true;
        throw err("E_STATE_CONFLICT", "database commit result uncertain after transport error", false);
      }

      await safeAppendTerminal(plan, input.cwd, "committed");
      terminalAppended = true;

      return {
        planId: plan.planId,
        planDigest: plan.planDigest,
        status: "committed",
        statementCount: plan.statements.length,
        affectedRows: totalAffectedRows,
      };
    } catch (e: unknown) {
      if (terminalAppended) throw e;
      if (isShipError(e) && e.code === "E_STATE_CONFLICT") throw e;
      if (!startedAppended) throw e;
      if (commitAcknowledged) throw err("E_STATE_CONFLICT", "database operation result uncertain", false);

      const de = executor.classifyError(e);

      let rollbackOk = false;
      if (began) rollbackOk = await safeRollback(client, executor);

      if (de.shipCode === "E_CANCELLED") {
        if (!writeDispatched || rollbackOk) {
          await safeAppendTerminal(plan, input.cwd, "failed", "E_CANCELLED");
          terminalAppended = true;
          throw err("E_CANCELLED", "database operation cancelled", true);
        }
        await safeAppendTerminal(plan, input.cwd, "ambiguous");
        terminalAppended = true;
        throw err("E_STATE_CONFLICT", "database operation result uncertain after cancellation", false);
      }

      if (!writeDispatched && !commitAcknowledged) {
        await safeAppendTerminal(plan, input.cwd, "failed", de.code);
        terminalAppended = true;
        throwMapped(de);
      }

      if (began) {
        await safeAppendTerminal(plan, input.cwd, "failed", de.code);
        terminalAppended = true;
        throwMapped(de);
      }

      await safeAppendTerminal(plan, input.cwd, "ambiguous");
      terminalAppended = true;
      throw err("E_STATE_CONFLICT", "database operation result uncertain", false);
    } finally {
      if (client) {
        try { await client.end(); } catch { /* best-effort */ }
      }
    }
  });
}
