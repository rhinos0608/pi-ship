import { err } from "../core/errors.js";
import type { ShipErrorCode } from "../core/errors.js";
import type { OperationResult, ReconciliationState, UnverifiedReason, Verification } from "./contracts.js";

// ── Generic operation shape ─────────────────────────────────────────────────

export interface GenericOperation {
  readonly operationId: string;
  readonly dependsOn: readonly string[];
  readonly targetFingerprint: string;
  readonly requestFingerprint: string;
  readonly expectedStateFingerprint: string;
  readonly kind: string;
}

// ── Prior entry shape ───────────────────────────────────────────────────────

export interface PriorEntry {
  readonly planId: string;
  readonly planDigest: string;
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly expectedStateFingerprint: string;
  readonly attempt: number;
  readonly resourceRef?: string;
  readonly status: string;
}

// ── Execution result (returned per-operation from the loop) ──────────────────

export interface OperationPlanResult<TReleaseStatus extends string = string> {
  resourceRef?: string;
  releaseStatus?: TReleaseStatus;
  releaseUrl?: string;
  providerRequestId?: string;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export interface OperationRunHooks<TOperation extends GenericOperation, TState, TReleaseStatus extends string = string> {
  readonly signal?: AbortSignal;

  loadState(): Promise<TState>;
  saveState(state: TState): Promise<void>;
  readPriorEntries(operation: TOperation, planId: string, planDigest: string): Promise<readonly PriorEntry[]>;
  appendStart(operation: TOperation, attempt: number): Promise<void>;
  appendOk(operation: TOperation, attempt: number, result: { resourceRef: string; observedStateFingerprint: string; providerRequestId?: string; releaseStatus?: TReleaseStatus; releaseUrl?: string }): Promise<void>;
  appendFail(operation: TOperation, attempt: number, error: { code: ShipErrorCode; safeMessage: string; retryable: boolean }): Promise<void>;
  appendAmbiguous(operation: TOperation, attempt: number, result: { reason: UnverifiedReason; safeMessage: string; resourceRef?: string }): Promise<void>;
  appendReconciled(operation: TOperation, attempt: number, reconciliation: { outcome: "matches_expected" | "not_applied" | "conflict"; observedStateFingerprint: string; resourceRef?: string; releaseStatus?: TReleaseStatus; releaseUrl?: string }): Promise<void>;
  appendReconciledUnverified(operation: TOperation, attempt: number, verification: Verification<ReconciliationState<TReleaseStatus>> & { status: "unverified" }): Promise<void>;
  execute(operation: TOperation): Promise<OperationResult<TReleaseStatus>>;
  reconcile(operation: TOperation, resourceRef?: string): Promise<Verification<ReconciliationState<TReleaseStatus>>>;
  applyVerifiedState(state: TState, operation: TOperation, result: OperationPlanResult<TReleaseStatus>): TState;
  requireResource(operation: TOperation, resourceRef?: string): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function filterPriorEntries<TPrior extends PriorEntry>(
  entries: readonly TPrior[],
  planId: string,
  planDigest: string,
  operation: { operationId: string; requestFingerprint: string; expectedStateFingerprint: string },
): TPrior[] {
  return entries.filter(
    (entry) =>
      entry.planId === planId &&
      entry.planDigest === planDigest &&
      entry.operationId === operation.operationId &&
      entry.requestFingerprint === operation.requestFingerprint &&
      entry.expectedStateFingerprint === operation.expectedStateFingerprint,
  );
}

export function latestResourceRef(entries: readonly PriorEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if ("resourceRef" in entry && typeof entry.resourceRef === "string") return entry.resourceRef;
  }
  return undefined;
}

export function providerStatusCode(code: string): ShipErrorCode {
  const valid = new Set<ShipErrorCode>([
    "E_CONFIG_INVALID", "E_AUTH_MISSING", "E_PRECONDITION", "E_PLAN_NOT_FOUND",
    "E_PLAN_STALE", "E_DIGEST_MISMATCH", "E_APPROVAL_REQUIRED", "E_APPROVAL_DENIED",
    "E_PROVIDER", "E_CANCELLED", "E_PHASE_UNSUPPORTED", "E_STATE_CONFLICT",
  ]);
  return valid.has(code as ShipErrorCode) ? code as ShipErrorCode : "E_PROVIDER";
}

// ── Main execution loop ─────────────────────────────────────────────────────

export async function runOperationPlan<TOperation extends GenericOperation, TState, TReleaseStatus extends string = string>(
  plan: { planId: string; planDigest: string },
  operations: readonly TOperation[],
  hooks: OperationRunHooks<TOperation, TState, TReleaseStatus>,
): Promise<TState> {
  let state: TState = await hooks.loadState();
  const completed = new Set<string>();

  for (const operation of operations) {
    checkAborted(hooks.signal);

    if (operation.dependsOn.some((dependency) => !completed.has(dependency))) {
      throw err("E_STATE_CONFLICT", "operation dependency has not completed");
    }

    const priorEntries = await hooks.readPriorEntries(operation, plan.planId, plan.planDigest);
    const prior = priorEntries.at(-1);
    let attempt = 1;

    if (prior) {
      const ref = latestResourceRef(priorEntries);
      const reconciliation = await reconcileWithHooks(hooks, operation, prior.attempt, ref);
      if (reconciliation.outcome === "matches_expected") {
        state = hooks.applyVerifiedState(state, operation, {
          resourceRef: reconciliation.resourceRef,
          releaseStatus: reconciliation.releaseStatus,
          releaseUrl: reconciliation.releaseUrl,
        });
        await hooks.saveState(state);
        completed.add(operation.operationId);
        continue;
      }
      if (reconciliation.outcome !== "not_applied" || prior.attempt >= 2) {
        throw err("E_STATE_CONFLICT", "operation state conflicts with approved plan");
      }
      attempt = prior.attempt + 1;
    }

    const result = await executeWithAttempts(hooks, operation, attempt);
    state = hooks.applyVerifiedState(state, operation, result);
    await hooks.saveState(state);
    completed.add(operation.operationId);
  }

  return state;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw err("E_CANCELLED", "operation cancelled", true);
}

async function reconcileWithHooks<TOperation extends GenericOperation, TReleaseStatus extends string>(
  hooks: OperationRunHooks<TOperation, unknown, TReleaseStatus>,
  operation: TOperation,
  attempt: number,
  resourceRef?: string,
): Promise<ReconciliationState<TReleaseStatus>> {
  const verification = await hooks.reconcile(operation, resourceRef);
  if (verification.status === "unverified") {
    await hooks.appendReconciledUnverified(operation, attempt, verification);
    throw err("E_STATE_CONFLICT", verification.safeMessage, verification.retryable);
  }
  const reconciliation = verification.value;
  await hooks.appendReconciled(operation, attempt, reconciliation);
  if (
    reconciliation.outcome === "matches_expected" &&
    reconciliation.observedStateFingerprint !== operation.expectedStateFingerprint
  ) {
    throw err("E_STATE_CONFLICT", "observed state does not match expected state");
  }
  return reconciliation;
}

async function executeWithAttempts<TOperation extends GenericOperation, TReleaseStatus extends string>(
  hooks: OperationRunHooks<TOperation, unknown, TReleaseStatus>,
  operation: TOperation,
  initialAttempt: number,
): Promise<OperationPlanResult<TReleaseStatus>> {
  let attempt = initialAttempt;

  while (attempt <= 2) {
    checkAborted(hooks.signal);
    await hooks.appendStart(operation, attempt);

    let result: OperationResult<TReleaseStatus>;
    try {
      result = await hooks.execute(operation);
    } catch (cause: unknown) {
      if (hooks.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        throw err("E_CANCELLED", "operation cancelled", true);
      }
      throw cause;
    }

    if (result.status === "succeeded") {
      if (result.observedStateFingerprint !== operation.expectedStateFingerprint) {
        await hooks.appendReconciled(operation, attempt, {
          outcome: "conflict",
          observedStateFingerprint: result.observedStateFingerprint,
        });
        throw err("E_STATE_CONFLICT", "provider returned unexpected state fingerprint");
      }
      hooks.requireResource(operation, result.resourceRef);
      await hooks.appendOk(operation, attempt, {
        resourceRef: result.resourceRef,
        observedStateFingerprint: result.observedStateFingerprint,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.releaseStatus ? { releaseStatus: result.releaseStatus } : {}),
        ...(result.releaseUrl ? { releaseUrl: result.releaseUrl } : {}),
      });
      return {
        resourceRef: result.resourceRef,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.releaseStatus ? { releaseStatus: result.releaseStatus } : {}),
        ...(result.releaseUrl ? { releaseUrl: result.releaseUrl } : {}),
      };
    }

    if (result.status === "failed") {
      const code = providerStatusCode(result.code);
      await hooks.appendFail(operation, attempt, { code, safeMessage: result.safeMessage, retryable: result.retryable });
      throw err(code, result.safeMessage, result.retryable);
    }

    await hooks.appendAmbiguous(operation, attempt, {
      reason: result.reason,
      safeMessage: result.safeMessage,
      ...(result.resourceRef ? { resourceRef: result.resourceRef } : {}),
    });

    const reconciliation = await reconcileWithHooks(hooks, operation, attempt, result.resourceRef);
    if (reconciliation.outcome === "matches_expected") {
      hooks.requireResource(operation, reconciliation.resourceRef);
      return {
        resourceRef: reconciliation.resourceRef,
        ...(reconciliation.releaseStatus ? { releaseStatus: reconciliation.releaseStatus } : {}),
        ...(reconciliation.releaseUrl ? { releaseUrl: reconciliation.releaseUrl } : {}),
      };
    }
    if (reconciliation.outcome !== "not_applied" || attempt >= 2) {
      throw err("E_STATE_CONFLICT", "operation state conflicts with approved plan");
    }
    attempt += 1;
  }

  throw err("E_STATE_CONFLICT", "operation exceeded the bounded retry limit");
}
