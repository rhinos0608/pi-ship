import { err } from "../core/errors.js";
import type { Environment } from "../core/types.js";
import type { CredentialSource } from "../deployment/credentials.js";

const databaseEnvironments = new Set<Environment>(["development", "preview", "production"]);

/**
 * Resolve the database environment.
 * When targetKind is "local" or "file" (SQLite / PGlite) and
 * PI_SHIP_DATABASE_ENVIRONMENT is unset, default to "development"
 * instead of throwing. Remote targets must still have the env var
 * set explicitly.
 */
export function resolveDatabaseEnvironment(
  source: CredentialSource,
  targetKind?: string,
): Environment {
  const value = source.get("PI_SHIP_DATABASE_ENVIRONMENT");
  if (value && databaseEnvironments.has(value as Environment)) {
    return value as Environment;
  }
  if (targetKind === "local" || targetKind === "file") {
    return "development";
  }
  throw err(
    "E_CONFIG_INVALID",
    "PI_SHIP_DATABASE_ENVIRONMENT must be development, preview, or production",
  );
}
