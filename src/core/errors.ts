export type ShipErrorCode =
  | "E_CONFIG_INVALID"
  | "E_AUTH_MISSING"
  | "E_PRECONDITION"
  | "E_PLAN_NOT_FOUND"
  | "E_PLAN_STALE"
  | "E_DIGEST_MISMATCH"
  | "E_APPROVAL_REQUIRED"
  | "E_APPROVAL_DENIED"
  | "E_PROVIDER"
  | "E_CANCELLED"
  | "E_PHASE_UNSUPPORTED"
  | "E_STATE_CONFLICT";

export interface ShipError extends Error {
  code: ShipErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function err(
  code: ShipErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): ShipError {
  const error = new Error(message) as ShipError;
  error.code = code;
  error.retryable = retryable;
  error.details = details;
  return error;
}

export function isShipError(value: unknown): value is ShipError {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    typeof v.retryable === "boolean"
  );
}
