import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonicalize } from "../../core/canonicalize.js";
import { err } from "../../core/errors.js";
import { isCloudflareManifest, type CloudflareManifest } from "./manifest.js";

const Strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1 });

// ── Operation base ──────────────────────────────────────────────────────────
const Base = {
  operationId: NonEmpty,
  provider: Type.Literal("cloudflare"),
  targetFingerprint: NonEmpty,
  requestFingerprint: NonEmpty,
  expectedStateFingerprint: NonEmpty,
  dependsOn: Type.Array(Type.String()),
};

export const CloudflareOperationSchema = Type.Union([
  Type.Object({ ...Base, kind: Type.Literal("ensure_worker"), workerName: NonEmpty, accountId: NonEmpty, source: Type.Optional(Type.String()) }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("set_secrets"), workerName: NonEmpty, secretNames: Type.Array(NonEmpty) }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("upload_version"), workerName: NonEmpty, accountId: NonEmpty, source: Type.Optional(Type.String()) }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("deploy"), workerName: NonEmpty, versionId: NonEmpty }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("rollback"), workerName: NonEmpty, targetVersionId: NonEmpty }, Strict),
]);

export const CloudflarePlanSchema = Type.Object({
  version: Type.Literal(1),
  planId: NonEmpty,
  planDigest: NonEmpty,
  provider: Type.Literal("cloudflare"),
  environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
  intent: Type.Union([Type.Literal("deploy"), Type.Literal("rollback")]),
  identity: Type.Object({
    account: Type.Object({ kind: Type.Literal("user"), id: NonEmpty }, Strict),
    worker: Type.Object({ name: NonEmpty }, Strict),
  }, Strict),
  accountFingerprint: NonEmpty,
  targetFingerprint: NonEmpty,
  secretNames: Type.Array(NonEmpty),
  operations: Type.Array(CloudflareOperationSchema),
  createdAt: NonEmpty,
}, Strict);

export type CloudflareOperation = Static<typeof CloudflareOperationSchema>;
export type CloudflarePlan = Omit<Static<typeof CloudflarePlanSchema>, "operations"> & { operations: CloudflareOperation[] };

// ── Helpers ─────────────────────────────────────────────────────────────────
export function isCloudflarePlan(value: unknown): value is CloudflarePlan {
  return Value.Check(CloudflarePlanSchema, value);
}

export function computeCloudflareFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function computeCloudflareRequestFingerprint(pick: {
  provider: "cloudflare";
  kind: string;
  targetFingerprint: string;
  requestPayload: unknown;
}): string {
  return computeCloudflareFingerprint(pick);
}

export function computeCloudflareOperationId(pick: {
  provider: "cloudflare";
  kind: string;
  targetFingerprint: string;
  requestFingerprint: string;
}): string {
  return computeCloudflareFingerprint(pick);
}

export function computeCloudflarePlanDigest(plan: unknown): string {
  const input = plan as Record<string, unknown>;
  const { planDigest: _, ...rest } = input;
  return computeCloudflareFingerprint(rest);
}

// ── Operation builder ───────────────────────────────────────────────────────
export interface CloudflareBuildOptions {
  workerName: string;
  accountId: string;
  secretNames?: string[];
  versionId?: string;
  targetVersionId?: string;
  source?: string;
}

export function buildCloudflareOperations(
  intent: "deploy" | "rollback",
  _environment: "preview" | "production",
  options: CloudflareBuildOptions,
): CloudflareOperation[] {
  const targetFingerprint = computeCloudflareFingerprint({
    worker: options.workerName,
    accountId: options.accountId,
  });

  const make = (
    kind: CloudflareOperation["kind"],
    payload: Record<string, unknown>,
    dependsOn?: string[],
  ): CloudflareOperation => {
    const requestFingerprint = computeCloudflareRequestFingerprint({
      provider: "cloudflare",
      kind,
      targetFingerprint,
      requestPayload: payload,
    });
    const operationId = computeCloudflareOperationId({
      provider: "cloudflare",
      kind,
      targetFingerprint,
      requestFingerprint,
    });
    return {
      ...payload,
      operationId,
      provider: "cloudflare",
      kind,
      targetFingerprint,
      requestFingerprint,
      dependsOn: dependsOn ?? [],
      expectedStateFingerprint: computeCloudflareFingerprint({
        targetFingerprint,
        kind,
        requestFingerprint,
      }),
    } as CloudflareOperation;
  };

  if (intent === "rollback") {
    if (!options.targetVersionId) {
      throw err("E_CONFIG_INVALID", "rollback requires targetVersionId");
    }
    return [make("rollback", { workerName: options.workerName, targetVersionId: options.targetVersionId })];
  }

  const ensureWorker = make("ensure_worker", {
    workerName: options.workerName,
    accountId: options.accountId,
    ...(options.source ? { source: options.source } : {}),
  });
  const uploadVersion = make("upload_version", {
    workerName: options.workerName,
    accountId: options.accountId,
    ...(options.source ? { source: options.source } : {}),
  }, [ensureWorker.operationId]);
  const setSecrets = make("set_secrets", { workerName: options.workerName, secretNames: options.secretNames ?? [] }, [uploadVersion.operationId]);
  const deploy = make("deploy", { workerName: options.workerName, versionId: options.versionId ?? "pending" }, [setSecrets.operationId]);

  return [ensureWorker, uploadVersion, setSecrets, deploy];
}
