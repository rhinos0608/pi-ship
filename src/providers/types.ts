import type { ShipError } from "../core/errors.js";

export interface ProjectResult {
  projectId: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  created: boolean;
}

export interface ServiceResult {
  serviceId: string;
  serviceName?: string;
  created: boolean;
}

export interface DeployResult {
  releaseId: string;
  url?: string;
}

export interface StatusResult {
  status: "SUCCESS" | "FAILED" | "BUILDING" | "CRASHED";
  url?: string;
}

export interface RollbackResult {
  ok: boolean;
  releaseId?: string;
  unsupported?: boolean;
}

export interface PostgresResult {
  serviceId: string;
  urlEnvName: "DATABASE_URL";
}

export type VariableSource = () => Record<string, string | undefined>;

export interface ProviderAdapter {
  id: "railway";
  checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; missing?: string[] }>;
  ensureProject(name: string, signal?: AbortSignal): Promise<ProjectResult>;
  ensureService(projectId: string, name: string, signal?: AbortSignal): Promise<ServiceResult>;
  setVariables(
    serviceId: string,
    names: string[],
    source: VariableSource,
    signal?: AbortSignal
  ): Promise<void>;
  deploy(serviceId: string, dir: string, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<DeployResult>;
  status(serviceId: string, signal?: AbortSignal): Promise<StatusResult>;
  logs(serviceId: string, lines: number, signal?: AbortSignal): Promise<string>;
  rollback(serviceId: string, releaseId: string, signal?: AbortSignal): Promise<RollbackResult>;
  provisionPostgres(projectId: string, signal?: AbortSignal): Promise<PostgresResult>;
}

export interface FailureInjection {
  checkAuth?: ShipError;
  ensureProject?: ShipError;
  ensureService?: ShipError;
  setVariables?: ShipError;
  deploy?: ShipError;
  status?: ShipError;
  logs?: ShipError;
  rollback?: ShipError;
  provisionPostgres?: ShipError;
}
