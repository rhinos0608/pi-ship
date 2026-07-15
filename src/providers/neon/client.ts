import { err } from "../../core/errors.js";
import { redact } from "../../core/redact.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface NeonProject {
  id: string;
  name: string;
  platform_primary_branch: string;
  pg_version: number;
  region_id: string;
  created_at: string;
  updated_at: string;
  /** Synthetic: resolved when needed */
  connection_uris?: NeonConnectionUri[];
}

export interface NeonBranch {
  id: string;
  project_id: string;
  name: string;
  parent_id?: string;
  parent_lsn?: string;
  created_at: string;
  updated_at: string;
  primary: boolean;
}

export interface NeonEndpoint {
  id: string;
  project_id: string;
  branch_id: string;
  type: "read_write" | "read_only";
  host: string;
  port: number;
}

export interface NeonDatabase {
  id: string;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

export interface NeonOperation {
  id: string;
  project_id: string;
  branch_id?: string;
  action: string;
  status: "running" | "finished" | "failed" | "cancelled";
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}

export interface NeonConnectionUri {
  connection_uri: string;
  database: string;
  role: string;
}

export interface CreateProjectConfig {
  project: {
    name: string;
    pg_version?: number;
    region_id?: string;
    branch?: {
      name?: string;
      database_name?: string;
      role_name?: string;
    };
    compute?: {
      min_cu?: number;
      max_cu?: number;
      suspend_timeout_seconds?: number;
    };
  };
}

export interface CreateBranchConfig {
  endpoints?: Array<{
    type: "read_write" | "read_only";
  }>;
  branch: {
    name: string;
    parent_id?: string;
    /** ISO-8601 timestamp for auto-deletion of the branch */
    expires_at?: string;
  };
}

export interface RestoreBranchParams {
  source_branch_id?: string;
  source_timestamp?: string;
  source_lsn?: string;
  preserve_under_name?: string;
}

export interface CreateBranchResponse {
  branch: NeonBranch;
  endpoints: NeonEndpoint[];
  operations: NeonOperation[];
  connection_uris: NeonConnectionUri[];
}

export interface CreateProjectResponse {
  project: NeonProject;
  operations: NeonOperation[];
}

export interface RestoreBranchResponse {
  operations: NeonOperation[];
}

export interface ListProjectsResponse {
  projects: NeonProject[];
  /** Cursor-based pagination — cursor is opaque string */
  cursor?: string;
}

// ── Fetch type ───────────────────────────────────────────────────────────

export interface NeonFetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

// ── Client interface ─────────────────────────────────────────────────────

export interface NeonClient {
  checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; accountId?: string }>;
  listProjects(signal?: AbortSignal): Promise<NeonProject[]>;
  getProject(projectId: string, signal?: AbortSignal): Promise<NeonProject>;
  createProject(config: CreateProjectConfig, signal?: AbortSignal): Promise<CreateProjectResponse>;
  listBranches(projectId: string, signal?: AbortSignal): Promise<NeonBranch[]>;
  getBranch(projectId: string, branchId: string, signal?: AbortSignal): Promise<NeonBranch>;
  createBranch(projectId: string, config: CreateBranchConfig, signal?: AbortSignal): Promise<CreateBranchResponse>;
  getConnectionUri(projectId: string, branchId?: string, databaseName?: string, roleName?: string, signal?: AbortSignal): Promise<string>;
  listDatabases(projectId: string, branchId: string, signal?: AbortSignal): Promise<NeonDatabase[]>;
  getOperation(projectId: string, operationId: string, signal?: AbortSignal): Promise<NeonOperation>;
  restoreBranch(projectId: string, branchId: string, params: RestoreBranchParams, signal?: AbortSignal): Promise<RestoreBranchResponse>;
  pollOperation(projectId: string, operationId: string, timeoutMs?: number, signal?: AbortSignal): Promise<NeonOperation>;
}

// ── Factory ──────────────────────────────────────────────────────────────

export interface NeonClientConfig {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export function createNeonClient(
  config: NeonClientConfig,
  fetchImpl: NeonFetchLike = fetch,
): NeonClient {
  const baseUrl = (config.baseUrl ?? "https://console.neon.tech/api/v2").replace(/\/+$/, "");
  const pollIntervalMs = config.pollIntervalMs ?? 2000;
  const secretValues: string[] = [config.apiKey];

  function buildUrl(path: string): string {
    // String concat preserves baseUrl path segment; new URL() drops it when path is absolute
    return `${baseUrl}${path}`;
  }

  function safeMsg(text: string): string {
    return redact(text, ["NEON_API_KEY"], secretValues);
  }

  function extractNeonError(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const b = body as Record<string, unknown>;
    // Neon errors: { code: string, message: string }
    if (typeof b.message === "string") return b.message;
    if (typeof b.code === "string") return b.code;
    return undefined;
  }

  async function parseBody(res: Response): Promise<{ body: unknown; text: string }> {
    const text = await res.text();
    if (!text || text.trim().length === 0) return { body: undefined, text };
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      try {
        return { body: JSON.parse(text) as unknown, text };
      } catch {
        throw err("E_PROVIDER", safeMsg(`malformed JSON response (HTTP ${res.status})`));
      }
    }
    return { body: text, text };
  }

  async function request(
    method: string,
    path: string,
    opts: {
      headers?: Record<string, string>;
      body?: BodyInit | null;
      signal?: AbortSignal;
    } = {}
  ): Promise<{ body: unknown; text: string; status: number; res: Response }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    };

    try {
      const res = await fetchImpl(buildUrl(path), {
        method,
        headers,
        body: opts.body ?? null,
        signal: opts.signal,
      });

      const { body, text } = await parseBody(res);

      if (!res.ok) {
        const message = (() => {
          const extracted = extractNeonError(body);
          if (extracted) return safeMsg(extracted);
          return safeMsg(`Neon API error (HTTP ${res.status})`);
        })();

        if (res.status === 401 || res.status === 403) {
          throw err("E_AUTH_MISSING", message);
        }
        if (res.status === 404) {
          throw err("E_PROVIDER", message);
        }
        if (res.status === 409) {
          throw err("E_PROVIDER", message);
        }
        const retryable = res.status === 429 || res.status >= 500;
        const shipErr = err("E_PROVIDER", message, retryable);
        if (!shipErr.details) shipErr.details = {};
        (shipErr.details as Record<string, unknown>).status = res.status;
        throw shipErr;
      }

      return { body, text, status: res.status, res };
    } catch (e) {
      if (e instanceof TypeError || (typeof e === "object" && e !== null && (e as Error).name === "TypeError")) {
        throw err("E_PROVIDER", safeMsg("Neon transport error"), true);
      }
      throw e;
    }
  }

  async function listProjectsPaginated(signal?: AbortSignal): Promise<NeonProject[]> {
    const projects: NeonProject[] = [];
    let cursor: string | undefined;
    do {
      const path = cursor ? `/projects?cursor=${encodeURIComponent(cursor)}` : "/projects";
      const { body } = await request("GET", path, { signal });
      const resp = body as { projects: NeonProject[]; cursor?: string } | undefined;
      if (resp?.projects) projects.push(...resp.projects);
      cursor = resp?.cursor;
    } while (cursor);
    return projects;
  }

  async function pollNeonOperation(
    projectId: string,
    operationId: string,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<NeonOperation> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus: string | undefined;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`, { signal });
      const op = body as NeonOperation;
      if (op.status === "finished") return op;
      if (op.status === "failed") {
        const msg = op.error?.message ?? "Neon operation failed";
        throw err("E_PROVIDER", safeMsg(msg));
      }
      if (op.status === "cancelled") {
        throw err("E_CANCELLED", "Neon operation cancelled", true);
      }
      if (op.status !== lastStatus) {
        lastStatus = op.status;
      }
      await delay(pollIntervalMs, signal);
    }

    throw err("E_PROVIDER", "Neon operation timed out", true);
  }

  return {
    async checkAuth(signal) {
      try {
        const { body } = await request("GET", "/users/me", { signal });
        const resp = body as Record<string, unknown> | undefined;
        const accountId = typeof resp?.id === "string" ? resp.id : undefined;
        return { ok: true, accountId };
      } catch (e) {
        if ((e as Record<string, unknown>).code === "E_AUTH_MISSING") {
          return { ok: false };
        }
        throw e;
      }
    },

    async listProjects(signal) {
      return listProjectsPaginated(signal);
    },

    async getProject(projectId, signal) {
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}`, { signal });
      const resp = body as { project: NeonProject } | undefined;
      if (!resp?.project) throw err("E_PROVIDER", safeMsg("Neon project not found in response"));
      return resp.project;
    },

    async createProject(config, signal) {
      const { body } = await request("POST", "/projects", {
        signal,
        body: JSON.stringify(config),
      });
      const resp = body as CreateProjectResponse;
      if (!resp?.project) throw err("E_PROVIDER", safeMsg("Neon create project response missing project"));
      return resp;
    },

    async listBranches(projectId, signal) {
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}/branches`, { signal });
      const resp = body as { branches: NeonBranch[] } | undefined;
      return resp?.branches ?? [];
    },

    async getBranch(projectId, branchId, signal) {
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`, { signal });
      const resp = body as { branch: NeonBranch } | undefined;
      if (!resp?.branch) throw err("E_PROVIDER", safeMsg("Neon branch not found in response"));
      return resp.branch;
    },

    async createBranch(projectId, config, signal) {
      const { body } = await request("POST", `/projects/${encodeURIComponent(projectId)}/branches`, {
        signal,
        body: JSON.stringify(config),
      });
      const resp = body as CreateBranchResponse;
      if (!resp?.branch) throw err("E_PROVIDER", safeMsg("Neon create branch response missing branch"));
      return resp;
    },

    async getConnectionUri(projectId, branchId, databaseName, roleName, signal) {
      const params = new URLSearchParams();
      if (branchId) params.set("branch_id", branchId);
      if (databaseName) params.set("database_name", databaseName);
      if (roleName) params.set("role_name", roleName);
      const qs = params.toString();
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}/connection_uri${qs ? `?${qs}` : ""}`, { signal });
      const resp = body as { connection_uri: string } | undefined;
      if (!resp?.connection_uri) throw err("E_PROVIDER", safeMsg("Neon connection URI not found in response"));
      return resp.connection_uri;
    },

    async listDatabases(projectId, branchId, signal) {
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`, { signal });
      const resp = body as { databases: NeonDatabase[] } | undefined;
      return resp?.databases ?? [];
    },

    async getOperation(projectId, operationId, signal) {
      const { body } = await request("GET", `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`, { signal });
      const op = body as NeonOperation;
      if (!op?.id) throw err("E_PROVIDER", safeMsg("Neon operation not found in response"));
      return op;
    },

    async restoreBranch(projectId, branchId, params, signal) {
      const { body } = await request("POST", `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/restore`, {
        signal,
        body: JSON.stringify(params),
      });
      const resp = body as RestoreBranchResponse;
      if (!resp?.operations) throw err("E_PROVIDER", safeMsg("Neon restore branch response missing operations"));
      return resp;
    },

    async pollOperation(projectId, operationId, timeoutMs, signal) {
      return pollNeonOperation(projectId, operationId, timeoutMs, signal);
    },
  };
}
