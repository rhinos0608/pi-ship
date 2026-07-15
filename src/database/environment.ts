import { err } from "../core/errors.js";
import type { Environment } from "../core/types.js";
import type { CredentialSource } from "../deployment/credentials.js";

const databaseEnvironments = new Set<Environment>(["development", "preview", "production"]);

/** Resolve database target only from configured credential environment. */
export function resolveDatabaseEnvironment(source: CredentialSource): Environment {
  const value = source.get("PI_SHIP_DATABASE_ENVIRONMENT");
  if (!value || !databaseEnvironments.has(value as Environment)) {
    throw err(
      "E_CONFIG_INVALID",
      "PI_SHIP_DATABASE_ENVIRONMENT must be development, preview, or production",
    );
  }
  return value as Environment;
}
