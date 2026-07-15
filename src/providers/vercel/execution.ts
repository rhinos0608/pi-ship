import type { ProviderExecutionBase } from "../contracts.js";
import type { VercelClient } from "./client.js";
import type { VercelRuntime } from "./runtime.js";

export interface VercelExecution extends ProviderExecutionBase {
  readonly provider: "vercel";
  readonly contract: 2;
  readonly runtime: VercelRuntime;
  readonly client: VercelClient;
}

export function isVercelExecution(value: ProviderExecutionBase): value is VercelExecution {
  if (value.provider !== "vercel") return false;
  const candidate = value as ProviderExecutionBase & Record<string, unknown>;
  return candidate.contract === 2
    && typeof candidate.runtime === "object"
    && candidate.runtime !== null
    && typeof candidate.client === "object"
    && candidate.client !== null;
}
