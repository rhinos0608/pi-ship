/** PostgreSQL apply wrapper — delegates to dialect-aware generic kernel. */
import { err, isShipError } from "../core/errors.js";
import type { ApprovalRegistry } from "../core/approval.js";
import type { Environment } from "../core/types.js";
import type { DatabaseClientFactory, DatabaseClient, DatabaseQueryResult } from "./client.js";
import type { DatabasePayloadRegistry } from "./payload.js";
import { fingerprintTarget } from "./plan.js";
import { classifySQL } from "./classifier.js";
import { applyDialectPlan, type DialectMutationExecutor, type DialectError, type ApplyDatabasePlanResult } from "./dialect/apply.js";
import type { DialectApplyInput } from "./dialect/contracts.js";

// Re-export type for backward compatibility
export type { ApplyDatabasePlanResult };

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

// ── PostgreSQL executor ──

const postgresExecutor: DialectMutationExecutor = {
  paramBinding: 'positional-prefix',
  classifyError(cause: unknown): DialectError {
    if (isShipError(cause)) {
      const e = cause as { code: string; retryable: boolean };
      if (e.code === "E_CANCELLED") {
        return { code: e.code, shipCode: "E_CANCELLED", retryable: true, definitive: true };
      }
      return { code: e.code, shipCode: e.code, retryable: e.retryable, definitive: false };
    }

    if (cause instanceof Error && typeof (cause as unknown as Record<string, unknown>).code === "string") {
      const raw = (cause as unknown as Record<string, unknown>).code as string;
      const upper = raw.toUpperCase();

      if (upper === "ERR_ABORTED") {
        return { code: raw, shipCode: "E_CANCELLED", retryable: false, definitive: true };
      }

      if (upper === "28P01" || upper === "28000") {
        return { code: raw, shipCode: "E_AUTH_MISSING", retryable: false, definitive: true };
      }

      if (upper === "57014") {
        return { code: raw, shipCode: "E_CANCELLED", retryable: true, definitive: true };
      }

      if (upper.startsWith("08") || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(upper)) {
        return { code: raw, shipCode: "E_PROVIDER", retryable: true, definitive: false };
      }

      if (/^[0-9A-Z]{5}$/.test(upper)) {
        return { code: raw, shipCode: "E_PROVIDER", retryable: false, definitive: true };
      }

      return { code: raw, shipCode: "E_PROVIDER", retryable: false, definitive: false };
    }

    return { code: "E_PROVIDER", shipCode: "E_PROVIDER", retryable: false, definitive: false };
  },

  async begin(client: DatabaseClient): Promise<void> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout = '30000ms'");
      await client.query("SET LOCAL lock_timeout = '5000ms'");
    } catch (e) {
      // BEGIN already happened — rollback before rethrowing
      try { await client.query("ROLLBACK"); } catch { /* best-effort */ }
      throw e;
    }
  },

  async execute(client: DatabaseClient, sql: string, params: readonly unknown[]): Promise<DatabaseQueryResult> {
    return client.query(sql, params);
  },

  async commit(client: DatabaseClient): Promise<void> {
    await client.query("COMMIT");
  },

  async rollback(client: DatabaseClient): Promise<boolean> {
    try { await client.query("ROLLBACK"); return true; }
    catch { return false; }
  },
};

/**
 * Apply a database plan to a PostgreSQL target.
 *
 * Compatibility wrapper over the dialect-generic kernel.
 * Behavior is byte-for-byte identical to the pre-refactor implementation.
 */
export async function applyDatabasePlan(options: ApplyDatabasePlanOptions): Promise<ApplyDatabasePlanResult> {
  const { cwd, planId, planDigest, environment, databaseUrl, providerFingerprint, manifestFingerprint, productionFlag, registry, payloads, clientFactory, signal } = options;

  const input: DialectApplyInput = {
    cwd,
    planId,
    planDigest,
    environment,
    providerFingerprint,
    manifestFingerprint,
    productionFlag,
    registry,
    payloads,
    signal,
  };

  const targetFingerprint = fingerprintTarget(databaseUrl);

  return applyDialectPlan(
    input,
    targetFingerprint,
    classifySQL,
    postgresExecutor,
    async () => clientFactory(databaseUrl),
  );
}
