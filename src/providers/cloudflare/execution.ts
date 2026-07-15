import type { ProviderExecutionBase } from "../contracts.js";
import type { CloudflareClient } from "./client.js";
import type { CloudflareRuntime } from "./runtime.js";

export interface CloudflareExecution extends ProviderExecutionBase {
  readonly provider: "cloudflare";
  readonly contract: 1;
  readonly runtime: CloudflareRuntime;
  readonly client: CloudflareClient;
}

export function isCloudflareExecution(value: ProviderExecutionBase): value is CloudflareExecution {
  if (value.provider !== "cloudflare") return false;
  const candidate = value as ProviderExecutionBase & Record<string, unknown>;
  return candidate.contract === 1
    && typeof candidate.runtime === "object"
    && candidate.runtime !== null
    && typeof candidate.client === "object"
    && candidate.client !== null;
}
