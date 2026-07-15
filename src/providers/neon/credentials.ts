import type { CredentialSource } from "../../deployment/credentials.js";
import { err } from "../../core/errors.js";

export interface NeonCredentials {
  apiKey: string;
}

export function loadNeonCredentials(source: CredentialSource): NeonCredentials {
  const apiKey = source.get("NEON_API_KEY");
  if (!apiKey) {
    throw err("E_AUTH_MISSING", "NEON_API_KEY environment variable is required");
  }
  return { apiKey };
}
