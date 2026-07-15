import { err, type ShipError } from "../../src/core/errors.js";
import type {
  DeployResult,
  FailureInjection,
  PostgresResult,
  ProjectResult,
  ProviderAdapter,
  RollbackResult,
  ServiceResult,
  StatusResult,
  VariableSource,
} from "../../src/providers/railway/adapter.js";

export interface FakeCall {
  method: string;
  args: unknown[];
}

export function createFakeProvider(config?: {
  initial?: {
    projects?: Record<string, string>;
    services?: Record<string, string>;
  };
  failures?: FailureInjection;
}): ProviderAdapter & {
  calls: FakeCall[];
  projects: Map<string, string>;
  services: Map<string, string>;
  variables: Map<string, Record<string, string | undefined>>;
  releases: Map<string, { releaseId: string; url?: string; rolledBack?: boolean }>;
  injectFailure(method: keyof FailureInjection, error: ShipError): void;
} {
  const projects = new Map(Object.entries(config?.initial?.projects ?? {}));
  const services = new Map(Object.entries(config?.initial?.services ?? {}));
  const variables = new Map<string, Record<string, string | undefined>>();
  const releases = new Map<string, { releaseId: string; url?: string; rolledBack?: boolean }>();
  const failures: FailureInjection = { ...config?.failures };
  const calls: FakeCall[] = [];

  function maybeFail(method: keyof FailureInjection): void {
    const error = failures[method];
    if (error) throw error;
  }

  function record(method: string, args: unknown[]): void {
    calls.push({ method, args: args.map((a) => (typeof a === "function" ? "<function>" : a)) });
  }

  function uid(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  return {
    id: "railway",
    calls,
    projects,
    services,
    variables,
    releases,
    injectFailure(method, error) {
      failures[method] = error;
    },
    async checkAuth() {
      record("checkAuth", []);
      maybeFail("checkAuth");
      return { ok: true };
    },
    async ensureProject(name) {
      record("ensureProject", [name]);
      maybeFail("ensureProject");
      const existing = projects.get(name);
      if (existing) return { projectId: existing, projectName: name, environmentId: "env-production", environmentName: "production", created: false };
      const id = uid("proj");
      projects.set(name, id);
      return { projectId: id, projectName: name, environmentId: "env-production", environmentName: "production", created: true };
    },
    async ensureService(projectId, name) {
      record("ensureService", [projectId, name]);
      maybeFail("ensureService");
      const key = `${projectId}/${name}`;
      const existing = services.get(key);
      if (existing) return { serviceId: existing, created: false };
      const id = uid("svc");
      services.set(key, id);
      return { serviceId: id, created: true };
    },
    async setVariables(serviceId, names, source) {
      record("setVariables", [serviceId, names, source]);
      maybeFail("setVariables");
      const values = source();
      variables.set(serviceId, values);
    },
    async deploy(serviceId, _dir, _signal, onUpdate) {
      record("deploy", [serviceId, _dir]);
      maybeFail("deploy");
      onUpdate?.("deploy started");
      const id = uid("rel");
      const url = `https://${id}.railway.app`;
      releases.set(id, { releaseId: id, url });
      return { releaseId: id, url };
    },
    async status(serviceId) {
      record("status", [serviceId]);
      maybeFail("status");
      return { status: "SUCCESS", url: `https://${serviceId}.railway.app` };
    },
    async logs(serviceId, lines) {
      record("logs", [serviceId, lines]);
      maybeFail("logs");
      return `log line 1\nlog line 2`;
    },
    async rollback(_serviceId, releaseId) {
      record("rollback", [_serviceId, releaseId]);
      maybeFail("rollback");
      const rel = releases.get(releaseId);
      if (!rel || rel.rolledBack) {
        throw err("E_PRECONDITION", "cannot rollback this deployment");
      }
      rel.rolledBack = true;
      return { ok: true, releaseId: uid("rel") };
    },
    async provisionPostgres(_projectId) {
      record("provisionPostgres", [_projectId]);
      maybeFail("provisionPostgres");
      throw err("E_PHASE_UNSUPPORTED", "Railway Postgres auto-provision is disabled in MVP");
    },
  };
}
