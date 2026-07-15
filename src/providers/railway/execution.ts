import type { ProviderExecutionBase } from "../contracts.js";
import type { ProviderAdapter } from "./adapter.js";

export interface RailwayExecution extends ProviderExecutionBase {
  readonly provider: "railway";
  readonly contract: 1;
  readonly adapter: ProviderAdapter;
}

export function isRailwayExecution(value: ProviderExecutionBase): value is RailwayExecution {
  if (value.provider !== "railway") return false;
  const candidate = value as ProviderExecutionBase & Record<string, unknown>;
  return candidate.contract === 1 && typeof candidate.adapter === "object" && candidate.adapter !== null;
}
