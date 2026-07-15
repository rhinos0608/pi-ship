import { isShipError } from "../../core/errors.js";
import { redact } from "../../core/redact.js";
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
import {
  buildVercelOperations,
  type VercelOperation,
} from "./plan.js";
import type { VercelReleaseStatus } from "./engine.js";
import type { VercelClient } from "./client.js";
import type {
  Project,
  Deployment,
  EnvVarInput,
  CreateDeploymentRequest,
  DeploymentFile,
  BuildEvent,
  RuntimeLogEntry,
} from "./types.js";
import { enumerateSource, uploadSourceFiles } from "./source.js";

// ── Vercel-specific types ──────────────────────────────────────────────────────

export type VercelRuntime = AppOperationRuntime<VercelSnapshot, VercelOperation, string, string, VercelReleaseStatus>;

export interface VercelPlanInput {
  environment: "preview" | "production";
  projectName: string;
  teamId?: string;
  targetDeploymentId?: string;
  source?: import("./plan.js").LocalSourceRef;
  secretNames?: readonly string[];
  observedProjectId?: string;
}

export interface VercelExecutionInput {
  secretValues: Readonly<Record<string, string>>;
}

export type AppOperationRuntime<TSnapshot, TOperation, TStatus, TLogs, TReleaseStatus extends string = string> = OperationRuntime<
  TSnapshot,
  TOperation,
  VercelPlanInput,
  VercelExecutionInput,
  TStatus,
  TLogs,
  TReleaseStatus
> & {
  readonly descriptor: {
    domain: "app";
    provider: "vercel";
    capabilities: readonly ["discover", "write_secrets", "deploy", "status", "logs", "rollback"];
  };
};

/** Discovered project snapshot for planning. */
export interface VercelSnapshot {
  account: { kind: "team" | "user"; id: string };
  project: Project | null;
  environment: "preview" | "production";
}

// ── Error certainty helpers ─────────────────────────────────────────────────────

/**
 * Extract HTTP status from a ShipError's details.
 */
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

function releaseStatus(deployment: Deployment): VercelReleaseStatus {
  switch (deployment.readyState) {
    case "QUEUED": return "queued";
    case "INITIALIZING": return "initializing";
    case "BUILDING": return "building";
    case "READY": return "ready";
    case "ERROR": return "error";
    case "CANCELED": return "canceled";
    case "BLOCKED": return "blocked";
  }
}

/**
 * Classify an error from a mutation (create / deploy / rollback POST).
 * - 400 series before apply (auth, precondition, 404/409 project conflict) → failed not_applied
 * - 429 / 5xx / transport → ambiguous
 * - unknown → ambiguous
 */
function mutationResult(e: unknown, safeMessage: string): OperationResult<VercelReleaseStatus> {
  if (isShipError(e)) {
    const status = httpStatus(e);
    if (e.code === "E_AUTH_MISSING" || e.code === "E_PRECONDITION") {
      return { status: "failed", certainty: "not_applied", code: e.code, safeMessage, retryable: e.retryable };
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
      return { status: "failed", certainty: "not_applied", code: e.code, safeMessage, retryable: e.retryable };
    }
    // 429 → rate_limited, 5xx or transport → transport
    if (status === 429) {
      return { status: "ambiguous", reason: "rate_limited", safeMessage };
    }
    return { status: "ambiguous", reason: "transport", safeMessage };
  }
  return { status: "ambiguous", reason: "transport", safeMessage };
}

/**
 * Classify an error from a read/GET (find, getDeployment).
 * Exhausted errors before mutation → can be failed not_applied.
 */
function readResult(e: unknown, safeMessage: string): OperationResult<VercelReleaseStatus> {
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

function providerFailed(code: string, safeMessage: string, retryable = false): OperationResult<VercelReleaseStatus> {
  return { status: "failed", certainty: "not_applied", code, safeMessage, retryable };
}

function ambiguousOp(reason: UnverifiedReason, safeMessage: string): OperationResult<VercelReleaseStatus> {
  return { status: "ambiguous", reason, safeMessage };
}

function unverifiedRecon(
  reason: UnverifiedReason,
  safeMessage: string,
  retryable = false,
): Verification<ReconciliationState<VercelReleaseStatus>> {
  return unverified<ReconciliationState<VercelReleaseStatus>>(reason, safeMessage, retryable);
}

// ── Factory ────────────────────────────────────────────────────────────────────

export interface VercelRuntimeOptions {
  client: VercelClient;
  cwd: string;
  teamId?: string;
}

/**
 * Create a Vercel AppOperationRuntime with injectable client and cwd.
 */
export function createVercelRuntime(
  options: VercelRuntimeOptions,
): VercelRuntime {
  const { client, cwd, teamId } = options;

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function doCheckAuth(signal?: AbortSignal): Promise<Verification<AccountRef>> {
    try {
      const resp = await client.checkAuth(signal);
      const user = resp.user;
      if (teamId) {
        try {
          await client.listProjects(undefined, signal);
        } catch (e: unknown) {
          return verificationError<AccountRef>(e, "Vercel team access verification failed");
        }
        return verified<AccountRef>({ kind: "team", id: teamId });
      }
      return verified<AccountRef>({ kind: "user", id: user.id });
    } catch (e: unknown) {
      return verificationError<AccountRef>(e, "Vercel auth check failed");
    }
  }

  // ── Discover ──────────────────────────────────────────────────────────────
  async function doDiscover(
    target: { projectName: string; teamId?: string; environment: "preview" | "production" },
    signal?: AbortSignal,
  ): Promise<Verification<VercelSnapshot>> {
    try {
      if (target.teamId !== teamId) {
        return unverified<VercelSnapshot>("forbidden", "target teamId does not match configured team", false);
      }
      const auth = await doCheckAuth(signal);
      if (auth.status === "unverified") {
        return unverified<VercelSnapshot>(auth.reason, auth.safeMessage, auth.retryable);
      }
      const project = await client.findProject(target.projectName, signal);
      return verified<VercelSnapshot>({ account: auth.value, project, environment: target.environment });
    } catch (e: unknown) {
      return verificationError<VercelSnapshot>(e, "Vercel project discovery failed");
    }
  }

  // ── Plan ──────────────────────────────────────────────────────────────────
  async function doPlan(
    intent: "deploy" | "rollback",
    input: VercelPlanInput,
    snapshot: VercelSnapshot,
  ): Promise<Verification<readonly VercelOperation[]>> {
    try {
      if (intent === "rollback" && input.environment !== "production") {
        return unverified<readonly VercelOperation[]>("conflict", "rollback is only supported in production");
      }
      if (intent === "rollback" && (!input.targetDeploymentId || !snapshot.project)) {
        return unverified<readonly VercelOperation[]>("missing_payload", "rollback requires target deployment and existing project");
      }
      if (intent === "deploy" && !input.source) {
        return unverified<readonly VercelOperation[]>("missing_payload", "deploy plan requires source reference");
      }
      const operations = buildVercelOperations(intent, input.environment, {
        projectName: input.projectName,
        secretNames: (input.secretNames ?? []) as string[],
        source: input.source,
        observedProjectId: snapshot.project?.id ?? input.observedProjectId,
        targetDeploymentId: intent === "rollback" ? input.targetDeploymentId : undefined,
      });
      return verified<readonly VercelOperation[]>(operations);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return unverified<readonly VercelOperation[]>("malformed", msg, false);
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  async function doExecute(
    operation: VercelOperation,
    input: VercelExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult<VercelReleaseStatus>> {
    try {
      switch (operation.kind) {
        case "ensure_project":
          return executeEnsureProject(operation, input, signal);
        case "upsert_secrets":
          return executeUpsertSecrets(operation, input, signal);
        case "deploy":
          return executeDeploy(operation, input, signal);
        case "rollback":
          return executeRollback(operation, signal);
      }
    } catch (e: unknown) {
      if (isShipError(e)) return providerFailed(e.code, e.message, e.retryable);
      return ambiguousOp("transport", "unexpected execution error");
    }
  }

  async function executeEnsureProject(
    operation: VercelOperation & { kind: "ensure_project" },
    _input: VercelExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult<VercelReleaseStatus>> {
    // Finding existing project is a GET/read — errors can be failed not_applied
    let existing: Project | null;
    try {
      existing = await client.findProject(operation.projectName, signal);
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

    // Create project is POST mutation — transport/429/5xx → ambiguous
    try {
      const created = await client.createProject({ name: operation.projectName }, signal);
      if (created.name !== operation.projectName) {
        return { status: "ambiguous", reason: "conflict", safeMessage: `created project name "${created.name}" does not match "${operation.projectName}"`, resourceRef: created.id };
      }
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

  async function executeUpsertSecrets(
    operation: VercelOperation & { kind: "upsert_secrets" },
    input: VercelExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult<VercelReleaseStatus>> {
    for (let i = 0; i < operation.secretNames.length; i++) {
      const secretName = operation.secretNames[i];
      const value = input.secretValues[secretName];
      if (value === undefined) {
        return providerFailed("E_PRECONDITION", `missing required secret value: "${secretName}"`);
      }

      const envInput: EnvVarInput = {
        key: secretName,
        value,
        type: "sensitive",
        target: operation.environment === "production" ? ["production"] : ["preview"],
      };

      try {
        const response = await client.upsertEnv(operation.projectName, envInput, signal);
        // 2xx response with failed entries means write-only reconciliation cannot prove state
        if (response.failed && response.failed.length > 0) {
          if (i > 0) return ambiguousOp("conflict", "partial secret upsert has failed entries; state ambiguous");
          return ambiguousOp("conflict", "secret upsert has failed entries; state ambiguous");
        }
      } catch (e: unknown) {
        // After any prior secret succeeded, error is ambiguous partial
        if (i > 0) return ambiguousOp("transport", "partial secret upsert failed; state ambiguous");
        const msg = e instanceof Error ? e.message : String(e);
        return mutationResult(e, msg);
      }
    }

    return {
      status: "succeeded",
      observedStateFingerprint: operation.expectedStateFingerprint,
      resourceRef: operation.operationId,
    };
  }

  async function executeDeploy(
    operation: VercelOperation & { kind: "deploy" },
    _input: VercelExecutionInput,
    signal?: AbortSignal,
  ): Promise<OperationResult<VercelReleaseStatus>> {
    const sourceRef = operation.source;
    if (!sourceRef) {
      return providerFailed("E_PRECONDITION", "deploy operation missing source reference");
    }

    // Enumerate current source — read, errors fail with source identity
    let currentSnapshot: Awaited<ReturnType<typeof enumerateSource>>;
    try {
      currentSnapshot = await enumerateSource(cwd, sourceRef.rootDirectory);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return providerFailed(
        isShipError(e) ? e.code : "E_PLAN_STALE",
        msg,
        isShipError(e) ? e.retryable : false,
      );
    }

    // Verify fingerprint, fileCount, totalBytes
    if (currentSnapshot.fingerprint !== sourceRef.fingerprint) {
      return providerFailed("E_PLAN_STALE", "source fingerprint mismatch; re-plan required");
    }
    if (currentSnapshot.fileCount !== sourceRef.fileCount) {
      return providerFailed("E_PLAN_STALE", `source file count mismatch: ${currentSnapshot.fileCount} !== ${sourceRef.fileCount}`);
    }
    if (currentSnapshot.totalBytes !== sourceRef.totalBytes) {
      return providerFailed("E_PLAN_STALE", `source total bytes mismatch: ${currentSnapshot.totalBytes} !== ${sourceRef.totalBytes}`);
    }

    // Upload files — errors occur before deployment; no deployment created
    try {
      await uploadSourceFiles(
        currentSnapshot.files,
        cwd,
        sourceRef.rootDirectory,
        { uploadFile: async (sha1, content, sig) => { await client.uploadFile(sha1, content, sig); } },
        { signal },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = isShipError(e) ? e.code : "E_PROVIDER";
      return providerFailed(code, msg);
    }

    // Build deployment file references
    const files: DeploymentFile[] = currentSnapshot.files.map((f) => ({
      file: f.path,
      sha: f.sha1,
      size: f.size,
    }));

    // Create deployment — POST mutation
    const deployBody: CreateDeploymentRequest = {
      name: operation.projectName,
      project: operation.projectName,
      files,
      target: operation.environment === "production" ? "production" : undefined,
      meta: { piShipOperationId: operation.operationId },
    };

    let deployment: Deployment;
    try {
      deployment = await client.createDeployment(deployBody, signal);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }

    // Validate deployment response
    if (!deployment.id || !deployment.name) {
      return providerFailed("E_PROVIDER", "deployment response missing required fields");
    }
    if (deployment.name !== operation.projectName) {
      return { status: "ambiguous", reason: "conflict", safeMessage: `deployment name "${deployment.name}" does not match project "${operation.projectName}"`, resourceRef: deployment.id };
    }
    if (operation.observedProjectId && deployment.projectId !== operation.observedProjectId) {
      return { status: "ambiguous", reason: "conflict", safeMessage: "deployment project ID does not match approved project", resourceRef: deployment.id };
    }
    if (deployment.meta?.piShipOperationId && deployment.meta.piShipOperationId !== operation.operationId) {
      return { status: "ambiguous", reason: "conflict", safeMessage: "deployment meta operation ID does not match", resourceRef: deployment.id };
    }

    return {
      status: "succeeded",
      observedStateFingerprint: operation.expectedStateFingerprint,
      resourceRef: deployment.id,
      providerRequestId: deployment.id,
      releaseStatus: releaseStatus(deployment),
      ...(deployment.url ? { releaseUrl: deployment.url } : {}),
    };
  }

  async function executeRollback(
    operation: VercelOperation & { kind: "rollback" },
    signal?: AbortSignal,
  ): Promise<OperationResult<VercelReleaseStatus>> {
    try {
      await client.rollback(operation.projectId, operation.targetDeploymentId, undefined, signal);
      return {
        status: "succeeded",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: operation.targetDeploymentId,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return mutationResult(e, msg);
    }
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────
  async function doReconcile(
    operation: VercelOperation,
    resourceRef?: string,
    signal?: AbortSignal,
  ): Promise<Verification<ReconciliationState<VercelReleaseStatus>>> {
    try {
      switch (operation.kind) {
        case "ensure_project":
          return await reconcileProject(operation, resourceRef, signal);
        case "upsert_secrets":
          return unverifiedRecon("missing_payload", "secrets are write-only; cannot reconcile");
        case "deploy":
          return await reconcileDeploy(operation, resourceRef, signal);
        case "rollback":
          return unverifiedRecon("missing_payload", "rollback is write-only; cannot reconcile");
      }
    } catch (e: unknown) {
      if (isShipError(e)) return unverifiedRecon("transport", e.message, e.retryable);
      return unverifiedRecon("transport", "reconciliation failed", true);
    }
  }

  async function reconcileProject(
    operation: VercelOperation & { kind: "ensure_project" },
    resourceRef?: string,
    signal?: AbortSignal,
  ): Promise<Verification<ReconciliationState<VercelReleaseStatus>>> {
    // Nonempty resourceRef from an ambiguous createProject response proves a resource
    // was created but identity did not match. Return verified conflict immediately
    // without an API retry.
    if (resourceRef) {
      return verified<ReconciliationState<VercelReleaseStatus>>({ outcome: "conflict", observedStateFingerprint: resourceRef });
    }
    try {
      const project = await client.findProject(operation.projectName, signal);
      if (!project) {
        return verified<ReconciliationState<VercelReleaseStatus>>({ outcome: "not_applied", observedStateFingerprint: "absent" });
      }
      if (project.name !== operation.projectName) {
        return verified<ReconciliationState<VercelReleaseStatus>>({ outcome: "conflict", observedStateFingerprint: project.id });
      }
      return verified<ReconciliationState<VercelReleaseStatus>>({
        outcome: "matches_expected",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: project.id,
      });
    } catch (e: unknown) {
      // Only a successful empty project list proves absence.
      return verificationError<ReconciliationState<VercelReleaseStatus>>(e, "Vercel project reconciliation failed");
    }
  }

  async function reconcileDeploy(
    operation: VercelOperation & { kind: "deploy" },
    resourceRef?: string,
    signal?: AbortSignal,
  ): Promise<Verification<ReconciliationState<VercelReleaseStatus>>> {
    if (!resourceRef) {
      return unverifiedRecon("missing_payload", "no resource ref for deployment reconciliation");
    }

    let deployment: Deployment;
    try {
      deployment = await client.getDeployment(resourceRef, signal);
    } catch (e: unknown) {
      if (isShipError(e)) {
        const status = httpStatus(e);
        // Only 404 from client means verified not_applied
        if (status === 404) {
          return verified<ReconciliationState<VercelReleaseStatus>>({ outcome: "not_applied", observedStateFingerprint: "absent" });
        }
        // 429/5xx/transport → unverified, never not_applied
        return unverifiedRecon("transport", e.message, e.retryable);
      }
      return unverifiedRecon("transport", "reconciliation failed", true);
    }

    if (
      deployment.meta?.piShipOperationId !== operation.operationId ||
      deployment.name !== operation.projectName ||
      (operation.observedProjectId !== undefined && deployment.projectId !== operation.observedProjectId)
    ) {
      return verified<ReconciliationState<VercelReleaseStatus>>({ outcome: "conflict", observedStateFingerprint: deployment.id });
    }

    const deploymentState = releaseStatus(deployment);
    const usableStates: ReadonlySet<VercelReleaseStatus> = new Set(["ready", "queued", "building", "initializing"]);
    const unusableStates: ReadonlySet<VercelReleaseStatus> = new Set(["error", "canceled", "blocked"]);

    if (usableStates.has(deploymentState)) {
      return verified<ReconciliationState<VercelReleaseStatus>>({
        outcome: "matches_expected",
        observedStateFingerprint: operation.expectedStateFingerprint,
        resourceRef: deployment.id,
        releaseStatus: deploymentState,
        ...(deployment.url ? { releaseUrl: deployment.url } : {}),
      });
    }

    if (unusableStates.has(deploymentState)) {
      return verified<ReconciliationState<VercelReleaseStatus>>({ outcome: "conflict", observedStateFingerprint: deployment.id });
    }

    return unverifiedRecon("malformed", "unrecognised deployment state");
  }

  // ── Status ────────────────────────────────────────────────────────────────
  async function doStatus(releaseId: string, signal?: AbortSignal): Promise<Verification<string>> {
    try {
      const deployment = await client.getDeployment(releaseId, signal);
      return verified<string>(releaseStatus(deployment));
    } catch (e: unknown) {
      if (isShipError(e)) return unverified<string>("transport", e.message, e.retryable);
      return unverified<string>("transport", "failed to get deployment status", true);
    }
  }

  // ── Logs ──────────────────────────────────────────────────────────────────
  async function doLogs(
    releaseId: string,
    input: { lines: number; secretValues: readonly string[] },
    signal?: AbortSignal,
  ): Promise<Verification<string>> {
    try {
      // Get deployment to obtain projectId
      const deployment = await client.getDeployment(releaseId, signal);
      const projectId = deployment.projectId;

      const [buildResult, runtimeResult] = await Promise.allSettled([
        client.getBuildEvents(releaseId, signal),
        client.getRuntimeLogs(projectId, releaseId, signal),
      ]);
      if (buildResult.status === "rejected") {
        return verificationError<string>(buildResult.reason, "Vercel build logs verification failed");
      }
      if (runtimeResult.status === "rejected") {
        return verificationError<string>(runtimeResult.reason, "Vercel runtime logs verification failed");
      }

      const buildEvents: BuildEvent[] = buildResult.value;
      const runtimeEntries: RuntimeLogEntry[] = runtimeResult.value;

      // Combine all entries with timestamps
      interface TimestampedEntry {
        ts: number;
        text: string;
      }

      const combined: TimestampedEntry[] = [
        ...buildEvents.map((e) => ({
          ts: e.created,
          text: `[build] [${e.type}] ${e.payload?.text ?? ""}`,
        })),
        ...runtimeEntries.map((e) => ({
          ts: e.timestampInMs,
          text: `[${e.level}] ${e.message}`,
        })),
      ].filter((entry) => entry.text.length > 0);

      // Sort by timestamp ascending, take newest bounded 1..500
      combined.sort((a, b) => a.ts - b.ts);
      const clamped = Math.max(1, Math.min(Math.floor(input.lines), 500));
      const bounded = combined.slice(Math.max(0, combined.length - clamped));

      // Format and redact
      const text = bounded.map((e) => e.text).join("\n");
      const sensitiveValues = [...input.secretValues];
      const redacted = redact(text, [], sensitiveValues);

      // Cap safe output at 50000 chars
      const capped = redacted.length > 50000 ? redacted.slice(0, 50000) + "\n...truncated" : redacted;

      return verified<string>(capped);
    } catch (e: unknown) {
      return verificationError<string>(e, "Vercel logs verification failed");
    }
  }

  // ── Assemble runtime ──────────────────────────────────────────────────────
  return {
    descriptor: {
      domain: "app",
      provider: "vercel",
      capabilities: [
        "discover",
        "write_secrets",
        "deploy",
        "status",
        "logs",
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
