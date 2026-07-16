import { CredentialSource, ProviderCredentials } from "../../deployment/credentials.js";
import { err } from "../../core/errors.js";

const railwayNames = ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"] as const;

export function loadRailwayCredentials(source: CredentialSource): ProviderCredentials {
  return {
    apiToken: source.get(railwayNames[0]),
    projectToken: source.get(railwayNames[1]),
  };
}

/** Require credentials only at execution boundary; validation and planning stay offline. */
export function requireRailwayCredentials(source: CredentialSource): ProviderCredentials & { apiToken: string } {
  const credentials = loadRailwayCredentials(source);
  const apiToken = credentials.apiToken ?? credentials.projectToken;
  if (!apiToken) {
    throw err("E_AUTH_MISSING", "RAILWAY_API_TOKEN or RAILWAY_TOKEN is required");
  }
  return { ...credentials, apiToken };
}
