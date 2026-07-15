import { err } from "../../core/errors.js";
import { redact } from "../../core/redact.js";
import type { CloudflareClientConfig, CloudflareResponse, TailCreateResponse, Script, Version, Deployment, Secret } from "./types.js";

// ── Default base URL ───────────────────────────────────────────────────────
const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

// ── Helpers ─────────────────────────────────────────────────────────────────

function encodePath(segment: string): string {
  return encodeURIComponent(segment);
}

// ── Client interface ────────────────────────────────────────────────────────
export interface CloudflareClient {
  checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; accountId: string }>;
  listWorkers(signal?: AbortSignal): Promise<Script[]>;
  getWorker(name: string, signal?: AbortSignal): Promise<Script | null>;
  uploadWorker(name: string, metadata: Record<string, unknown>, scriptContent: string, signal?: AbortSignal): Promise<Script>;
  uploadVersion(name: string, metadata: Record<string, unknown>, scriptContent: string, signal?: AbortSignal): Promise<Version>;
  listVersions(name: string, signal?: AbortSignal): Promise<Version[]>;
  getVersion(name: string, versionId: string, signal?: AbortSignal): Promise<Version>;
  listDeployments(name: string, signal?: AbortSignal): Promise<Deployment[]>;
  createDeployment(name: string, versions: Array<{ version_id: string; percentage: number }>, force?: boolean, signal?: AbortSignal): Promise<Deployment>;
  getDeployment(name: string, deploymentId: string, signal?: AbortSignal): Promise<Deployment>;
  listSecrets(name: string, signal?: AbortSignal): Promise<Secret[]>;
  putSecret(name: string, secretName: string, value: string, signal?: AbortSignal): Promise<void>;
  deleteSecret(name: string, secretName: string, signal?: AbortSignal): Promise<void>;
  bulkSecrets(name: string, operations: Array<{ name: string; type: "secret_text"; value: string }>, signal?: AbortSignal): Promise<void>;

  // ── Tail API (Workers Tail) ──────────────────────────────────────────
  createTail(scriptName: string, signal?: AbortSignal): Promise<TailCreateResponse>;
  deleteTail(scriptName: string, tailId: string, signal?: AbortSignal): Promise<void>;
  listTails(scriptName: string, signal?: AbortSignal): Promise<Array<{ id: string; expires_at: string; url: string }>>;
}

// ── Factory ─────────────────────────────────────────────────────────────────
export function createCloudflareClient(
  config: CloudflareClientConfig,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): CloudflareClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const secretValues: string[] = [config.apiToken, config.accountId];

  function safeMsg(text: string): string {
    return redact(text, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], secretValues);
  }

  async function parseCloudflareResponse<T>(
    response: Response,
    context: string,
    extraSecrets: string[] = [],
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      throw err("E_PROVIDER", safeMsg(`${context}: invalid JSON response`));
    }
    const wrapper = body as CloudflareResponse<T>;
    if (!wrapper || typeof wrapper !== "object") {
      throw err("E_PROVIDER", safeMsg(`${context}: malformed response`));
    }
    if (!wrapper.success) {
      const firstError = wrapper.errors?.[0];
      const message = firstError ? `${firstError.code}: ${firstError.message}` : "unknown error";
      const status = response.status;
      const shipErr = err(
        status === 401 ? "E_AUTH_MISSING"
          : status === 403 ? "E_AUTH_MISSING"
          : status === 404 ? "E_PROVIDER"
          : status === 429 ? "E_PROVIDER"
          : status >= 500 ? "E_PROVIDER"
          : "E_PROVIDER",
        redact(`${context}: ${message}`, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], [...secretValues, ...extraSecrets]),
        status === 429 || status >= 500,
      );
      shipErr.details = { status, ...(firstError ? { code: firstError.code } : {}) };
      throw shipErr;
    }
    return wrapper.result as T;
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
  };

  async function request<T>(
    method: string,
    path: string,
    options: {
      signal?: AbortSignal;
      body?: BodyInit;
      contentType?: string;
      secrets?: string[];
    } = {},
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const reqHeaders: Record<string, string> = { ...headers };
    if (options.contentType) {
      reqHeaders["Content-Type"] = options.contentType;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: reqHeaders,
        body: options.body,
        signal: options.signal,
      });
    } catch (cause: unknown) {
      if (cause instanceof TypeError) {
        throw err("E_PROVIDER", safeMsg(`${method} ${path}: transport error`), true);
      }
      throw cause;
    }
    if (response.status === 204) return undefined as T;
    return parseCloudflareResponse<T>(response, `${method} ${path}`, options.secrets ?? []);
  }

  return {
    async checkAuth(signal) {
      // Verify token by calling /user/tokens/verify
      const resp = await fetchImpl(`${baseUrl}/user/tokens/verify`, {
        method: "GET",
        headers,
        signal,
      });
      await parseCloudflareResponse<unknown>(resp, "GET /user/tokens/verify");
      return { ok: true, accountId: config.accountId };
    },

    async listWorkers(signal) {
      return request<Script[]>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts`, { signal });
    },

    async getWorker(name, signal) {
      try {
        return await request<Script>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}`, { signal });
      } catch (e: unknown) {
        if ((e as Record<string, unknown>)?.code === "E_PROVIDER") {
          const details = (e as Record<string, unknown>)?.details as Record<string, unknown> | undefined;
          if (details?.status === 404) return null;
        }
        throw e;
      }
    },

    async uploadWorker(name, metadata, scriptContent, signal) {
      // Multipart PUT: metadata part + script part
      const boundary = `boundary-${Date.now()}`;
      const metadataJson = JSON.stringify(metadata);

      const parts: string[] = [];
      const push = (text: string) => parts.push(text);

      push(`--${boundary}\r\n`);
      push('Content-Disposition: form-data; name="metadata"\r\n');
      push("Content-Type: application/json\r\n\r\n");
      push(`${metadataJson}\r\n`);
      push(`--${boundary}\r\n`);
      const mainModule = (metadata as { main_module?: string }).main_module ?? "script";
      push(`Content-Disposition: form-data; name="${mainModule}"\r\n`);
      push("Content-Type: application/javascript+module\r\n\r\n");
      push(scriptContent);
      push(`\r\n--${boundary}--\r\n`);

      return request<Script>("PUT", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}`, {
        signal,
        body: parts.join(""),
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
    },

    async uploadVersion(name, metadata, scriptContent, signal) {
      // Multipart POST: metadata part + script part
      const boundary = `boundary-${Date.now()}`;
      const versionMetadata = { ...metadata, main_module: "main.js" };
      const metadataJson = JSON.stringify(versionMetadata);

      const parts: string[] = [];
      const push = (text: string) => parts.push(text);

      push(`--${boundary}\r\n`);
      push('Content-Disposition: form-data; name="metadata"\r\n');
      push("Content-Type: application/json\r\n\r\n");
      push(`${metadataJson}\r\n`);
      push(`--${boundary}\r\n`);
      const scriptPartName = versionMetadata.main_module;
      push(`Content-Disposition: form-data; name="${scriptPartName}"\r\n`);
      push("Content-Type: application/javascript+module\r\n\r\n");
      push(scriptContent);
      push(`\r\n--${boundary}--\r\n`);

      return request<Version>("POST", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/versions`, {
        signal,
        body: parts.join(""),
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
    },

    async listVersions(name, signal) {
      return request<Version[]>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/versions`, { signal });
    },

    async getVersion(name, versionId, signal) {
      return request<Version>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/versions/${encodePath(versionId)}`, { signal });
    },

    async listDeployments(name, signal) {
      return request<Deployment[]>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/deployments`, { signal });
    },

    async createDeployment(name, versions, force, signal) {
      const body: Record<string, unknown> = { strategy: "percentage", versions };
      const query = force ? "?force=true" : "";
      return request<Deployment>("POST", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/deployments${query}`, {
        signal,
        body: JSON.stringify(body),
      });
    },

    async getDeployment(name, deploymentId, signal) {
      return request<Deployment>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/deployments/${encodePath(deploymentId)}`, { signal });
    },

    async listSecrets(name, signal) {
      return request<Secret[]>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/secrets`, { signal });
    },

    async putSecret(name, secretName, value, signal) {
      await request<unknown>("PUT", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/secrets`, {
        signal,
        body: JSON.stringify({ name: secretName, type: "secret_text", text: value }),
        secrets: [value],
      });
    },

    async deleteSecret(name, secretName, signal) {
      await request<unknown>("DELETE", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/secrets/${encodePath(secretName)}`, { signal });
    },

    async bulkSecrets(name, operations, signal) {
      // Cloudflare JSON Merge Patch schema: map keyed by secret name,
      // each value is { name, type, text }.
      const body: Record<string, { name: string; type: "secret_text"; text: string }> = {};
      for (const op of operations) {
        body[op.name] = { name: op.name, type: "secret_text", text: op.value };
      }
      await request<unknown>("PATCH", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(name)}/secrets-bulk`, {
        signal,
        body: JSON.stringify(body),
        secrets: operations.map((op) => op.value),
      });
    },

    async createTail(scriptName, signal) {
      return request<TailCreateResponse>("POST", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(scriptName)}/tails`, { signal });
    },

    async deleteTail(scriptName, tailId, signal) {
      await request<unknown>("DELETE", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(scriptName)}/tails/${encodePath(tailId)}`, { signal });
    },

    async listTails(scriptName, signal) {
      return request<Array<{ id: string; expires_at: string; url: string }>>("GET", `/accounts/${encodePath(config.accountId)}/workers/scripts/${encodePath(scriptName)}/tails`, { signal });
    },
  };
}
