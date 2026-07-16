import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../core/approval.js";
import type { CredentialSource } from "../deployment/credentials.js";
import type { DatabaseHandler } from "../tools/db/contracts.js";
import type { ShipHandler } from "../tools/ship/contracts.js";
import type { ProviderCapabilityProfile } from "./capability-profile.js";

export type ProviderId = string;

export interface ProviderExecutionBase {
  readonly provider: ProviderId;
}

export interface ProviderExecutionOptions {
  pi: Pick<ExtensionAPI, "exec">;
  credentialSource: CredentialSource;
  state?: unknown;
  cwd?: string;
  appSecretValues?: readonly string[];
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Registry operations exposed to provider handlers without importing registry composition. */
export interface RegistryServices {
  /** Credential source bound at registration time (vault-aware in exclusive mode). */
  readonly credentialSource: CredentialSource;
  loadManifest(): Promise<unknown>;
  loadState(packageId: ProviderId): Promise<unknown>;
  saveState(packageId: ProviderId, state: unknown): Promise<void>;
  loadPlan(packageId: ProviderId, planId: string): Promise<unknown>;
  persistPlan(packageId: ProviderId, plan: unknown): Promise<void>;
  createExecution(manifest: unknown, options: ProviderExecutionOptions): ProviderExecutionBase;
}

export interface ProviderPackage {
  id: ProviderId;
  profile: ProviderCapabilityProfile;
  isManifest(value: unknown): boolean;
  isPlan(value: unknown): boolean;
  isState(value: unknown): boolean;
  validateManifest?(manifest: unknown): void;
  computePlanDigest?(plan: unknown): string;
  defaultState(): unknown;
  stateInvalidSaveMessage?: string;
  conflictMessage: {
    loadStateFromOther: string;
    saveStateOverOther: string;
    loadPlanFromOther?: string;
  };
  createExecution?(manifest: unknown, options: ProviderExecutionOptions): ProviderExecutionBase;
  registerCommands?(
    pi: ExtensionAPI,
    registry: ApprovalRegistry,
    makeServices: (cwd: string) => RegistryServices,
  ): void;
  getShipOpsHandler?(manifest: unknown): ShipHandler | undefined;
  getDatabaseOpsHandler?(manifest: unknown): DatabaseHandler | undefined;
}

export interface ProviderCatalog {
  ids(): readonly ProviderId[];
  resolveManifest(manifest: unknown): ProviderPackage;
  createExecution(manifest: unknown, options: ProviderExecutionOptions): ProviderExecutionBase;
  getShipOpsHandler(manifest: unknown): ShipHandler | undefined;
  getDatabaseOpsHandler(manifest: unknown): DatabaseHandler | undefined;
}
