import { isShipError } from "../../core/errors.js";
import {
  verified,
  unverified,
  type AccountRef,
  type OperationRuntime,
  type Verification,
  type OperationResult,
  type ReconciliationState,
  type UnverifiedReason,
} from "../../deployment/contracts.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCloudflareOperations,
  type CloudflareOperation,
} from "./plan.js";
import type { CloudflareClient } from "./client.js";

// ── Types ───────────────────────────────────────────────────────────────────
export type CloudflareRuntime = OperationRuntime<
  CloudflareSnapshot,
  CloudflareOperation,
  CloudflarePlanInput,
  CloudflareExecutionInput,
  string,
  string
>;

export interface CloudflarePlanInput {
  environment: "preview" | "production";
  workerName: string;
  accountId: string;
  secretNames?: readonly string[];
  versionId?: string;
  targetVersionId?: string;
  source?: string;
}

export interface CloudflareExecutionInput {
  secretValues: Readonly<Record<string, string>>;
}

export interface CloudflareSnapshot {
  account: { kind: "user"; id: string };
  worker: { name: string; exists: boolean };
}

// ── Error certainty helpers ─────────────────────────────────────────────────
function httpStatus(e: unknown): number | undefined {
  if (isShipError(e) && e.details && typeof e.details.status === "number") {
    return e.details.status;
  }
  return undefined;
}

function verificationError<T>(e: unknown, safeMessage: string): Verification<T> {
  const status = httpStatus(e);
  if (status === 401) return unverified<T>("unauthorized", safeMessage, false);
  if (status === 403) return unverified<T>("forbidden", safeMessage, false);
  if (status === 429) return unverified<T>("rate_limited", safeMessage, true);
  if (status !== undefined && status >= 500) {
    return unverified<T>("transport", safeMessage, isShipError(e) ? e.retryable : true);
  }
  if (isShipError(e)) {
    if (e.code === "E_AUTH_MISSING") return unverified<T>("unauthorized", safeMessage, false);
    if (e.retryable) return unverified<T>("transport", safeMessage, true);
    return unverified<T>("malformed", safeMessage, false);
  }
  return unverified<T>("transport", safeMessage, true);
}

function mutationResult(e: unknown, safeMessage: string): OperationResult {
  if (isShipError(e)) {
    const status = httpStatus(e);
    if (e.code === "E_AUTH_MISSING" || e.code === "E_PRECONDITION") {
      return { status: "failed", certainty: "not_applied", code: e.code, safeMessage, retryable: e.retryable };
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
      return { status: "failed", certainty: "not_applied", code: e.code, safeMessage, retryable: e.retryable };
    }
    if (status === 429) {
      return { status: "ambiguous", reason: "rate_limited", safeMessage };
    }
    return { status: "ambiguous", reason: "transport", safeMessage };
  }
  return { status: "ambiguous", reason: "transport", safeMessage };
}

function readResult(e: unknown, safeMessage: string): OperationResult {
  if (isShipError(e)) {
    const status = httpStatus(e);
    if (status === 404) {
      return { status: "failed", certainty: "not_applied", code: "E_PROVIDER", safeMessage, retryable: false };
    }
    if (status !== undefined && status !== 429 && status < 500) {
      return { status: "failed", certainty: "not_applied", code: e.code, safeMessage, retryable: e.retryable };
    }
    return { status: "ambiguous", reason: status === 429 ? "rate_limited" : "transport", safeMessage };
  }
  return { status: "ambiguous", reason: "transport", safeMessage };
}

function providerFailed(code: string, safeMessage: string, retryable = false): OperationResult {
  return { status: "failed", certainty: "not_applied", code, safeMessage, retryable };
}

function ambiguousOp(reason: UnverifiedReason, safeMessage: string): OperationResult {
  return { status: "ambiguous", reason, safeMessage };
}

function unverifiedRecon(
  reason: UnverifiedReason,
  safeMessage: string,
  retryable = false,
): Verification<ReconciliationState> {
  return unverified<ReconciliationState>(reason, safeMessage, retryable);
}

// ── Factory ─────────────────────────────────────────────────────────────────
export interface CloudflareRuntimeOptions {
  client: CloudflareClient;
  accountId: string;
  cwd: string;
  mainModule?: string;
  compatibilityDate?: string;
}

export function createCloudflareRuntime(
  options: CloudflareRuntimeOptions,
): CloudflareRuntime {
  const { client, accountId, cwd, mainModule, compatibilityDate } = options;

  // ── Source file helper ──────────────────────────────────────────────────────
  async function readSourceFile(
    workerCwd: string,
    operation: CloudflareOperation & { source?: string },
  ): Promise<string> {
    if (operation.source) {
      const resolved = path.resolve(workerCwd, operation.source);
      return await readFile(resolved, "utf-8");
    }
    return "// placeholder – real content uploaded via version";
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function doCheckAuth(signal?: AbortSignal): Promise<Verification<AccountRef>> {
    try {
      const auth = await client.checkAuth(signal);
      if (!auth.ok) {
        return unverified<AccountRef>("unauthorized", "Cloudflare auth check failed", false);
      }
      return verified<AccountRef>({ kind: "user", id: auth.accountId });
    } catch (e: unknown) {
      return verificationError<AccountRef>(e, "Cloudflare auth check failed");
    }
  }

  // ── Discover ──────────────────────────────────────────────────────────────
  async function doDiscover(
    target: { workerName: string },
    signal?: AbortSignal,
  ): Promise<Verification<CloudflareSnapshot>> {
    try {
      const auth = await doCheckAuth(signal);
      if (auth.status === "unverified") {
        return unverified<CloudflareSnapshot>(auth.reason, auth.safeMessage, auth.retryable);
      }
      const existing = await client.getWorker(target.workerName, signal);
      return verified<CloudflareSnapshot>({
        account: { kind: "user", id: auth.value.id },
        worker: { name: target.workerName, exists: existing !== null },
      });
    } catch (e: unknown) {
      return verificationError<CloudflareSnapshot>(e, "Cloudflare worker discovery failed");
    }
  }

  // ── Plan ──────────────────────────────────────────────────────────────────
  async function doPlan(
    intent: "deploy" | "rollback",
    input: CloudflarePlanInput,
    _snapshot: CloudflareSnapshot,
  ): Promise<Verification<readonly CloudflareOperation[]>> {
    try {
      if (intent === "rollback" && !input.targetVersionId) {
        return unverified<readonly CloudflareOperation[]>("missing_payload", "rollback requires targetVersionId");
      }
      if (intent === "deploy" && !input.versionId) {
        return unverified<readonly CloudflareOperation[]>("missing_payload", "deploy plan requires versionId");
      }
      const operations = buildCloudflareOperations(intent, input.environment, {
        workerName: input.workerName,
        accountId: input.accountId,
        secretNames: (input.secretNames ?? []) as string[],
        versionId: intent === "deploy" ? input.versionId : undefined,
        targetVersionId: intent === "rollback" ? input.targetVersionId : undefined,
        source: input.source,
      });
      return verified<readonly CloudflareOperation[]>(operations);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return unverified<readonly CloudflareOperation[]>("malformed", msg, false);
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  async function doExecute(
    operation: CloudflareOperation,
    input: CloudflareExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    try {
      switch (operation.kind) {
        case "ensure_worker":
          return executeEnsureWorker(operation, input, signal);
        case "upload_version":
          return executeUploadVersion(operation, input, signal);
        case "set_secrets":
          return executeSetSecrets(operation, input, signal);
        case "deploy":
          return executeDeploy(operation, signal);
        case "rollback":
          return executeRollback(operation, signal);
      }
    } catch (e: unknown) {
      if (isShipError(e)) return providerFailed(e.code, e.message, e.retryable);
      return ambiguousOp("transport", "unexpected execution error");
    }
  }

  async function executeEnsureWorker(
    operation: CloudflareOperation & { kind: "ensure_worker" },
    _input: CloudflareExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    // Check if worker already exists — GET/read
    let existing;
    try {
      existing = await client.getWorker(operation.workerName, signal);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return readResult(e, msg);
    }

    if (existing) {
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: existing.id,
      };
    }

    // Create worker via multipart PUT — mutation
    try {
      const metadata = {
        compatibility_date: compatibilityDate ?? "2024-01-01",
        main_module: mainModule ?? "main.js",
      };
      const scriptContent = await readSourceFile(cwd, operation);
      const created = await client.uploadWorker(operation.workerName, metadata, scriptContent, signal);
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: created.id,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }
  }

  async function executeUploadVersion(
    operation: CloudflareOperation & { kind: "upload_version" },
    _input: CloudflareExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    try {
      const metadata = {
        compatibility_date: compatibilityDate ?? "2024-01-01",
        main_module: mainModule ?? "main.js",
      };
      const scriptContent = await readSourceFile(cwd, operation);
      const version = await client.uploadVersion(operation.workerName, metadata, scriptContent, signal);
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: version.id,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }
  }

  async function executeSetSecrets(
    operation: CloudflareOperation & { kind: "set_secrets" },
    input: CloudflareExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const secretNames = operation.secretNames ?? [];
    if (secretNames.length === 0) {
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: operation.operationId,
      };
    }

    const bulkOps: Array<{ name: string; type: "secret_text"; value: string }> = [];
    for (const name of secretNames) {
      const value = input.secretValues[name];
      if (value === undefined) {
        return providerFailed("E_PRECONDITION", `missing required secret value: "${name}"`);
      }
      bulkOps.push({ name, type: "secret_text", value });
    }

    try {
      await client.bulkSecrets(operation.workerName, bulkOps, signal);
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: operation.operationId,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }
  }

  async function executeDeploy(
    operation: CloudflareOperation & { kind: "deploy" },
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    try {
      // Pick latest version at execution time to avoid the "pending" versionId
      // that results from upload_version result not propagating through the generic engine.
      // Cloudflare API returns versions newest-first.
      const versions = await client.listVersions(operation.workerName, signal);
      if (!versions || versions.length === 0) {
        return providerFailed("E_PRECONDITION", "no versions available for deployment");
      }
      const latestVersionId = versions[0].id;
      const deployment = await client.createDeployment(
        operation.workerName,
        [{ version_id: latestVersionId, percentage: 100 }],
        undefined,
        signal,
      );
      if (!deployment.id) {
        return providerFailed("E_PROVIDER", "deployment response missing id");
      }
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: deployment.id,
        providerRequestId: deployment.id,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }
  }

  async function executeRollback(
    operation: CloudflareOperation & { kind: "rollback" },
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    // Rollback = create new deployment pointing to old version
    try {
      const deployment = await client.createDeployment(
        operation.workerName,
        [{ version_id: operation.targetVersionId, percentage: 100 }],
        true,
        signal,
      );
      if (!deployment.id) {
        return providerFailed("E_PROVIDER", "rollback deployment response missing id");
      }
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: deployment.id,
        providerRequestId: deployment.id,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────
  async function doReconcile(
    operation: CloudflareOperation,
    resourceRef?: string,
    signal?: AbortSignal,
  ): Promise<Verification<ReconciliationState>> {
    try {
      switch (operation.kind) {
        case "ensure_worker":
          return reconcileWorker(operation, resourceRef, signal);
        case "upload_version":
          return unverifiedRecon("missing_payload", "version upload is write-only; cannot reconcile");
        case "set_secrets":
          return unverifiedRecon("missing_payload", "secrets are write-only; cannot reconcile");
        case "deploy":
          return reconcileDeploy(operation, resourceRef, signal);
        case "rollback":
          return unverifiedRecon("missing_payload", "rollback is write-only; cannot reconcile");
      }
    } catch (e: unknown) {
      if (isShipError(e)) return unverifiedRecon("transport", e.message, e.retryable);
      return unverifiedRecon("transport", "reconciliation failed", true);
    }
  }

  async function reconcileWorker(
    operation: CloudflareOperation & { kind: "ensure_worker" },
    resourceRef?: string,
    signal?: AbortSignal,
  ): Promise<Verification<ReconciliationState>> {
    try {
      const worker = await client.getWorker(operation.workerName, signal);
      if (!worker) {
        return verified<ReconciliationState>({ outcome: "not_applied", observedStateFingerprint: "absent" });
      }
      if (resourceRef && worker.id !== resourceRef) {
        return verified<ReconciliationState>({ outcome: "conflict", observedStateFingerprint: resourceRef });
      }
      return verified<ReconciliationState>({
        outcome: "matches_expected",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: worker.id,
      });
    } catch (e: unknown) {
      return verificationError<ReconciliationState>(e, "Cloudflare worker reconciliation failed");
    }
  }

  async function reconcileDeploy(
    operation: CloudflareOperation & { kind: "deploy" },
    resourceRef?: string,
    signal?: AbortSignal,
  ): Promise<Verification<ReconciliationState>> {
    if (!resourceRef) {
      return unverifiedRecon("missing_payload", "no resource ref for deployment reconciliation");
    }
    try {
      const deployment = await client.getDeployment(operation.workerName, resourceRef, signal);
      if (!deployment) {
        return verified<ReconciliationState>({ outcome: "not_applied", observedStateFingerprint: "absent" });
      }
      return verified<ReconciliationState>({
        outcome: "matches_expected",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: deployment.id,
      });
    } catch (e: unknown) {
      if (isShipError(e)) {
        const status = httpStatus(e);
        if (status === 404) {
          return verified<ReconciliationState>({ outcome: "not_applied", observedStateFingerprint: "absent" });
        }
        return unverifiedRecon("transport", e.message, e.retryable);
      }
      return unverifiedRecon("transport", "reconciliation failed", true);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────
  async function doStatus(_releaseId: string, _signal?: AbortSignal): Promise<Verification<string>> {
    // Cloudflare deployments are immutable and don't have build states like Vercel
    return verified<string>("deployed");
  }

  // ── Logs ──────────────────────────────────────────────────────────────────
  async function doLogs(
    _releaseId: string,
    _input: { lines: number; secretValues: readonly string[] },
    _signal?: AbortSignal,
  ): Promise<Verification<string>> {
    // Logs not implemented in MVP (deferred)
    return verified<string>("Logs not available for Cloudflare Workers in this version.");
  }

  // ── Assemble runtime ──────────────────────────────────────────────────────
  return {
    descriptor: {
      domain: "app",
      provider: "cloudflare",
      capabilities: [
        "discover",
        "write_secrets",
        "deploy",
        "status",
        "rollback",
      ] as const,
    },
    checkAuth: doCheckAuth,
    discover: doDiscover,
    plan: doPlan,
    execute: doExecute,
    reconcile: doReconcile,
    status: doStatus,
    logs: doLogs,
  };
}
