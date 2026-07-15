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
  ok: boolean;
  serviceId: string;
  urlEnvName?: "DATABASE_URL";
}

export type VariableSource = () => Record<string, string | undefined>;

export interface ProviderAdapter {
  id: "railway";
  checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; missing?: string[] }>;
  ensureProject(name: string, signal?: AbortSignal): Promise<ProjectResult>;
  ensureService(projectId: string, name: string, signal?: AbortSignal): Promise<ServiceResult>;
  setVariables(serviceId: string, names: string[], source: VariableSource, signal?: AbortSignal, environmentId?: string): Promise<void>;
  deploy(serviceId: string, dir: string, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<DeployResult>;
  status(serviceId: string, signal?: AbortSignal): Promise<StatusResult>;
  logs(serviceId: string, lines: number, signal?: AbortSignal): Promise<string>;
  rollback(serviceId: string, releaseId: string, signal?: AbortSignal): Promise<RollbackResult>;
  provisionPostgres(projectId: string, environmentId?: string, workspaceId?: string, signal?: AbortSignal): Promise<PostgresResult>;

  // Preview environment operations
  createPreviewEnvironment(projectId: string, name: string, sourceEnvironmentId?: string, signal?: AbortSignal): Promise<{ environmentId: string; created: boolean }>;
  ensurePostgres(projectId: string, environmentId: string, workspaceId: string, signal?: AbortSignal): Promise<{ serviceId: string; created: boolean }>;
  linkPostgresToService(projectId: string, environmentId: string, serviceId: string, postgresServiceName?: string, signal?: AbortSignal): Promise<void>;
  deployToPreview(serviceId: string, environmentId: string, signal?: AbortSignal): Promise<void>;
  getWorkspaceId(projectId: string, signal?: AbortSignal): Promise<string | undefined>;
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
  createPreviewEnvironment?: ShipError;
  ensurePostgres?: ShipError;
  linkPostgresToService?: ShipError;
  deployToPreview?: ShipError;
  getWorkspaceId?: ShipError;
  findEnvironmentByName?: ShipError;
  deleteEnvironment?: ShipError;
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

  let workspaceId: string | undefined;

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
    async setVariables(boundServiceId, _names, source, signal, overrideEnvId) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const targetEnvId = overrideEnvId ?? environmentId!;
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(source())) {
        if (value !== undefined) values[key] = value;
      }
      await gql.setVariables(projectId!, targetEnvId, boundServiceId, values, {
        replace: false,
        skipDeploys: true,
      }, signal);
    },
    async deploy(boundServiceId, dir, signal) {
      await requireLinkedIds();
      return cli.up(boundServiceId, environmentId!, projectId!, dir, signal);
    },

    async deployToPreview(serviceId, envId, signal) {
      await gql.deployServiceInstance(serviceId, envId, signal);
    },

    async getWorkspaceId(projId, signal) {
      if (workspaceId) return workspaceId;
      const wid = await gql.getWorkspaceId(projId, signal);
      if (wid) workspaceId = wid;
      return wid;
    },

    async createPreviewEnvironment(projId, name, sourceEnvId, signal) {
      // Idempotent: check if environment already exists
      const existing = await gql.findEnvironmentByName(projId, name, signal);
      if (existing) {
        return { environmentId: existing.id, created: false };
      }
      const result = await gql.createEnvironment(projId, name, true, sourceEnvId, true, signal);
      return { environmentId: result.environmentId, created: true };
    },

    async ensurePostgres(projId, envId, wsId, signal) {
      // Idempotent: check for existing Postgres service instance
      const instances = await gql.getServiceInstances(envId, signal);
      const existingPg = instances.find((inst) => inst.name === "Postgres");
      if (existingPg) {
        return { serviceId: existingPg.serviceId ?? existingPg.id, created: false };
      }
      // Get postgres template
      const template = await gql.getTemplate("postgres", signal);
      if (!template) {
        throw err("E_PROVIDER", "postgres template not found in Railway");
      }
      const result = await gql.deployTemplate(
        template.id,
        template.serializedConfig ?? "{}",
        projId,
        envId,
        wsId,
        signal
      );
      return { serviceId: result.serviceId, created: true };
    },

    async linkPostgresToService(projId, envId, svcId, pgServiceName, signal) {
      await gql.setVariables(projId, envId, svcId, {
        DATABASE_URL: `\${{${pgServiceName ?? "Postgres"}.DATABASE_URL}}`,
      }, { replace: false, skipDeploys: true }, signal);
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
    async provisionPostgres(projId, envId, wsId, signal) {
      // Real implementation using templateDeployV2 (was MVP-stubbed)
      signal?.throwIfAborted();
      if (!envId) throw err("E_PRECONDITION", "environmentId required for provisionPostgres");
      if (!wsId) {
        const wid = await gql.getWorkspaceId(projId, signal);
        if (!wid) throw err("E_PROVIDER", "could not discover workspaceId");
        wsId = wid;
      }
      const existing = await gql.getServiceInstances(envId, signal);
      const existingPg = existing.find((inst) => inst.name === "Postgres");
      if (existingPg) {
        return { ok: true, serviceId: existingPg.serviceId ?? existingPg.id };
      }
      const template = await gql.getTemplate("postgres", signal);
      if (!template) throw err("E_PROVIDER", "postgres template not found");
      const pgResult = await gql.deployTemplate(
        template.id,
        template.serializedConfig ?? "{}",
        projId,
        envId,
        wsId,
        signal
      );
      return { ok: true, serviceId: pgResult.serviceId };
    },
  };
}
