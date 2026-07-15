import { err } from "../core/errors.js";
import { environmentSource, type EnvironmentReader } from "../core/environment.js";

export type CredentialSource = EnvironmentReader;
export { environmentSource };

/** Credentials passed to provider clients. App secret values are separate. */
export interface ProviderCredentials {
  apiToken?: string;
  projectToken?: string;
}

/** Resolve only explicitly requested app secret names. */
export function loadAppSecrets(
  source: CredentialSource,
  names: readonly string[]
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = source.get(name);
    if (value !== undefined) values[name] = value;
  }
  return values;
}
