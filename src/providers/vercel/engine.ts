import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { authorizeVercelPlanApply, type VercelAuthorizationContext } from "./authorization.js";
import { err, type ShipErrorCode } from "../../core/errors.js";
import { appendOperationEntry, readOperationJournal, type NewOperationJournalEntry, type OperationJournalEntry } from "./operation-journal.js";
import type { VercelPlan, VercelOperation } from "./plan.js";
import type {
  OperationResult,
  ReconciliationState,
  Verification,
  AccountRef,
  UnverifiedReason,
} from "../../deployment/contracts.js";
import { loadVercelState, saveVercelState, type VercelState } from "./state.js";
import type { VercelRuntime } from "./runtime.js";
import { statePath } from "../../persistence/state-store.js";
import {
  runOperationPlan,
  filterPriorEntries,
  latestResourceRef as genericLatestResourceRef,
  type OperationRunHooks,
  type GenericOperation,
  type PriorEntry,
} from "../../deployment/operation-engine.js";

// ── Vercel Release Status ───────────────────────────────────────────────────

export type VercelReleaseStatus =
  | "queued"
  | "initializing"
  | "building"
  | "ready"
  | "error"
  | "canceled"
  | "blocked";

// ── Context ─────────────────────────────────────────────────────────────────

export interface ApplyVercelPlanContext extends Omit<VercelAuthorizationContext, "plan" | "state"> {
  plan: VercelPlan;
  runtime: VercelRuntime;
  secretValues: Readonly<Record<string, string>>;
  stateStore?: {
    load(): Promise<VercelState>;
    save(state: VercelState): Promise<void>;
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

function stateStore(ctx: ApplyVercelPlanContext) {
  return ctx.stateStore ?? {
    load: () => loadVercelState(ctx.cwd),
    save: (state: VercelState) => saveVercelState(ctx.cwd, state),
  };
}

export async function applyVercelPlan(ctx: ApplyVercelPlanContext): Promise<VercelState> {
  const store = stateStore(ctx);
  return withFileMutationQueue(statePath(ctx.cwd), async () => {
    let state = await store.load();
    await authorizeVercelPlanApply({ ...ctx, state });
    await verifyRuntimeAccount(ctx);
    const missing = ctx.plan.secretNames.filter((name) => ctx.secretValues[name] === undefined);
    if (missing.length > 0) throw err("E_PRECONDITION", `missing secrets: ${missing.join(", ")}`);

    state = await runOperationPlan<VercelOperation, VercelState, VercelReleaseStatus>(
      ctx.plan,
      ctx.plan.operations,
      buildHooks(ctx),
    );

    if (!state.history.some((entry) => entry.planId === ctx.plan.planId && entry.digest === ctx.plan.planDigest)) {
      state = {
        ...state,
        history: [
          ...state.history,
          {
            planId: ctx.plan.planId,
            digest: ctx.plan.planDigest,
            domain: "app",
            provider: "vercel",
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

function buildHooks(ctx: ApplyVercelPlanContext): OperationRunHooks<VercelOperation, VercelState, VercelReleaseStatus> {
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
        ...(result.releaseStatus ? { releaseStatus: result.releaseStatus } : {}),
        ...(result.releaseUrl ? { releaseUrl: result.releaseUrl } : {}),
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
        ...(reconciliation.releaseStatus ? { releaseStatus: reconciliation.releaseStatus } : {}),
        ...(reconciliation.releaseUrl ? { releaseUrl: reconciliation.releaseUrl } : {}),
        // Trust boundary: outcome is narrowed to known reconciliation literals
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
        const result = await ctx.runtime.execute(operation, { secretValues: ctx.secretValues }, ctx.signal);
        return result;
      } catch (cause: unknown) {
        if (ctx.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) {
          throw err("E_CANCELLED", "operation cancelled", true);
        }
        throw cause;
      }
    },

    reconcile: async (operation, resourceRef) => {
      const result = await ctx.runtime.reconcile(operation, resourceRef, ctx.signal);
      return result;
    },

    applyVerifiedState: (state, operation, result) => {
      return applyVerifiedVercelState(state, ctx.plan, operation, result.resourceRef, result.releaseStatus, result.releaseUrl);
    },

    requireResource: (operation, resourceRef) => {
      if (
        (operation.kind === "ensure_project" || operation.kind === "deploy" || operation.kind === "rollback") &&
        (!resourceRef || resourceRef === "unknown")
      ) {
        throw err("E_STATE_CONFLICT", `${operation.kind} returned no resource ID`);
      }
    },
  };
}

// ── Journal helper ──────────────────────────────────────────────────────────

// Base fields provided by baseJournalEntry.
type BaseEntryKeys = "version" | "ts" | "planId" | "planDigest" | "provider" | "domain" | "operationId" | "kind" | "targetFingerprint" | "requestFingerprint" | "expectedStateFingerprint" | "attempt";
type JournalOutcome = Omit<NewOperationJournalEntry, BaseEntryKeys>;

function baseJournalEntry(ctx: ApplyVercelPlanContext, operation: VercelOperation, attempt: number) {
  return {
    version: 2 as const,
    ts: new Date().toISOString(),
    planId: ctx.plan.planId,
    planDigest: ctx.plan.planDigest,
    provider: "vercel" as const,
    domain: "app" as const,
    operationId: operation.operationId,
    kind: operation.kind,
    targetFingerprint: operation.targetFingerprint,
    requestFingerprint: operation.requestFingerprint,
    expectedStateFingerprint: operation.expectedStateFingerprint,
    attempt,
  };
}

function appendJournalEntry(
  ctx: ApplyVercelPlanContext,
  operation: VercelOperation,
  attempt: number,
  outcome: JournalOutcome,
): Promise<OperationJournalEntry> {
  // Trust boundary: base fields + outcome reconstruct full NewOperationJournalEntry
  return appendOperationEntry(ctx.cwd, { ...baseJournalEntry(ctx, operation, attempt), ...outcome } as NewOperationJournalEntry);
}

// ── Auth helper ─────────────────────────────────────────────────────────────

async function verifyRuntimeAccount(ctx: ApplyVercelPlanContext): Promise<void> {
  const auth = await ctx.runtime.checkAuth(ctx.signal);
  if (auth.status === "unverified") {
    const code = auth.reason === "unauthorized" || auth.reason === "forbidden"
      ? "E_AUTH_MISSING"
      : "E_STATE_CONFLICT";
    throw err(code, auth.safeMessage, auth.retryable);
  }
  if (auth.value.kind !== ctx.plan.identity.account.kind || auth.value.id !== ctx.plan.identity.account.id) {
    throw err("E_STATE_CONFLICT", "provider account does not match approved plan");
  }
}

// ── State projection ────────────────────────────────────────────────────────

export function applyVerifiedVercelState(
  state: VercelState,
  plan: VercelPlan,
  operation: VercelOperation,
  resourceRef?: string,
  releaseStatus?: VercelReleaseStatus,
  releaseUrl?: string,
): VercelState {
  if (
    (operation.kind === "ensure_project" || operation.kind === "deploy" || operation.kind === "rollback") &&
    (!resourceRef || resourceRef === "unknown")
  ) {
    throw err("E_STATE_CONFLICT", `${operation.kind} returned no resource ID`);
  }
  const next = structuredClone(state);
  if (operation.kind === "ensure_project") {
    next.app = {
      provider: "vercel",
      account: plan.identity.account,
      accountFingerprint: plan.accountFingerprint,
      project: {
        id: resourceRef!,
        name: plan.identity.project.name,
        fingerprint: plan.projectFingerprint,
      },
      environments: next.app?.environments ?? {},
    };
  }
  if (!next.app) throw err("E_STATE_CONFLICT", "project state is missing after verified operation");

  const currentEnvironment = next.app.environments[plan.environment] ?? {
    targetFingerprint: plan.targetFingerprint,
  };
  if (operation.kind === "deploy" || operation.kind === "rollback") {
    const at = new Date().toISOString();
    const status = releaseStatus === "ready" ? "ready"
      : releaseStatus === "building" || releaseStatus === "queued" || releaseStatus === "initializing" ? "building"
      : releaseStatus === "error" ? "error"
      : releaseStatus === "canceled" ? "cancelled"
      : releaseStatus === "blocked" ? "blocked"
      : "unknown";
    next.app.environments[plan.environment] = {
      ...currentEnvironment,
      targetFingerprint: plan.targetFingerprint,
      lastRelease: {
        id: resourceRef!,
        planId: plan.planId,
        digest: plan.planDigest,
        status,
        ...(releaseUrl ? { url: releaseUrl } : {}),
        at,
      },
    };
    if (!next.releases.some((release) => release.releaseId === resourceRef && release.planId === plan.planId)) {
      next.releases.push({
        provider: "vercel",
        projectId: next.app.project.id,
        environment: plan.environment,
        releaseId: resourceRef!,
        planId: plan.planId,
        digest: plan.planDigest,
        ...(releaseUrl ? { url: releaseUrl } : {}),
        at,
      });
    }
  } else {
    next.app.environments[plan.environment] = {
      ...currentEnvironment,
      targetFingerprint: plan.targetFingerprint,
    };
  }
  return next;
}

// ── Provider error code helper (kept for potential external use) ────────────

export function providerCode(code: string): ShipErrorCode {
  const valid = new Set<ShipErrorCode>([
    "E_CONFIG_INVALID", "E_AUTH_MISSING", "E_PRECONDITION", "E_PLAN_NOT_FOUND",
    "E_PLAN_STALE", "E_DIGEST_MISMATCH", "E_APPROVAL_REQUIRED", "E_APPROVAL_DENIED",
    "E_PROVIDER", "E_CANCELLED", "E_PHASE_UNSUPPORTED", "E_STATE_CONFLICT",
  ]);
  return valid.has(code as ShipErrorCode) ? code as ShipErrorCode : "E_PROVIDER";
}
