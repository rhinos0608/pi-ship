import { err, type ShipErrorCode } from "../../core/errors.js";
import { authorizeCloudflarePlanApply, type CloudflareAuthorizationContext } from "./authorization.js";
import { appendOperationEntry, readOperationJournal, type NewOperationJournalEntry, type OperationJournalEntry } from "./operation-journal.js";
import type { CloudflarePlan, CloudflareOperation } from "./plan.js";
import type { OperationResult, ReconciliationState, Verification, UnverifiedReason } from "../../deployment/contracts.js";
import { loadCloudflareState, saveCloudflareState, type CloudflareState } from "./state.js";
import type { CloudflareRuntime } from "./runtime.js";
import { statePath } from "../../persistence/state-store.js";
import {
  runOperationPlan,
  filterPriorEntries,
  latestResourceRef as genericLatestResourceRef,
  type OperationRunHooks,
  type GenericOperation,
  type PriorEntry,
} from "../../deployment/operation-engine.js";

// ── Context ─────────────────────────────────────────────────────────────────
export interface ApplyCloudflarePlanContext extends Omit<CloudflareAuthorizationContext, "plan" | "state"> {
  plan: CloudflarePlan;
  createRuntime: () => CloudflareRuntime;
  loadSecrets: () => Readonly<Record<string, string>>;
  stateStore?: {
    load(): Promise<CloudflareState>;
    save(state: CloudflareState): Promise<void>;
  };

  /**
   * Optional callback invoked after authorization passes.
   * When provided, wraps the execution body in a capability-backed scope
   * so credentialSource.get() calls are validated.
   * Defaults to identity when undefined (managed mode, no vault).
   */
  runAfterAuthorization?: <T>(fn: () => T) => T;
}

// ── Public entry point ──────────────────────────────────────────────────────
function stateStore(ctx: ApplyCloudflarePlanContext) {
  return ctx.stateStore ?? {
    load: () => loadCloudflareState(ctx.cwd),
    save: (state: CloudflareState) => saveCloudflareState(ctx.cwd, state),
  };
}

export async function applyCloudflarePlan(ctx: ApplyCloudflarePlanContext): Promise<CloudflareState> {
  const store = stateStore(ctx);
  let state = await store.load();
  await authorizeCloudflarePlanApply({ ...ctx, state });
  const runFn = ctx.runAfterAuthorization ?? (<T>(fn: () => T) => fn());
  return runFn(async () => {
    const runtime = ctx.createRuntime();
    const secretValues = ctx.loadSecrets();
    await verifyRuntimeAccount(runtime, ctx.plan, ctx.signal);
    const missing = ctx.plan.secretNames.filter((name) => secretValues[name] === undefined);
    if (missing.length > 0) throw err("E_PRECONDITION", `missing secrets: ${missing.join(", ")}`);

    state = await runOperationPlan<CloudflareOperation, CloudflareState>(
      ctx.plan,
      ctx.plan.operations,
      buildHooks(ctx, runtime, secretValues),
    );

    if (!state.history.some((entry) => entry.planId === ctx.plan.planId && entry.digest === ctx.plan.planDigest)) {
      state = {
        ...state,
        history: [
          ...state.history,
          {
            planId: ctx.plan.planId,
            digest: ctx.plan.planDigest,
            status: "ok",
            at: new Date().toISOString(),
          },
        ],
      };
      await store.save(state);
    }
    return state;
  });

}

// ── Hooks builder ───────────────────────────────────────────────────────────
function buildHooks(ctx: ApplyCloudflarePlanContext, runtime: CloudflareRuntime, secretValues: Readonly<Record<string, string>>): OperationRunHooks<CloudflareOperation, CloudflareState> {
  return {
    signal: ctx.signal,

    loadState: () => stateStore(ctx).load(),

    saveState: (state) => stateStore(ctx).save(state),

    readPriorEntries: async (operation, planId, planDigest) => {
      const entries = await readOperationJournal(ctx.cwd);
      return filterPriorEntries(entries, planId, planDigest, operation);
    },

    appendStart: async (operation, attempt) => {
      await appendJournalEntry(ctx, operation, attempt, { status: "start" } as JournalOutcome);
    },

    appendOk: async (operation, attempt, result) => {
      await appendJournalEntry(ctx, operation, attempt, {
        status: "ok",
        resourceRef: result.resourceRef,
        observedStateFingerprint: result.observedStateFingerprint,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      } as JournalOutcome);
    },

    appendFail: async (operation, attempt, error) => {
      await appendJournalEntry(ctx, operation, attempt, {
        status: "fail",
        error: { code: error.code, message: error.safeMessage, retryable: error.retryable },
      } as JournalOutcome);
    },

    appendAmbiguous: async (operation, attempt, result) => {
      await appendJournalEntry(ctx, operation, attempt, {
        status: "ambiguous",
        reason: result.reason,
        safeMessage: result.safeMessage,
        ...(result.resourceRef ? { resourceRef: result.resourceRef } : {}),
      } as JournalOutcome);
    },

    appendReconciled: async (operation, attempt, reconciliation) => {
      await appendJournalEntry(ctx, operation, attempt, {
        status: "reconciled",
        outcome: reconciliation.outcome,
        observedStateFingerprint: reconciliation.observedStateFingerprint,
        ...(reconciliation.resourceRef ? { resourceRef: reconciliation.resourceRef } : {}),
      } as JournalOutcome);
    },

    appendReconciledUnverified: async (operation, attempt, verification) => {
      await appendJournalEntry(ctx, operation, attempt, {
        status: "reconciled",
        outcome: "unverified",
        reason: verification.reason,
        safeMessage: verification.safeMessage,
      } as JournalOutcome);
    },

    execute: async (operation) => {
      try {
        const result = await runtime.execute(operation, { secretValues }, ctx.signal);
        return result;
      } catch (cause: unknown) {
        if (ctx.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) {
          throw err("E_CANCELLED", "operation cancelled", true);
        }
        throw cause;
      }
    },

    reconcile: async (operation, resourceRef) => {
      const result = await runtime.reconcile(operation, resourceRef, ctx.signal);
      return result;
    },

    applyVerifiedState: (state, operation, result) => {
      return applyVerifiedCloudflareState(state, ctx.plan, operation, result.resourceRef);
    },

    requireResource: (operation, resourceRef) => {
      if (
        (operation.kind === "ensure_worker" || operation.kind === "deploy" || operation.kind === "rollback") &&
        (!resourceRef || resourceRef === "unknown")
      ) {
        throw err("E_STATE_CONFLICT", `${operation.kind} returned no resource ID`);
      }
    },
  };
}

// ── Journal helper ──────────────────────────────────────────────────────────
type BaseEntryKeys = "version" | "ts" | "planId" | "planDigest" | "provider" | "operationId" | "kind" | "targetFingerprint" | "requestFingerprint" | "expectedStateFingerprint" | "attempt";
type JournalOutcome = Omit<NewOperationJournalEntry, BaseEntryKeys>;

function baseJournalEntry(ctx: ApplyCloudflarePlanContext, operation: CloudflareOperation, attempt: number) {
  return {
    version: 1 as const,
    ts: new Date().toISOString(),
    planId: ctx.plan.planId,
    planDigest: ctx.plan.planDigest,
    provider: "cloudflare" as const,
    operationId: operation.operationId,
    kind: operation.kind,
    targetFingerprint: operation.targetFingerprint,
    requestFingerprint: operation.requestFingerprint,
    expectedStateFingerprint: operation.expectedStateFingerprint,
    attempt,
  };
}

function appendJournalEntry(
  ctx: ApplyCloudflarePlanContext,
  operation: CloudflareOperation,
  attempt: number,
  outcome: JournalOutcome,
): Promise<OperationJournalEntry> {
  return appendOperationEntry(ctx.cwd, { ...baseJournalEntry(ctx, operation, attempt), ...outcome } as NewOperationJournalEntry);
}

// ── Auth helper ─────────────────────────────────────────────────────────────
async function verifyRuntimeAccount(runtime: CloudflareRuntime, plan: CloudflarePlan, signal: AbortSignal | undefined): Promise<void> {
  const auth = await runtime.checkAuth(signal);
  if (auth.status === "unverified") {
    const code = auth.reason === "unauthorized" || auth.reason === "forbidden"
      ? "E_AUTH_MISSING"
      : "E_STATE_CONFLICT";
    throw err(code, auth.safeMessage, auth.retryable);
  }
  if (auth.value.kind !== plan.identity.account.kind || auth.value.id !== plan.identity.account.id) {
    throw err("E_STATE_CONFLICT", "provider account does not match approved plan");
  }
}

// ── State projection ────────────────────────────────────────────────────────
export function applyVerifiedCloudflareState(
  state: CloudflareState,
  plan: CloudflarePlan,
  operation: CloudflareOperation,
  resourceRef?: string,
): CloudflareState {
  if (
    (operation.kind === "ensure_worker" || operation.kind === "deploy" || operation.kind === "rollback") &&
    (!resourceRef || resourceRef === "unknown")
  ) {
    throw err("E_STATE_CONFLICT", `${operation.kind} returned no resource ID`);
  }
  const next = structuredClone(state);
  next.accountId = plan.identity.account.id;

  if (operation.kind === "ensure_worker") {
    next.worker = {
      name: plan.identity.worker.name,
      etag: undefined,
    };
  }

  if (operation.kind === "deploy" || operation.kind === "rollback") {
    const at = new Date().toISOString();
    if (next.worker) {
      next.worker = { ...next.worker, name: plan.identity.worker.name };
    }
    if (!next.deployments.some((d) => d.id === resourceRef && d.planId === plan.planId)) {
      next.deployments.push({
        id: resourceRef!,
        versionId: operation.kind === "deploy"
          ? (operation as CloudflareOperation & { kind: "deploy" }).versionId
          : (operation as CloudflareOperation & { kind: "rollback" }).targetVersionId,
        planId: plan.planId,
        digest: plan.planDigest,
        at,
      });
    }
  }

  return next;
}

// ── Provider error code helper ──────────────────────────────────────────────
export function providerCode(code: string): ShipErrorCode {
  const valid = new Set<ShipErrorCode>([
    "E_CONFIG_INVALID", "E_AUTH_MISSING", "E_PRECONDITION", "E_PLAN_NOT_FOUND",
    "E_PLAN_STALE", "E_DIGEST_MISMATCH", "E_APPROVAL_REQUIRED", "E_APPROVAL_DENIED",
    "E_PROVIDER", "E_CANCELLED", "E_PHASE_UNSUPPORTED", "E_STATE_CONFLICT",
  ]);
  return valid.has(code as ShipErrorCode) ? code as ShipErrorCode : "E_PROVIDER";
}
