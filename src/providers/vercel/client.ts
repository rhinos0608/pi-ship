import { createHash } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";
import { redact } from "../../core/redact.js";
import type {
  VercelClientConfig,
  BackoffFn,
  UserResponse,
  ListProjectsResponse,
  Project,
  CreateProjectRequest,
  EnvVarInput,
  CreateEnvResponse,
  UploadFileResponse,
  Deployment,
  CreateDeploymentRequest,
  BuildEvent,
  RuntimeLogEntry,
} from "./types.js";
import {
  UserResponseSchema,
  ListProjectsResponseSchema,
  ProjectSchema,
  CreateEnvResponseSchema,
  UploadFileResponseSchema,
  DeploymentSchema,
  BuildEventSchema,
  RuntimeLogEntrySchema,
} from "./types.js";

// ── SHA1 hex regex ──────────────────────────────────────────────────────────────
const HEX_40_RE = /^[0-9a-f]{40}$/;

// ── Fetch type ──────────────────────────────────────────────────────────────────
export interface VercelFetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

// ── Client interface ────────────────────────────────────────────────────────────
export interface VercelClient {
  /** GET /v2/user – verify auth token */
  checkAuth(signal?: AbortSignal): Promise<UserResponse>;
  /** GET /v10/projects?search=… – list projects */
  listProjects(search?: string, signal?: AbortSignal): Promise<ListProjectsResponse>;
  /**
   * Discover a single project by exact name match.
   * Uses GET /v10/projects?search=… internally — does NOT use an unverified single-project path.
   * Returns null when project not found.
   */
  findProject(name: string, signal?: AbortSignal): Promise<Project | null>;
  /** POST /v11/projects – create project */
  createProject(body: CreateProjectRequest, signal?: AbortSignal): Promise<Project>;
  /** POST /v10/projects/{idOrName}/env?upsert=true – upsert sensitive env var */
  upsertEnv(
    projectIdOrName: string,
    env: EnvVarInput,
    signal?: AbortSignal
  ): Promise<CreateEnvResponse>;
  /**
   * POST /v2/files – upload raw bytes with SHA1 digest.
   * sha1 must be lowercase 40-char hex string matching content.
   */
  uploadFile(sha1: string, content: Uint8Array, signal?: AbortSignal): Promise<UploadFileResponse>;
  /** POST /v13/deployments – create deployment */
  createDeployment(body: CreateDeploymentRequest, signal?: AbortSignal): Promise<Deployment>;
  /** GET /v13/deployments/{id} – get deployment */
  getDeployment(id: string, signal?: AbortSignal): Promise<Deployment>;
  /** GET /v3/deployments/{idOrUrl}/events – build events */
  getBuildEvents(idOrUrl: string, signal?: AbortSignal): Promise<BuildEvent[]>;
  /**
   * GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs – runtime logs.
   * Supports JSON array response and newline-delimited JSON stream.
   * Malformed NDJSON lines produce E_PROVIDER (not silently skipped).
   */
  getRuntimeLogs(
    projectId: string,
    deploymentId: string,
    signal?: AbortSignal
  ): Promise<RuntimeLogEntry[]>;
  /** PATCH /v12/deployments/{id}/cancel – cancel deployment */
  cancelDeployment(id: string, signal?: AbortSignal): Promise<Deployment>;
  /**
   * POST /v1/projects/{projectId}/rollback/{deploymentId} – rollback.
   * Accepts empty 201 or object body without trusting content.
   */
  rollback(
    projectId: string,
    deploymentId: string,
    description?: string,
    signal?: AbortSignal
  ): Promise<void>;
}

// ── Default backoff ─────────────────────────────────────────────────────────────
function defaultBackoff(attempt: number, retryAfter?: number | null): number {
  if (retryAfter != null && retryAfter > 0 && Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }
  // Exponential: 1s, 2s, 4s, 8s … capped at 30s with ±25% jitter
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Error extraction from Vercel error bodies ───────────────────────────────────
function extractVercelErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  // Common patterns: { error: { message } } or { message }
  if (b.error && typeof b.error === "object") {
    const msg = (b.error as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  if (typeof b.message === "string") return b.message;
  return undefined;
}

// ── Input validation ────────────────────────────────────────────────────────────
function validateConfig(config: VercelClientConfig): void {
  if (!config.token || typeof config.token !== "string") {
    throw err("E_CONFIG_INVALID", "Vercel client token is required and must be nonempty");
  }
  if (config.teamId !== undefined && !config.teamId) {
    throw err("E_CONFIG_INVALID", "Vercel teamId must be nonempty when provided");
  }
  if (config.maxRetries !== undefined) {
    if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
      throw err("E_CONFIG_INVALID", "Vercel maxRetries must be a nonnegative integer");
    }
  }
}

function validateUploadInput(sha1: string, content: Uint8Array): void {
  if (!content || content.length === 0) {
    throw err("E_CONFIG_INVALID", "Vercel upload content must be nonempty");
  }
  if (!HEX_40_RE.test(sha1)) {
    throw err("E_CONFIG_INVALID", "Vercel upload sha1 must be a lowercase 40-character hex string");
  }
  const computed = createHash("sha1").update(content).digest("hex");
  if (computed !== sha1) {
    throw err("E_CONFIG_INVALID", "Vercel upload sha1 does not match content");
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────────
export function createVercelClient(
  config: VercelClientConfig,
  fetchImpl: VercelFetchLike = fetch
): VercelClient {
  validateConfig(config);

  const baseUrl = (config.baseUrl ?? "https://api.vercel.com").replace(/\/+$/, "");
  const teamId = config.teamId;
  const maxRetries = config.maxRetries ?? 3;
  const backoffFn = config.backoff ?? defaultBackoff;
  // Secrets for redaction — never expose token or env values in errors
  const secretValues = [config.token];

  // ── URL builder ──────────────────────────────────────────────────────────
  function buildUrl(path: string, extraQuery?: Record<string, string | undefined>): string {
    const url = new URL(path, baseUrl);
    if (teamId) url.searchParams.set("teamId", teamId);
    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  // ── Safe error message ───────────────────────────────────────────────────
  function safeMsg(text: string): string {
    return redact(text, ["VERCEL_API_TOKEN"], secretValues);
  }

  // ── Parse response body ──────────────────────────────────────────────────
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
    // Non-JSON: return text as body
    return { body: text, text };
  }

  // ── Core request ──────────────────────────────────────────────────────────
  async function request(
    method: string,
    path: string,
    opts: {
      headers?: Record<string, string>;
      body?: BodyInit | null;
      query?: Record<string, string | undefined>;
      /** Allow retry on 429/5xx for safe idempotent ops */
      safe?: boolean;
      signal?: AbortSignal;
      /** Extra secret values to redact from error messages */
      secrets?: string[];
    } = {}
  ): Promise<{ body: unknown; text: string; status: number; res: Response }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      ...opts.headers,
    };
    const url = buildUrl(path, opts.query);
    // Merge extra secrets for error redaction
    const effectiveSecrets = opts.secrets
      ? [...secretValues, ...opts.secrets]
      : secretValues;
    const requestSafeMsg = (text: string): string =>
      redact(text, ["VERCEL_API_TOKEN"], effectiveSecrets);
    let lastError: unknown;

    for (let attempt = 0; attempt <= (opts.safe ? maxRetries : 0); attempt++) {
      try {
        const res = await fetchImpl(url, {
          method,
          headers,
          body: opts.body ?? null,
          signal: opts.signal,
        });

        const { body, text } = await parseBody(res);

        if (!res.ok) {
          // Use effective secrets for error redaction
          const error = (() => {
            let message: string;
            const extracted = extractVercelErrorMessage(body);
            if (extracted) {
              message = requestSafeMsg(extracted);
            } else {
              message = requestSafeMsg(`Vercel API error (HTTP ${res.status})`);
            }
            if (res.status === 401 || res.status === 403) {
              return err("E_AUTH_MISSING", message);
            }
            if (res.status === 404) {
              return err("E_PROVIDER", message);
            }
            if (res.status === 409) {
              return err("E_PROVIDER", message);
            }
            const retryable = res.status === 429 || res.status >= 500;
            return err("E_PROVIDER", message, retryable);
          })();
          const withStatus = (shipErr: ReturnType<typeof err>): ReturnType<typeof err> => {
            if (!shipErr.details) shipErr.details = {};
            (shipErr.details as Record<string, unknown>).status = res.status;
            return shipErr;
          };
          const typedError = withStatus(error);
          if (opts.safe && (res.status === 429 || res.status >= 500) && attempt < maxRetries) {
            // Retry
            const retryAfterHeader = res.headers.get("Retry-After");
            const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;
            const waitMs = backoffFn(attempt, Number.isFinite(retryAfter) && retryAfter! > 0 ? retryAfter : null);
            await delay(waitMs);
            lastError = typedError;
            continue;
          }
          throw typedError;
        }

        return { body, text, status: res.status, res };
      } catch (e) {
        // Transport / abort errors
        if (e instanceof TypeError || (typeof e === "object" && e !== null && (e as Error).name === "TypeError")) {
          // Network error — retry if safe
          if (opts.safe && attempt < maxRetries) {
            const waitMs = backoffFn(attempt, null);
            await delay(waitMs);
            lastError = err("E_PROVIDER", safeMsg("Vercel transport error"), true);
            continue;
          }
          throw err("E_PROVIDER", safeMsg("Vercel transport error"), true);
        }
        throw e;
      }
    }

    // Exhausted retries
    if (lastError) throw lastError;
    throw err("E_PROVIDER", safeMsg("request failed after retries"));
  }

  // ── Validate response body with Typebox ────────────────────────────────────
  function validate<T extends TSchema>(
    schema: T,
    data: unknown,
    label: string,
  ): Static<T> {
    if (!Value.Check(schema, data)) {
      throw err("E_PROVIDER", safeMsg(`Vercel ${label} response validation failed`));
    }
    return data;
  }

  // ── Shared implementation for list/find ──────────────────────────────────
  async function _listProjects(
    search?: string,
    signal?: AbortSignal
  ): Promise<ListProjectsResponse> {
    const { body } = await request("GET", "/v10/projects", {
      safe: true,
      signal,
      query: search ? { search } : undefined,
    });

    // Accept both direct array (normalize) and wrapper object
    if (Array.isArray(body)) {
      return { projects: body.map((item) => validate(ProjectSchema, item, "project")), pagination: undefined };
    }
    return validate(ListProjectsResponseSchema, body, "list-projects");
  }

  // ── Build events: validate each item ─────────────────────────────────────
  function validateBuildEvent(item: unknown): BuildEvent {
    return validate(BuildEventSchema, item, "build-event");
  }

  // ── Runtime log entry: validate each item ────────────────────────────────
  function validateRuntimeLogEntry(item: unknown): RuntimeLogEntry {
    return validate(RuntimeLogEntrySchema, item, "runtime-log-entry");
  }

  // ── Build client ───────────────────────────────────────────────────────────

  return {
    async checkAuth(signal) {
      const { body } = await request("GET", "/v2/user", { safe: true, signal });
      return validate(UserResponseSchema, body, "auth/user");
    },

    async listProjects(search, signal) {
      return _listProjects(search, signal);
    },

    async findProject(name, signal) {
      const resp = await _listProjects(name, signal);
      const exact = resp.projects.find((p: Project) => p.name === name);
      return exact ?? null;
    },

    async createProject(body, signal) {
      const { body: responseBody } = await request("POST", "/v11/projects", {
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return validate(ProjectSchema, responseBody, "create-project");
    },

    async upsertEnv(projectIdOrName, env, signal) {
      const { body } = await request("POST", `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`, {
        signal,
        query: { upsert: "true" },
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(env),
        secrets: [env.value],
      });
      return validate(CreateEnvResponseSchema, body, "upsert-env");
    },

    async uploadFile(sha1, content, signal) {
      validateUploadInput(sha1, content);
      const { body } = await request("POST", "/v2/files", {
        safe: true,
        signal,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-vercel-digest": sha1,
          "Content-Length": String(content.length),
        },
        body: content as BodyInit,
      });
      return validate(UploadFileResponseSchema, body, "upload-file");
    },

    async createDeployment(body, signal) {
      const { body: responseBody } = await request("POST", "/v13/deployments", {
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return validate(DeploymentSchema, responseBody, "create-deployment");
    },

    async getDeployment(id, signal) {
      const { body } = await request("GET", `/v13/deployments/${encodeURIComponent(id)}`, {
        safe: true,
        signal,
      });
      return validate(DeploymentSchema, body, "get-deployment");
    },

    async getBuildEvents(idOrUrl, signal) {
      const { body } = await request("GET", `/v3/deployments/${encodeURIComponent(idOrUrl)}/events`, {
        safe: true,
        signal,
      });
      if (!Array.isArray(body)) {
        throw err("E_PROVIDER", safeMsg("Vercel build events response is not an array"));
      }
      return body.map((item: unknown) => validateBuildEvent(item));
    },

    async getRuntimeLogs(projectId, deploymentId, signal) {
      const { body, text } = await request(
        "GET",
        `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs`,
        { safe: true, signal }
      );

      // Support both JSON array and newline-delimited JSON stream
      if (Array.isArray(body)) {
        return body.map((item: unknown) => validateRuntimeLogEntry(item));
      }

      // If body is a string (stream/newline JSON), split and parse each line
      if (typeof body === "string" && body.length > 0) {
        const lines = body.split("\n").filter((l) => l.trim().length > 0);
        const entries: RuntimeLogEntry[] = [];
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            throw err("E_PROVIDER", safeMsg("Vercel runtime logs: malformed NDJSON line"));
          }
          entries.push(validateRuntimeLogEntry(parsed));
        }
        return entries;
      }

      // If body is undefined/empty, return empty array
      return [];
    },

    async cancelDeployment(id, signal) {
      const { body } = await request("PATCH", `/v12/deployments/${encodeURIComponent(id)}/cancel`, {
        signal,
      });
      return validate(DeploymentSchema, body, "cancel-deployment");
    },

    async rollback(projectId, deploymentId, description, signal) {
      await request("POST", `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`, {
        signal,
        query: description ? { description } : undefined,
      });
      // Accept empty 201 or any body — no validation
    },
  };
}
