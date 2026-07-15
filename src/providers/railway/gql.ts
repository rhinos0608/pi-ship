import { err } from "../../core/errors.js";
import { redact } from "../../core/redact.js";

export const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

export interface RailwayGqlOptions {
  apiToken?: string;
  projectToken?: string;
  secretValues?: string[];
  projectId?: string;
  environmentId?: string;
}

export interface GqlFetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface RailwayGqlClient {
  checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; missing?: string[] }>;
  ensureProject(name: string, signal?: AbortSignal): Promise<{ projectId: string; projectName?: string; environmentId?: string; environmentName?: string; created: boolean }>;
  ensureService(projectId: string, name: string, signal?: AbortSignal): Promise<{ serviceId: string; created: boolean }>;
  setVariables(
    projectId: string,
    environmentId: string,
    serviceId: string,
    variables: Record<string, string>,
    options?: { replace?: boolean; skipDeploys?: boolean }, signal?: AbortSignal
  ): Promise<void>;
  status(serviceId: string, signal?: AbortSignal): Promise<{ status: string; url?: string }>;
  rollback(serviceId: string, deploymentId: string, signal?: AbortSignal): Promise<{ ok: boolean; releaseId?: string }>;

  // Preview environment operations
  createEnvironment(
    projectId: string,
    name: string,
    ephemeral: boolean,
    sourceEnvironmentId?: string,
    skipInitialDeploys?: boolean,
    signal?: AbortSignal
  ): Promise<{ environmentId: string }>;
  deleteEnvironment(environmentId: string, signal?: AbortSignal): Promise<void>;
  findEnvironmentByName(projectId: string, name: string, signal?: AbortSignal): Promise<{ id: string; name?: string } | null>;

  // Postgres template operations
  getTemplate(code: string, signal?: AbortSignal): Promise<{ id: string; serializedConfig?: string } | null>;
  deployTemplate(
    templateId: string,
    serializedConfig: string,
    projectId: string,
    environmentId: string,
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<{ serviceId: string }>;

  // Service operations
  deployServiceInstance(serviceId: string, environmentId: string, signal?: AbortSignal): Promise<void>;
  getServiceInstances(environmentId: string, signal?: AbortSignal): Promise<Array<{ id: string; name?: string; serviceId?: string }>>;

  // Workspace discovery
  getWorkspaceId(projectId: string, signal?: AbortSignal): Promise<string | undefined>;
}

export function createRailwayGqlClient(
  options: RailwayGqlOptions,
  fetchImpl: GqlFetchLike = fetch
): RailwayGqlClient {
  const headers = buildHeaders(options);
  const linked = !options.apiToken && !!options.projectToken;

  async function gql<T = unknown>(query: string, variables?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const res = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") ?? "0";
      throw err("E_PROVIDER", `Railway rate limited (429); retry after ${retryAfter}s`, true);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw err("E_PROVIDER", `Railway GraphQL returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const message = redact(extractError(body) || `HTTP ${res.status}`, ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"], [options.apiToken, options.projectToken, ...(options.secretValues ?? [])].filter((v): v is string => !!v));
      throw err("E_PROVIDER", `Railway GraphQL error: ${message}`);
    }
    if (body && typeof body === "object" && (body as Record<string, unknown>).errors) {
      const message = redact(extractError(body) || "GraphQL error", ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"], [options.apiToken, options.projectToken, ...(options.secretValues ?? [])].filter((v): v is string => !!v));
      if (message.toLowerCase().includes("unauthenticated") || message.toLowerCase().includes("unauthorized")) {
        throw err("E_AUTH_MISSING", message);
      }
      throw err("E_PROVIDER", message);
    }
    if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "data")) {
      throw err("E_PROVIDER", "Railway GraphQL response missing data envelope");
    }
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== "object") {
      throw err("E_PROVIDER", "Railway GraphQL response has invalid data envelope");
    }
    return data as T;
  }

  return {
    async checkAuth(signal) {
      if (!options.apiToken && !options.projectToken) {
        return { ok: false, missing: ["RAILWAY_API_TOKEN or RAILWAY_TOKEN"] };
      }
      // lightweight probe; exact query unverified in live spike
      await gql(`{ me { id } }`, undefined, signal);
      return { ok: true };
    },
    async ensureProject(name, signal) {
      if (linked) {
        throw err("E_PRECONDITION", "linked-existing mode requires projectId in .pi-ship/state.json");
      }
      const find = await gql<{ project?: { id: string; name?: string; environments?: Array<{ id: string; name?: string }> } }>(
        `query FindProject($name: String!) { project(name: $name) { id name environments { id name } } }`,
        { name }, signal
      );
      if (find.project?.id) {
        const environment = find.project.environments?.find((e) => e.name === "production") ?? find.project.environments?.[0];
        return { projectId: find.project.id, ...(find.project.name ? { projectName: find.project.name } : {}), ...(environment?.id ? { environmentId: environment.id } : {}), ...(environment?.name ? { environmentName: environment.name } : {}), created: false };
      }
      const create = await gql<{ projectCreate: { id: string } }>(
        `mutation CreateProject($name: String!) { projectCreate(input: { name: $name }) { id } }`,
        { name }, signal
      );
      const rediscovered = await gql<{ project?: { id: string; name?: string; environments?: Array<{ id: string; name?: string }> } }>(
        `query FindProject($name: String!) { project(name: $name) { id name environments { id name } } }`, { name }, signal
      );
      const environment = rediscovered.project?.environments?.find((e) => e.name === "production") ?? rediscovered.project?.environments?.[0];
      if (!environment?.id) throw err("E_PROVIDER", "created project environment could not be discovered");
      return { projectId: create.projectCreate.id, projectName: rediscovered.project?.name ?? name, environmentId: environment.id, environmentName: environment.name, created: true };
    },
    async ensureService(projectId, name, signal) {
      if (linked) {
        throw err("E_PRECONDITION", "linked-existing mode requires serviceId in .pi-ship/state.json");
      }
      const find = await gql<{ project?: { services?: Array<{ id: string; name?: string }> } }>(
        `query FindService($projectId: String!) { project(id: $projectId) { services { id name } } }`,
        { projectId }, signal
      );
      const existing = find.project?.services?.find((service) => service.name === name);
      if (existing?.id) return { serviceId: existing.id, created: false };
      const create = await gql<{ serviceCreate: { id: string } }>(
        `mutation CreateService($projectId: String!, $name: String!) { serviceCreate(input: { projectId: $projectId, name: $name }) { id } }`,
        { projectId, name }, signal
      );
      return { serviceId: create.serviceCreate.id, created: true };
    },
    async setVariables(projectId, environmentId, serviceId, variables, opts = {}, signal) {
      await gql<{ variableCollectionUpsert: boolean }>(
        `mutation SetVariables(
          $projectId: String!,
          $environmentId: String!,
          $serviceId: String!,
          $variables: Map!,
          $replace: Boolean!,
          $skipDeploys: Boolean!
        ) {
          variableCollectionUpsert(
            input: {
              projectId: $projectId,
              environmentId: $environmentId,
              serviceId: $serviceId,
              variables: $variables,
              replace: $replace,
              skipDeploys: $skipDeploys
            }
          )
        }`,
        {
          projectId,
          environmentId,
          serviceId,
          variables,
          replace: opts.replace ?? false,
          skipDeploys: opts.skipDeploys ?? true,
        }, signal
      );
    },
    async status(serviceId, signal) {
      const res = await gql<{ deployments: Array<{ status: string; url?: string }> }>(
        `query Deployments($serviceId: String!) { deployments(input: { serviceId: $serviceId }) { status url } }`,
        { serviceId }, signal
      );
      const first = res.deployments?.[0];
      return { status: first?.status ?? "UNKNOWN", url: first?.url };
    },
    async rollback(serviceId, deploymentId, signal) {
      const detail = await gql<{ deployment?: { canRollback: boolean; serviceId?: string; projectId?: string; environmentId?: string } }>(
        `query Deployment($id: String!) { deployment(id: $id) { canRollback serviceId projectId environmentId } }`,
        { id: deploymentId }, signal
      );
      const owner = detail.deployment;
      if (owner && ((owner.serviceId && owner.serviceId !== serviceId) || (options.projectId && owner.projectId && owner.projectId !== options.projectId) || (options.environmentId && owner.environmentId && owner.environmentId !== options.environmentId))) throw err("E_STATE_CONFLICT", "rollback target is bound to different Railway ownership");
      if (!detail.deployment?.canRollback) {
        throw err("E_PRECONDITION", "deployment cannot be rolled back; Railway requires canRollback:true");
      }
      const res = await gql<{ deploymentRollback: { id: string } }>(
        `mutation Rollback($id: String!) { deploymentRollback(id: $id) { id } }`,
        { id: deploymentId }, signal
      );
      return { ok: true, releaseId: res.deploymentRollback.id };
    },

    // -- Preview environment operations --

    async createEnvironment(projectId, name, ephemeral, sourceEnvironmentId, skipInitialDeploys, signal) {
      const res = await gql<{ environmentCreate: { id: string } }>(
        `mutation EnvironmentCreate(
          $projectId: String!,
          $name: String!,
          $ephemeral: Boolean!,
          $sourceEnvironmentId: String,
          $skipInitialDeploys: Boolean
        ) {
          environmentCreate(input: {
            projectId: $projectId,
            name: $name,
            ephemeral: $ephemeral,
            sourceEnvironmentId: $sourceEnvironmentId,
            skipInitialDeploys: $skipInitialDeploys
          }) { id }
        }`,
        {
          projectId,
          name,
          ephemeral,
          sourceEnvironmentId: sourceEnvironmentId ?? null,
          skipInitialDeploys: skipInitialDeploys ?? null,
        },
        signal
      );
      return { environmentId: res.environmentCreate.id };
    },

    async deleteEnvironment(environmentId, signal) {
      await gql(
        `mutation EnvironmentDelete($environmentId: String!) {
          environmentDelete(id: $environmentId)
        }`,
        { environmentId },
        signal
      );
    },

    async findEnvironmentByName(projectId, name, signal) {
      const res = await gql<{ project?: { environments?: Array<{ id: string; name?: string }> } }>(
        `query FindEnvironmentByName($projectId: String!) {
          project(id: $projectId) {
            environments { id name }
          }
        }`,
        { projectId },
        signal
      );
      const env = res.project?.environments?.find((e) => e.name === name) ?? null;
      return env ?? null;
    },

    // -- Postgres template operations --

    async getTemplate(code, signal) {
      const res = await gql<{ template?: { id: string; serializedConfig?: string } | null }>(
        `query GetTemplate($code: String!) {
          template(code: $code) { id serializedConfig }
        }`,
        { code },
        signal
      );
      return res.template ?? null;
    },

    async deployTemplate(templateId, serializedConfig, projectId, environmentId, workspaceId, signal) {
      const res = await gql<{ templateDeployV2: { id: string } }>(
        `mutation TemplateDeployV2(
          $templateId: String!,
          $serializedConfig: String!,
          $projectId: String!,
          $environmentId: String!,
          $workspaceId: String!
        ) {
          templateDeployV2(input: {
            templateId: $templateId,
            serializedConfig: $serializedConfig,
            projectId: $projectId,
            environmentId: $environmentId,
            workspaceId: $workspaceId
          }) { id }
        }`,
        { templateId, serializedConfig, projectId, environmentId, workspaceId },
        signal
      );
      return { serviceId: res.templateDeployV2.id };
    },

    // -- Service operations --

    async deployServiceInstance(serviceId, environmentId, signal) {
      await gql(
        `mutation ServiceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeployV2(input: { serviceId: $serviceId, environmentId: $environmentId })
        }`,
        { serviceId, environmentId },
        signal
      );
    },

    async getServiceInstances(environmentId, signal) {
      const res = await gql<{ environment?: { serviceInstances?: Array<{ id: string; name?: string; serviceId?: string }> } }>(
        `query GetServiceInstances($environmentId: String!) {
          environment(id: $environmentId) {
            serviceInstances { id name serviceId }
          }
        }`,
        { environmentId },
        signal
      );
      return res.environment?.serviceInstances ?? [];
    },

    // -- Workspace discovery --

    async getWorkspaceId(projectId, signal) {
      const res = await gql<{ project?: { workspaceId?: string } }>(
        `query GetWorkspaceId($projectId: String!) {
          project(id: $projectId) { workspaceId }
        }`,
        { projectId },
        signal
      );
      return res.project?.workspaceId;
    },
  };
}

function buildHeaders(options: RailwayGqlOptions): Record<string, string> {
  if (options.apiToken) return { Authorization: `Bearer ${options.apiToken}` };
  if (options.projectToken) return { "Project-Access-Token": options.projectToken };
  return {};
}

function extractError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const first = b.errors[0];
    if (first && typeof first === "object") {
      return (first as { message?: string }).message;
    }
  }
  return undefined;
}
