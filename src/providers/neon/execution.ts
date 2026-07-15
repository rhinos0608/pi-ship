import type { ProviderExecutionBase } from "../contracts.js";
import type { NeonAdapter } from "./adapter.js";

export interface NeonExecution extends ProviderExecutionBase {
  readonly provider: "neon";
  readonly contract: 1;
  readonly adapter: NeonAdapter;
}

export function isNeonExecution(value: ProviderExecutionBase): value is NeonExecution {
  if (value.provider !== "neon") return false;
  const candidate = value as ProviderExecutionBase & Record<string, unknown>;
  return candidate.contract === 1 && typeof candidate.adapter === "object" && candidate.adapter !== null;
}
