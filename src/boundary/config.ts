import { err } from "../core/errors.js";
import type { BoundaryConfig, SecurityMode } from "./types.js";

const VALID_MODES: ReadonlySet<string> = new Set(["managed", "warn", "exclusive"]);

export const DEFAULT_BOUNDARY_CONFIG: BoundaryConfig = { mode: "managed" };

export function parseSecurityMode(value: unknown): SecurityMode {
  if (typeof value !== "string" || !VALID_MODES.has(value)) {
    throw err("E_CONFIG_INVALID", "databaseAccess.mode must be managed, warn, or exclusive");
  }
  return value as SecurityMode;
}

export function loadBoundaryConfig(manifest: unknown): BoundaryConfig {
  if (!manifest || typeof manifest !== "object") return DEFAULT_BOUNDARY_CONFIG;
  const record = manifest as Record<string, unknown>;
  const da = record.databaseAccess;
  if (!da || typeof da !== "object") return DEFAULT_BOUNDARY_CONFIG;
  const daRecord = da as Record<string, unknown>;
  return { mode: parseSecurityMode(daRecord.mode) };
}
