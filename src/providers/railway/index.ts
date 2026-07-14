import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { err } from "../../core/errors.js";
import type { ProviderAdapter, VariableSource } from "../types.js";
import { createRailwayCliClient, type ExecLike } from "./cli.js";
import { createRailwayGqlClient, type GqlFetchLike } from "./gql.js";

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

export function createRailwayAdapter(pi: Pick<ExtensionAPI, "exec">, config: RailwayAdapterConfig): ProviderAdapter {
  const exec: ExecLike = (command, args, options) => pi.exec(command, args ?? [], options);
  const cli = createRailwayCliClient(config.exec ?? exec, [config.apiToken, config.projectToken, ...(config.secretValues ?? [])].filter((v): v is string => !!v));
  const gql = createRailwayGqlClient(
    { apiToken: config.apiToken, projectToken: config.projectToken, secretValues: config.secretValues, projectId: config.projectId, environmentId: config.environmentId },
    config.fetchImpl
  );

  let projectId = config.projectId;
  let environmentId = config.environmentId;
  let environmentName: string | undefined;
  let serviceId = config.serviceId;

  async function requireLinkedIds() {
    if (!projectId || !environmentId || !serviceId) {
      throw err(
        "E_PRECONDITION",
        "linked-existing mode requires projectId, environmentId, and serviceId in .pi-ship/state.json"
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
    async ensureService(projectId, name, signal) {
      if (config.projectToken && !config.apiToken) {
        await requireLinkedIds();
        return { serviceId: serviceId!, created: false };
      }
      const result = await gql.ensureService(projectId, name, signal);
      serviceId = result.serviceId;
      return result;
    },
    async setVariables(serviceId, names, source, signal) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(source())) {
        if (v !== undefined) values[k] = v;
      }
      await gql.setVariables(projectId!, environmentId!, serviceId, values, {
        replace: false,
        skipDeploys: true,
      }, signal);
    },
    async deploy(serviceId, dir, signal, onUpdate) {
      await requireLinkedIds();
      return cli.up(serviceId, environmentId!, projectId!, dir, signal);
    },
    async status(serviceId, signal) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const s = await gql.status(serviceId, signal);
      const statusMap: Record<string, "SUCCESS" | "FAILED" | "BUILDING" | "CRASHED"> = {
        SUCCESS: "SUCCESS",
        FAILED: "FAILED",
        CRASHED: "CRASHED",
        BUILDING: "BUILDING",
        BUILD_IN_PROGRESS: "BUILDING",
      };
      return { status: statusMap[s.status] ?? "FAILED", url: s.url };
    },
    async logs(serviceId, lines, signal) {
      await requireLinkedIds();
      return cli.logs(serviceId, environmentId!, lines, signal);
    },
    async rollback(serviceId, releaseId, signal) {
      signal?.throwIfAborted();
      await requireLinkedIds();
      const r = await gql.rollback(serviceId, releaseId, signal);
      return { ok: r.ok, releaseId: r.releaseId };
    },
    async provisionPostgres(_projectId, signal) {
      signal?.throwIfAborted();
      throw err("E_PHASE_UNSUPPORTED", "Railway Postgres auto-provision is disabled in MVP; use existing DATABASE_URL");
    },
  };
}
