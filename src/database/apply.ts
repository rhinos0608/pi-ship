import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../core/approval.js";
import type { Environment } from "../core/types.js";
import { err, isShipError } from "../core/errors.js";
import type { DatabaseClientFactory, DatabaseClient } from "./client.js";
import { checkAborted } from "./client.js";
import type { DatabasePayloadRegistry } from "./payload.js";
import { loadDatabasePlan, fingerprintTarget, fingerprintSQL, fingerprintParams } from "./plan.js";
import type { DatabasePlan } from "./plan.js";
import { databaseJournalPath, appendDatabaseJournal, readDatabaseJournal } from "./journal.js";
import type { DatabaseJournalEntry } from "./journal.js";
import { classifySQL } from "./classifier.js";

export interface ApplyDatabasePlanOptions {
  cwd: string;
  planId: string;
  planDigest: string;
  environment: Environment;
  databaseUrl: string;
  providerFingerprint: string;
  manifestFingerprint: string;
  productionFlag: string | undefined;
  registry: ApprovalRegistry;
  payloads: DatabasePayloadRegistry;
  clientFactory: DatabaseClientFactory;
  signal?: AbortSignal;
}

export interface ApplyDatabasePlanResult {
  planId: string;
  planDigest: string;
  status: "committed";
  statementCount: number;
  affectedRows: number;
}

interface ClassifiedError {
  sqlstate: string;
  shipCode: string;
  retryable: boolean;
  definitive: boolean;
}

function classifyError(cause: unknown): ClassifiedError {
  if (isShipError(cause)) {
    if (cause.code === "E_CANCELLED") {
      return { sqlstate: cause.code, shipCode: "E_CANCELLED", retryable: true, definitive: true };
    }
    return { sqlstate: cause.code, shipCode: cause.code, retryable: cause.retryable, definitive: false };
  }

  if (cause instanceof Error && typeof (cause as unknown as Record<string, unknown>).code === "string") {
    const raw = (cause as unknown as Record<string, unknown>).code as string;
    const upper = raw.toUpperCase();

    if (upper === "ERR_ABORTED") {
      return { sqlstate: raw, shipCode: "E_CANCELLED", retryable: false, definitive: true };
    }

    if (upper === "28P01" || upper === "28000") {
      return { sqlstate: raw, shipCode: "E_AUTH_MISSING", retryable: false, definitive: true };
    }

    if (upper === "57014") {
      return { sqlstate: raw, shipCode: "E_CANCELLED", retryable: true, definitive: true };
    }

    if (upper.startsWith("08") || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(upper)) {
      return { sqlstate: raw, shipCode: "E_PROVIDER", retryable: true, definitive: false };
    }

    if (/^[0-9A-Z]{5}$/.test(upper)) {
      return { sqlstate: raw, shipCode: "E_PROVIDER", retryable: false, definitive: true };
    }

    return { sqlstate: raw, shipCode: "E_PROVIDER", retryable: false, definitive: false };
  }

  return { sqlstate: "E_PROVIDER", shipCode: "E_PROVIDER", retryable: false, definitive: false };
}

function throwMapped(ce: ClassifiedError): never {
  if (ce.shipCode === "E_CANCELLED") throw err("E_CANCELLED", "database operation cancelled", ce.retryable);
  if (ce.shipCode === "E_AUTH_MISSING") throw err("E_AUTH_MISSING", "database authentication failed", false);
  throw err("E_PROVIDER", "database operation failed", ce.retryable);
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

async function preflight(options: ApplyDatabasePlanOptions): Promise<{
  plan: DatabasePlan;
  payload: import("./payload.js").DatabasePayload;
  reclass: import("./classifier.js").Classification;
}> {
  const { cwd, planId, planDigest, environment, databaseUrl, providerFingerprint, manifestFingerprint, productionFlag, registry, payloads } = options;

  const plan = await loadDatabasePlan(cwd, planId);
  if (plan.planDigest !== planDigest) throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  if (environment !== plan.environment) throw err("E_STATE_CONFLICT", "plan environment differs from current environment");

  const currentTarget = fingerprintTarget(databaseUrl);
  if (currentTarget !== plan.targetFingerprint) throw err("E_STATE_CONFLICT", "database target fingerprint mismatch; re-plan required");
  if (providerFingerprint !== plan.providerFingerprint) throw err("E_STATE_CONFLICT", "provider fingerprint mismatch; re-plan required");
  if (manifestFingerprint !== plan.manifestFingerprint) throw err("E_STATE_CONFLICT", "manifest fingerprint mismatch; re-plan required");

  const risk = plan.riskLevel === "destructive" ? "destructive" : "write";
  if (!registry.isApproved(planId, planDigest, cwd, { domain: "database", risk })) throw err("E_APPROVAL_REQUIRED", "database plan has not been approved");
  if (plan.environment === "production" && productionFlag !== "true") throw err("E_APPROVAL_REQUIRED", "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES must be 'true' for production database writes");

  const payload = payloads.require(planId, planDigest);
  const reclass = await classifySQL(payload.sql, payload.params);

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

async function safeRollback(client: DatabaseClient | undefined): Promise<boolean> {
  if (!client) return false;
  try { await client.query("ROLLBACK"); return true; }
  catch { return false; }
}

function isMutationRisk(risk: string): boolean {
  return risk === "write" || risk === "destructive";
}

export async function applyDatabasePlan(options: ApplyDatabasePlanOptions): Promise<ApplyDatabasePlanResult> {
  return withFileMutationQueue(databaseJournalPath(options.cwd), async () => {
    const { plan, payload, reclass } = await preflight(options);
    checkAborted(options.signal);

    let client: DatabaseClient | undefined;
    let began = false;
    let writeDispatched = false;
    let commitAcknowledged = false;
    let startedAppended = false;
    let terminalAppended = false;

    try {
      await safeAppendStarted(plan, options.cwd);
      startedAppended = true;

      client = options.clientFactory(options.databaseUrl);
      await client.connect();
      await client.query("BEGIN");
      began = true;
      await client.query("SET LOCAL statement_timeout = '30000ms'");
      await client.query("SET LOCAL lock_timeout = '5000ms'");

      let totalAffectedRows = 0;

      for (let i = 0; i < plan.statements.length; i++) {
        checkAborted(options.signal);
        const stmt = plan.statements[i];
        const sqlText = reclass.statements[i].sql;
        const boundParams = payload.params.slice(0, stmt.paramCount);
        const isMutation = isMutationRisk(stmt.risk);
        if (isMutation) writeDispatched = true;

        try {
          const result = await client.query(sqlText, boundParams);
          if (result.rowCount !== null && isMutation) totalAffectedRows += result.rowCount;
        } catch (queryErr: unknown) {
          const ce = classifyError(queryErr);
          const rollbackOk = await safeRollback(client);
          const isPgSqlstate = /^[0-9A-Z]{5}$/.test(ce.sqlstate.toUpperCase());

          if (!writeDispatched || (ce.definitive && isPgSqlstate)) {
            if (ce.shipCode === "E_CANCELLED" && !isPgSqlstate) {
              await safeAppendTerminal(plan, options.cwd, "failed", "E_CANCELLED");
              terminalAppended = true;
              throw err("E_CANCELLED", "database operation cancelled", ce.retryable);
            }
            await safeAppendTerminal(plan, options.cwd, "failed", ce.sqlstate);
            terminalAppended = true;
            throwMapped(ce);
          }

          if (ce.shipCode === "E_CANCELLED") {
            if (rollbackOk) {
              await safeAppendTerminal(plan, options.cwd, "failed", "E_CANCELLED");
              terminalAppended = true;
              throw err("E_CANCELLED", "database operation cancelled", true);
            }
            await safeAppendTerminal(plan, options.cwd, "ambiguous");
            terminalAppended = true;
            throw err("E_STATE_CONFLICT", "database operation result uncertain after cancellation", false);
          }

          await safeAppendTerminal(plan, options.cwd, "ambiguous");
          terminalAppended = true;
          throw err("E_STATE_CONFLICT", "database operation result uncertain after transport error", false);
        }
      }

      checkAborted(options.signal);

      try {
        await client.query("COMMIT");
        commitAcknowledged = true;
        began = false;
      } catch (commitErr: unknown) {
        const ce = classifyError(commitErr);
        await safeRollback(client);
        if (ce.definitive) {
          await safeAppendTerminal(plan, options.cwd, "failed", ce.sqlstate);
          terminalAppended = true;
          throwMapped(ce);
        }
        await safeAppendTerminal(plan, options.cwd, "ambiguous");
        terminalAppended = true;
        throw err("E_STATE_CONFLICT", "database commit result uncertain after transport error", false);
      }

      await safeAppendTerminal(plan, options.cwd, "committed");
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

      const ce = classifyError(e);

      let rollbackOk = false;
      if (began) rollbackOk = await safeRollback(client);

      if (ce.shipCode === "E_CANCELLED") {
        if (!writeDispatched || rollbackOk) {
          await safeAppendTerminal(plan, options.cwd, "failed", "E_CANCELLED");
          terminalAppended = true;
          throw err("E_CANCELLED", "database operation cancelled", true);
        }
        await safeAppendTerminal(plan, options.cwd, "ambiguous");
        terminalAppended = true;
        throw err("E_STATE_CONFLICT", "database operation result uncertain after cancellation", false);
      }

      if (!writeDispatched && !commitAcknowledged) {
        await safeAppendTerminal(plan, options.cwd, "failed", ce.sqlstate);
        terminalAppended = true;
        throwMapped(ce);
      }

      if (began) {
        await safeAppendTerminal(plan, options.cwd, "failed", ce.sqlstate);
        terminalAppended = true;
        throwMapped(ce);
      }

      await safeAppendTerminal(plan, options.cwd, "ambiguous");
      terminalAppended = true;
      throw err("E_STATE_CONFLICT", "database operation result uncertain", false);
    } finally {
      if (client) {
        try { await client.end(); } catch { /* best-effort */ }
      }
    }
  });
}
