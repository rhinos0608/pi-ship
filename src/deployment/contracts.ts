export type ProviderId = string;

export type UnverifiedReason =
  | "transport"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "malformed"
  | "missing_payload"
  | "conflict";

export type Verification<T> =
  | { status: "verified"; value: T; observedAt: string }
  | { status: "unverified"; reason: UnverifiedReason; retryable: boolean; safeMessage: string };

export interface AccountRef {
  kind: "team" | "user";
  id: string;
}

export type ReconciliationState<TReleaseStatus extends string = string> =
  | { outcome: "matches_expected"; observedStateFingerprint: string; resourceRef?: string; releaseStatus?: TReleaseStatus; releaseUrl?: string }
  | { outcome: "not_applied"; observedStateFingerprint: string }
  | { outcome: "conflict"; observedStateFingerprint: string };

export type OperationResult<TReleaseStatus extends string = string> =
  | { status: "succeeded"; observedStateFingerprint: string; resourceRef: string; providerRequestId?: string; releaseStatus?: TReleaseStatus; releaseUrl?: string }
  | { status: "failed"; certainty: "not_applied"; code: string; safeMessage: string; retryable: boolean }
  | { status: "ambiguous"; reason: UnverifiedReason; safeMessage: string; resourceRef?: string };

export function verified<T>(value: T, observedAt = new Date().toISOString()): Verification<T> {
  return { status: "verified", value, observedAt };
}

export function unverified<T>(reason: UnverifiedReason, safeMessage: string, retryable = false): Verification<T> {
  return { status: "unverified", reason, retryable, safeMessage };
}

export interface OperationRuntime<TSnapshot, TOperation, TPlanInput, TExecutionInput, TStatus, TLogs, TReleaseStatus extends string = string> {
  readonly descriptor: { domain: string; provider: ProviderId; capabilities: readonly string[] };
  checkAuth(signal?: AbortSignal): Promise<Verification<AccountRef>>;
  discover(target: unknown, signal?: AbortSignal): Promise<Verification<TSnapshot>>;
  plan(intent: string, input: TPlanInput, snapshot: TSnapshot): Promise<Verification<readonly TOperation[]>>;
  execute(operation: TOperation, input: TExecutionInput, signal?: AbortSignal): Promise<OperationResult<TReleaseStatus>>;
  reconcile(operation: TOperation, resourceRef?: string, signal?: AbortSignal): Promise<Verification<ReconciliationState<TReleaseStatus>>>;
  status(releaseId: string, signal?: AbortSignal): Promise<Verification<TStatus>>;
  logs(releaseId: string, input: { lines: number; secretValues: readonly string[] }, signal?: AbortSignal): Promise<Verification<TLogs>>;
}
