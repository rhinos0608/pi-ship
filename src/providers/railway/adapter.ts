import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ShipError } from "../../core/errors.js";
import { err } from "../../core/errors.js";
import { createRailwayCliClient, type ExecLike } from "./cli.js";
import { createRailwayGqlClient, type GqlFetchLike } from "./gql.js";

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
  setVariables(serviceId: string, names: string[], source: VariableSource, signal?: AbortSignal): Promise<void>;
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

export interface RailwayAdapterConfig {
  apiToken?: string;
  projectToken?: string;
  environmentId?: string;
  projectId?: string;
  serviceId?: string;
  exec?: ExecLike;
  fetchImpl?: GqlFetchLike;
  secretValues?: string[];
}

export function createRailwayAdapter(
  pi: Pick<ExtensionAPI, "exec">,
  config: RailwayAdapterConfig,
): ProviderAdapter {
  const exec: ExecLike = (command, args, options) => pi.exec(command, args ?? [], options);
  const cli = createRailwayCliClient(
    config.exec ?? exec,
    [config.apiToken, config.projectToken, ...(config.secretValues ?? [])].filter((value): value is string => !!value),
  );
  const gql = createRailwayGqlClient(
    {
      apiToken: config.apiToken,
      projectToken: config.projectToken,
      secretValues: config.secretValues,
      projectId: config.projectId,
      environmentId: config.environmentId,
    },
    config.fetchImpl,
  );

  let projectId = config.projectId;
  let environmentId = config.environmentId;
  let environmentName: string | undefined;
  let serviceId = config.serviceId;

  async function requireLinkedIds(): Promise<void> {
    if (!projectId || !environmentId || !serviceId) {
      throw err(
        "E_PRECONDITION",
        "linked-existing mode requires projectId, environmentId, and serviceId in .pi-ship/state.json",
      );
    }
  }

  return {
    id: "railway",
    async checkAuth(signal) {
      const auth = await gql.checkAuth(signal);
      if (!auth.ok) return auth;
      await cli.version(signal);
      return { ok: true };
    },
    async ensureProject(name, signal) {
      if (config.projectToken && !config.apiToken) {
        await requireLinkedIds();
        return { projectId: projectId!, environmentId: environmentId!, created: false };
      }
      const result = await gql.ensureProject(name, signal);
      if (!result.environmentId) {
        throw err("E_PRECONDITION", "provider did not return bound project environment ID");
      }
      projectId = result.projectId;
      environmentId = result.environmentId;
      environmentName = result.environmentName;
      return result;
    },
    async ensureService(boundProjectId, name, signal) {
      if (config.projectToken && !config.apiToken) {
        await requireLinkedIds();
        return { serviceId: serviceId!, created: false };
      }
      const result = await gql.ensureService(boundProjectId, name, signal);
      serviceId = result.serviceId;
      return result;
    },
    async setVariables(boundServiceId, _names, source, signal) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(source())) {
        if (value !== undefined) values[key] = value;
      }
      await gql.setVariables(projectId!, environmentId!, boundServiceId, values, {
        replace: false,
        skipDeploys: true,
      }, signal);
    },
    async deploy(boundServiceId, dir, signal) {
      await requireLinkedIds();
      return cli.up(boundServiceId, environmentId!, projectId!, dir, signal);
    },
    async status(boundServiceId, signal) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const providerStatus = await gql.status(boundServiceId, signal);
      const statusMap: Record<string, StatusResult["status"]> = {
        SUCCESS: "SUCCESS",
        FAILED: "FAILED",
        CRASHED: "CRASHED",
        BUILDING: "BUILDING",
        BUILD_IN_PROGRESS: "BUILDING",
      };
      return { status: statusMap[providerStatus.status] ?? "FAILED", url: providerStatus.url };
    },
    async logs(boundServiceId, lines, signal) {
      await requireLinkedIds();
      return cli.logs(boundServiceId, environmentId!, lines, signal);
    },
    async rollback(boundServiceId, releaseId, signal) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const result = await gql.rollback(boundServiceId, releaseId, signal);
      return { ok: result.ok, releaseId: result.releaseId };
    },
    async provisionPostgres(_projectId, signal) {
      signal?.throwIfAborted();
      throw err("E_PHASE_UNSUPPORTED", "Railway Postgres auto-provision is disabled in MVP; use existing DATABASE_URL");
    },
  };
}
