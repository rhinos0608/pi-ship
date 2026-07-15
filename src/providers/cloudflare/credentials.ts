import type { CredentialSource, ProviderCredentials } from "../../deployment/credentials.js";
import { err } from "../../core/errors.js";

export interface CloudflareCredentials extends ProviderCredentials {
  apiToken: string;
  accountId: string;
}

export function loadCloudflareCredentials(source: CredentialSource): CloudflareCredentials {
  const apiToken = source.get("CLOUDFLARE_API_TOKEN");
  const accountId = source.get("CLOUDFLARE_ACCOUNT_ID");
  if (!apiToken) throw err("E_AUTH_MISSING", "CLOUDFLARE_API_TOKEN is required");
  if (!accountId) throw err("E_AUTH_MISSING", "CLOUDFLARE_ACCOUNT_ID is required");
  return { apiToken, accountId };
}
