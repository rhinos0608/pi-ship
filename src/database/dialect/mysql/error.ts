/** MySQL/MariaDB error mapping — reads only code/errno, never parses message. */
import { err, isShipError } from "../../../core/errors.js";

/** MySQL error codes that indicate auth failure. */
const AUTH_CODES = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR"]);

/** Node.js errno values indicating connection-level failure (retryable). */
const CONNECTION_ERRNOS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"]);

/**
 * Map a MySQL driver error to a ShipError.
 * - Already a ShipError: rethrow unchanged
 * - ER_ACCESS_DENIED_ERROR / ER_DBACCESS_DENIED_ERROR → E_AUTH_MISSING
 * - ECONNREFUSED / ECONNRESET / ETIMEDOUT / ENOTFOUND → E_PROVIDER (retryable)
 * - ERR_ABORTED → E_CANCELLED
 * - Other → E_PROVIDER (non-retryable)
 * Only reads `.code` and `.errno` properties. Never parses message text.
 */
export function mapMySQLError(cause: unknown): never {
  if (isShipError(cause)) throw cause;

  if (cause instanceof Error) {
    const errRecord = cause as unknown as Record<string, unknown>;

    if (typeof errRecord.code === "string") {
      const code = errRecord.code as string;
      const upper = code.toUpperCase();

      // AbortSignal
      if (upper === "ERR_ABORTED") {
        throw err("E_CANCELLED", "database operation cancelled", false);
      }

      // Auth failures — match on MySQL code string
      if (AUTH_CODES.has(code)) {
        throw err("E_AUTH_MISSING", "database authentication failed", false);
      }

      // Connection-level failures — match on Node.js errno values
      if (CONNECTION_ERRNOS.has(upper)) {
        throw err("E_PROVIDER", "database connection failed", true);
      }
    }

    // Even without a code, if there's an errno, treat as non-retryable provider
    if (typeof errRecord.errno === "number") {
      throw err("E_PROVIDER", "database operation failed", false);
    }
  }

  // Everything else — safe generic provider error
  throw err("E_PROVIDER", "database operation failed", false);
}
