/** Database client interfaces and default pg.Client factory. */
import pg from "pg";
import { err, isShipError } from "../core/errors.js";

export interface DatabaseField {
  name: string;
  dataTypeID: number;
}

export interface DatabaseQueryResult {
  fields: DatabaseField[];
  rows: Record<string, unknown>[];
  rowCount: number | null;
  command: string;
}

export interface DatabaseClient {
  connect(): Promise<void>;
  query(text: string, params?: readonly unknown[]): Promise<DatabaseQueryResult>;
  end(): Promise<void>;
}

export type DatabaseClientFactory = (connectionString: string) => DatabaseClient;

/**
 * Map a pg Error (via its `.code` SQLSTATE or Node errno) to a safe ShipError.
 * - Already a ShipError (isShipError): rethrow unchanged
 * - 28P01/28000 → E_AUTH_MISSING
 * - 57014 → E_CANCELLED
 * - SQLSTATE 08 or Node errno (ECONNREFUSED/ECONNRESET/ETIMEDOUT/ENOTFOUND) → E_PROVIDER (retryable)
 * - Other → E_PROVIDER (non-retryable)
 * Only reads `.code` property. Never parses message text.
 * All messages are safe generic — no raw error text, SQL, params, URL, or rows leaked.
 */
export function mapSQLError(cause: unknown): never {
  // Already a ShipError — rethrow unchanged
  if (isShipError(cause)) throw cause;

  if (cause instanceof Error && typeof (cause as unknown as Record<string, unknown>).code === "string") {
    const code = (cause as unknown as Record<string, unknown>).code as string;
    const upper = code.toUpperCase();

    // AbortSignal
    if (upper === "ERR_ABORTED") {
      throw err("E_CANCELLED", "database operation cancelled", false);
    }

    // Auth failures
    if (upper === "28P01" || upper === "28000") {
      throw err("E_AUTH_MISSING", "database authentication failed", false);
    }

    // Cancelled/terminated by operator
    if (upper === "57014") {
      throw err("E_CANCELLED", "database query cancelled", true);
    }

    // Connection / transport errors (SQLSTATE class 08 or Node errno)
    if (
      upper.startsWith("08") ||
      upper === "ECONNREFUSED" ||
      upper === "ECONNRESET" ||
      upper === "ETIMEDOUT" ||
      upper === "ENOTFOUND"
    ) {
      throw err("E_PROVIDER", "database connection failed", true);
    }
  }

  // Everything else — safe generic provider error
  throw err("E_PROVIDER", "database operation failed", false);
}

/** Check AbortSignal and throw E_CANCELLED if aborted. */
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw err("E_CANCELLED", "database operation cancelled", false);
  }
}

/** Default factory wrapping a fresh pg.Client per invocation. No pooling, no cache. */
export function createDefaultClientFactory(): DatabaseClientFactory {
  return (connectionString: string): DatabaseClient => {
    const raw = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
    const adapter: DatabaseClient = {
      async connect(): Promise<void> { await raw.connect(); },
      async query(text: string, params?: readonly unknown[]): Promise<DatabaseQueryResult> {
        const result = await raw.query(text, params as unknown[] | undefined);
        return {
          fields: (result.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
          rows: result.rows ?? [],
          rowCount: result.rowCount ?? null,
          command: result.command,
        };
      },
      async end(): Promise<void> {
        try { await raw.end(); } catch { /* best-effort */ }
      },
    };
    return adapter;
  };
}
