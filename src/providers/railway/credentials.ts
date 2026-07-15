import { CredentialSource, ProviderCredentials } from "../../deployment/credentials.js";

const railwayNames = ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"] as const;

export function loadRailwayCredentials(source: CredentialSource): ProviderCredentials {
  return {
    apiToken: source.get(railwayNames[0]),
    projectToken: source.get(railwayNames[1]),
  };
}
