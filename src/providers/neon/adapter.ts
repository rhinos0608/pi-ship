import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { err } from "../../core/errors.js";
import { createNeonClient, type NeonClient, type CreateProjectConfig, type CreateBranchConfig } from "./client.js";

export interface EnsureProjectResult {
  projectId: string;
  projectName: string;
  created: boolean;
}

export interface EnsureBranchResult {
  branchId: string;
  branchName: string;
  created: boolean;
  connectionUri?: string;
}

export interface CreatePreviewBranchResult {
  branchId: string;
  connectionUri: string;
}

export interface NeonAdapter {
  checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; missing?: string[] }>;
  ensureProject(name: string, config?: { pgVersion?: number; regionId?: string }, signal?: AbortSignal): Promise<EnsureProjectResult>;
  ensureBranch(projectId: string, name: string, parentId?: string, config?: { databaseName?: string; roleName?: string }, signal?: AbortSignal): Promise<EnsureBranchResult>;
  getConnectionUri(projectId: string, branchId: string, databaseName: string, roleName: string, signal?: AbortSignal): Promise<string>;
  createPreviewBranch(projectId: string, parentId: string, name: string, expiresAt?: string, signal?: AbortSignal): Promise<CreatePreviewBranchResult>;
}

export interface NeonAdapterConfig {
  apiKey: string;
  pollTimeoutMs?: number;
}

export function createNeonAdapter(
  _pi: Pick<ExtensionAPI, "exec">,
  config: NeonAdapterConfig,
): NeonAdapter {
  const client = createNeonClient({
    apiKey: config.apiKey,
    pollIntervalMs: 2000,
  });
  const pollTimeoutMs = config.pollTimeoutMs ?? 60_000;

  async function resolveConnectionUri(
    projectId: string,
    branchId: string,
    databaseName?: string,
    roleName?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Try branch connection URI first
    const databases = await client.listDatabases(projectId, branchId, signal);
    const dbName = databaseName ?? (databases[0]?.name ?? "neondb");
    const role = roleName ?? (databases[0]?.owner_name ?? "neondb_owner");
    return client.getConnectionUri(projectId, branchId, dbName, role, signal);
  }

  return {
    async checkAuth(signal) {
      const result = await client.checkAuth(signal);
      if (!result.ok) return { ok: false, missing: ["NEON_API_KEY"] };
      return { ok: true };
    },

    async ensureProject(name, config, signal) {
      const projects = await client.listProjects(signal);
      const existing = projects.find((p) => p.name === name);
      if (existing) {
        return { projectId: existing.id, projectName: existing.name, created: false };
      }

      const body: CreateProjectConfig = {
        project: {
          name,
          pg_version: config?.pgVersion ?? 16,
          region_id: config?.regionId ?? "aws-us-east-1",
        },
      };
      const result = await client.createProject(body, signal);
      // Poll the first create operation to ensure project is ready
      if (result.operations?.length > 0) {
        for (const op of result.operations) {
          await client.pollOperation(result.project.id, op.id, pollTimeoutMs, signal);
        }
      }
      return { projectId: result.project.id, projectName: result.project.name, created: true };
    },

    async ensureBranch(projectId, name, parentId, config, signal) {
      const branches = await client.listBranches(projectId, signal);
      const existing = branches.find((b) => b.name === name);
      if (existing) {
        let connectionUri: string | undefined;
        try {
          const dbName = config?.databaseName ?? "neondb";
          const role = config?.roleName ?? "neondb_owner";
          connectionUri = await client.getConnectionUri(projectId, existing.id, dbName, role, signal);
        } catch {
          // Connection URI resolution is best-effort on existing branch
        }
        return { branchId: existing.id, branchName: existing.name, created: false, connectionUri };
      }

      const body: CreateBranchConfig = {
        branch: {
          name,
          ...(parentId ? { parent_id: parentId } : {}),
        },
        endpoints: [{ type: "read_write" }],
      };
      const result = await client.createBranch(projectId, body, signal);
      if (result.operations?.length > 0) {
        for (const op of result.operations) {
          await client.pollOperation(projectId, op.id, pollTimeoutMs, signal);
        }
      }

      const connectionUri = result.connection_uris?.[0]?.connection_uri
        ?? await resolveConnectionUri(projectId, result.branch.id, config?.databaseName, config?.roleName, signal);

      return { branchId: result.branch.id, branchName: result.branch.name, created: true, connectionUri };
    },

    async getConnectionUri(projectId, branchId, databaseName, roleName, signal) {
      return client.getConnectionUri(projectId, branchId, databaseName, roleName, signal);
    },

    async createPreviewBranch(projectId, parentId, name, expiresAt, signal) {
      const body: CreateBranchConfig = {
        branch: {
          name,
          parent_id: parentId,
          // Use branch-level expires_at for auto-deletion (not endpoint TTL)
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        },
        endpoints: [{ type: "read_write" }],
      };

      const result = await client.createBranch(projectId, body, signal);
      if (result.operations?.length > 0) {
        for (const op of result.operations) {
          await client.pollOperation(projectId, op.id, pollTimeoutMs, signal);
        }
      }

      const connectionUri = result.connection_uris?.[0]?.connection_uri
        ?? await resolveConnectionUri(projectId, result.branch.id, undefined, undefined, signal);

      return { branchId: result.branch.id, connectionUri };
    },

  
  };
}
