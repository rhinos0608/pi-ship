import { err, isShipError } from "../../core/errors.js";
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
import { redact } from "../../core/redact.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  buildCloudflareOperations,
  type CloudflareOperation,
} from "./plan.js";
import type { CloudflareClient } from "./client.js";
import type { TailEvent } from "./types.js";

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
  mainModule?: string;
  compatibilityDate?: string;
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
  workerName?: string;
  mainModule?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
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
    if (!operation.source) {
      return "// placeholder";
    }
    const resolved = await realpath(path.resolve(workerCwd, operation.source));
    const baseDir = await realpath(workerCwd);
    if (!resolved.startsWith(baseDir)) {
      throw err("E_PRECONDITION", "operation source path escapes workers directory");
    }
    return await readFile(resolved, "utf-8");
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
        mainModule: input.mainModule,
        compatibilityDate: input.compatibilityDate,
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
      const metadata: Record<string, unknown> = {
        compatibility_date: compatibilityDate ?? "2024-01-01",
        main_module: mainModule ?? "main.js",
      };
      if (options.compatibilityFlags && options.compatibilityFlags.length > 0) {
        metadata.compatibility_flags = options.compatibilityFlags;
      }
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
      const metadata: Record<string, unknown> = {
        compatibility_date: compatibilityDate ?? "2024-01-01",
        main_module: mainModule ?? "main.js",
      };
      if (options.compatibilityFlags && options.compatibilityFlags.length > 0) {
        metadata.compatibility_flags = options.compatibilityFlags;
      }
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

  async function resolveLatestVersion(workerName: string, signal?: AbortSignal): Promise<string> {
    const versions = await client.listVersions(workerName, signal);
    if (!versions || versions.length === 0) {
      throw err("E_PRECONDITION", "no versions available for deployment");
    }
    return versions[0].id;
  }

  async function executeDeploy(
    operation: CloudflareOperation & { kind: "deploy" },
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    try {
      // versionId is propagated from the upload_version step via
      // Cloudflare buildHooks closure capture (engine.ts).
      // Fallback to listVersions only when propagation failed or race occurred.
      const versionId = operation.versionId !== "pending"
        ? operation.versionId
        : await resolveLatestVersion(operation.workerName, signal);
      const deployment = await client.createDeployment(
        operation.workerName,
        [{ version_id: versionId, percentage: 100 }],
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
        providerRequestId: versionId,
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
  async function doStatus(releaseId: string, signal?: AbortSignal): Promise<Verification<string>> {
    if (!options.workerName) {
      throw err("E_CONFIG_INVALID", "workerName is required for status check");
    }
    const name = options.workerName;
    try {
      const deployment = await client.getDeployment(name, releaseId, signal);
      if (deployment && deployment.id === releaseId) {
        return verified<string>("deployed");
      }
    } catch {
      // deployment not found or error
    }
    return unverified("missing_payload", `deployment ${releaseId} not found`);
  }

  // ── Logs ──────────────────────────────────────────────────────────────────
  async function doLogs(
    releaseId: string,
    input: { lines: number; secretValues: readonly string[] },
    signal?: AbortSignal,
  ): Promise<Verification<string>> {
    try {
      if (!options.workerName) {
        throw err("E_CONFIG_INVALID", "workerName is required for log streaming");
      }
      const scriptName = options.workerName;

      // Check WebSocket availability
      if (typeof globalThis.WebSocket !== "function") {
        return verified<string>(
          "Live worker tail: WebSocket API not available in this runtime environment. " +
          "Cloudflare Workers log streaming requires Node.js >=22 or the 'ws' package.",
        );
      }

      // Create tail session
      const tail = await client.createTail(scriptName, signal);

      let tailDeleted = false;
      async function cleanupTail() {
        if (tailDeleted) return;
        tailDeleted = true;
        try {
          await client.deleteTail(scriptName, tail.id);
        } catch {
          // Best-effort cleanup; session will expire naturally
        }
      }

      try {
        const ws = new WebSocket(tail.url);

        const collected: TailEvent[] = [];
        const maxLines = Math.max(1, Math.min(Math.floor(input.lines), 500));

        await new Promise<void>((resolve) => {
          const sessionTimeout = setTimeout(() => {
            ws.close();
            resolve();
          }, 15_000);

          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          function resetIdleTimer() {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              ws.close();
              resolve();
            }, 10_000);
          }

          ws.onopen = () => {
            resetIdleTimer();
          };

          ws.onmessage = (event: MessageEvent) => {
            resetIdleTimer();
            try {
              const data = JSON.parse(event.data as string);
              const events: TailEvent[] = Array.isArray(data) ? data : [data];
              for (const evt of events) {
                if (evt && typeof evt === "object") {
                  collected.push(evt);
                  if (collected.length >= maxLines) {
                    ws.close();
                    resolve();
                    return;
                  }
                }
              }
            } catch {
              // Skip malformed messages
            }
          };

          ws.onerror = () => {
            // onclose fires after onerror
          };

          ws.onclose = () => {
            clearTimeout(sessionTimeout);
            if (idleTimer) clearTimeout(idleTimer);
            resolve();
          };

          if (signal) {
            if (signal.aborted) {
              ws.close();
              resolve();
              return;
            }
            signal.addEventListener("abort", () => {
              ws.close();
              resolve();
            }, { once: true });
          }
        });

        if (collected.length === 0) {
          return verified<string>(
            "[live worker tail] No log messages received. " +
            "Note: Cloudflare Tail API samples messages under high traffic — some log entries may be dropped.",
          );
        }

        // Format collected events
        const lines: string[] = [];
        for (const evt of collected) {
          const ts = evt.eventTimestamp
            ? new Date(evt.eventTimestamp).toISOString()
            : new Date().toISOString();
          const outcome = evt.outcome ?? "unknown";
          lines.push(`[${ts}] [${outcome}] ${evt.scriptName ?? scriptName}`);
          if (evt.logs) {
            for (const log of evt.logs) {
              const level = log.level ?? "log";
              const rawMsg = log.message;
              const msg = Array.isArray(rawMsg)
                ? rawMsg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")
                : String(rawMsg ?? "");
              lines.push(`  [${level}] ${msg}`);
            }
          }
          if (evt.exceptions) {
            for (const ex of evt.exceptions) {
              lines.push(`  [exception] ${ex.name ?? "Error"}: ${ex.message ?? ""}`);
            }
          }
        }

        const text = lines.join("\n");
        const sensitiveValues = [...input.secretValues];
        const redacted = redact(text, [], sensitiveValues);
        const capped = redacted.length > 50000
          ? redacted.slice(0, 50000) + "\n...truncated"
          : redacted;

        return verified<string>(capped);
      } finally {
        await cleanupTail();
      }
    } catch (e: unknown) {
      if (isShipError(e)) {
        return verificationError<string>(e, "Cloudflare logs verification failed");
      }
      return unverified<string>("transport", "Cloudflare logs verification failed: " + (e instanceof Error ? e.message : String(e)), true);
    }
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
        "logs",
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
