import { CredentialSource, ProviderCredentials } from "../../deployment/credentials.js";
import { err } from "../../core/errors.js";

export function loadVercelCredentials(source: CredentialSource): ProviderCredentials {
  return { apiToken: source.get("VERCEL_TOKEN") };
}

export function requireVercelCredentials(source: CredentialSource): ProviderCredentials & { apiToken: string } {
  const credentials = loadVercelCredentials(source);
  if (!credentials.apiToken) {
    throw err("E_AUTH_MISSING", "VERCEL_TOKEN is required");
  }
  return credentials as ProviderCredentials & { apiToken: string };
}
