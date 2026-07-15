import type { CloudflareClient } from "../../src/providers/cloudflare/client.js";
import type { Script, Version, Deployment, Secret, TailCreateResponse } from "../../src/providers/cloudflare/types.js";

export interface FakeCall {
  method: string;
  args: unknown[];
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(16).padStart(8, "0")}`;
}

type ErrorFactory = () => Error;

export function createFakeCloudflareClient(config?: {
  initialWorkers?: Record<string, Script>;
  initialVersions?: Record<string, Version[]>;
  initialDeployments?: Record<string, Deployment[]>;
  initialSecrets?: Record<string, Secret[]>;
  failures?: Partial<Record<keyof CloudflareClient, ErrorFactory>>;
}): CloudflareClient & {
  calls: FakeCall[];
  workers: Map<string, Script>;
  versions: Map<string, Version[]>;
  deployments: Map<string, Deployment[]>;
  uploadedContent: Map<string, string>;
  secrets: Map<string, Secret[]>;
  injectFailure(method: keyof CloudflareClient, error: Error): void;
  clearFailures(): void;
} {
  const workers = new Map(Object.entries(config?.initialWorkers ?? {}));
  const versions = new Map(Object.entries(config?.initialVersions ?? {}));
  const deployments = new Map(Object.entries(config?.initialDeployments ?? {}));
  const secrets = new Map(Object.entries(config?.initialSecrets ?? {}));
  const failures: Partial<Record<keyof CloudflareClient, ErrorFactory>> = { ...config?.failures };
  const calls: FakeCall[] = [];
  const uploadedContent = new Map<string, string>();
  const tails = new Map<string, Array<{ id: string; expires_at: string; url: string }>>();

  function maybeFail(method: keyof CloudflareClient): void {
    const factory = failures[method];
    if (factory) throw factory();
  }

  function record(method: string, args: unknown[]): void {
    calls.push({ method, args: args.map((a) => (typeof a === "function" ? "<function>" : a)) });
  }

  return {
    calls,
    workers,
    versions,
    deployments,
    uploadedContent,
    secrets,

    injectFailure(method, error) {
      failures[method] = () => error;
    },

    clearFailures() {
      for (const key of Object.keys(failures)) {
        delete failures[key as keyof CloudflareClient];
      }
    },

    async checkAuth(signal) {
      record("checkAuth", []);
      maybeFail("checkAuth");
      return { ok: true, accountId: "test-account-id" };
    },

    async listWorkers(signal) {
      record("listWorkers", []);
      maybeFail("listWorkers");
      return Array.from(workers.values());
    },

    async getWorker(name, signal) {
      record("getWorker", [name]);
      maybeFail("getWorker");
      return workers.get(name) ?? null;
    },

    async uploadWorker(name, metadata, scriptContent, signal) {
      record("uploadWorker", [name, metadata]);
      maybeFail("uploadWorker");
      const id = uid("script");
      const script: Script = {
        id,
        etag: uid("etag"),
        handlers: ["fetch"],
        created_on: new Date().toISOString(),
        modified_on: new Date().toISOString(),
      };
      workers.set(name, script);
      uploadedContent.set(name, scriptContent);
      return script;
    },

    async uploadVersion(name, metadata, scriptContent, signal) {
      record("uploadVersion", [name, metadata]);
      maybeFail("uploadVersion");
      const version: Version = {
        id: uid("version"),
        number: ((versions.get(name)?.length ?? 0) + 1),
        metadata: { author_email: "test@test.com", source: "pi-ship" },
      };
      const existing = versions.get(name) ?? [];
      existing.push(version);
      versions.set(name, existing);
      return version;
    },

    async listVersions(name, signal) {
      record("listVersions", [name]);
      maybeFail("listVersions");
      const v = versions.get(name) ?? [];
      // Return newest-first (reverse chronological)
      return [...v].reverse();
    },

    async getVersion(name, versionId, signal) {
      record("getVersion", [name, versionId]);
      maybeFail("getVersion");
      const v = (versions.get(name) ?? []).find((v) => v.id === versionId);
      if (!v) throw Object.assign(new Error("version not found"), { code: "E_PROVIDER", details: { status: 404 } });
      return v;
    },

    async listDeployments(name, signal) {
      record("listDeployments", [name]);
      maybeFail("listDeployments");
      return deployments.get(name) ?? [];
    },

    async createDeployment(name, versionRefs, force, signal) {
      record("createDeployment", [name, versionRefs, force]);
      maybeFail("createDeployment");
      // Validate every versionRef against registered versions for this worker
      const workerVersions = versions.get(name) ?? [];
      const workerVersionIds = new Set(workerVersions.map((v: Version) => v.id));
      for (const ref of versionRefs) {
        if (!workerVersionIds.has(ref.version_id)) {
          throw Object.assign(new Error(`version ${ref.version_id} not found for worker ${name}`), {
            code: "E_PROVIDER",
            details: { status: 404 },
            retryable: false,
          });
        }
      }
      const deployment: Deployment = {
        id: uid("deploy"),
        created_on: new Date().toISOString(),
        source: "pi-ship",
        strategy: "percentage",
        versions: versionRefs.map((vr) => ({ version_id: vr.version_id, percentage: vr.percentage })),
      };
      const existing = deployments.get(name) ?? [];
      existing.push(deployment);
      deployments.set(name, existing);
      return deployment;
    },

    async getDeployment(name, deploymentId, signal) {
      record("getDeployment", [name, deploymentId]);
      maybeFail("getDeployment");
      const d = (deployments.get(name) ?? []).find((d) => d.id === deploymentId);
      if (!d) throw Object.assign(new Error("deployment not found"), { code: "E_PROVIDER", details: { status: 404 }, retryable: false });
      return d;
    },

    async listSecrets(name, signal) {
      record("listSecrets", [name]);
      maybeFail("listSecrets");
      return secrets.get(name) ?? [];
    },

    async putSecret(name, secretName, value, signal) {
      record("putSecret", [name, secretName]);
      maybeFail("putSecret");
      const existing = secrets.get(name) ?? [];
      const idx = existing.findIndex((s) => s.name === secretName);
      const secret: Secret = { name: secretName, type: "secret_text" };
      if (idx >= 0) {
        existing[idx] = secret;
      } else {
        existing.push(secret);
      }
      secrets.set(name, existing);
    },

    async deleteSecret(name, secretName, signal) {
      record("deleteSecret", [name, secretName]);
      maybeFail("deleteSecret");
      const existing = secrets.get(name) ?? [];
      secrets.set(name, existing.filter((s) => s.name !== secretName));
    },

    async bulkSecrets(name, operations, signal) {
      record("bulkSecrets", [name, operations.length]);
      maybeFail("bulkSecrets");
      const existing = secrets.get(name) ?? [];
      for (const op of operations) {
        const idx = existing.findIndex((s) => s.name === op.name);
        const secret: Secret = { name: op.name, type: "secret_text" };
        if (idx >= 0) {
          existing[idx] = secret;
        } else {
          existing.push(secret);
        }
      }
      secrets.set(name, existing);
    },

    async createTail(scriptName, signal) {
      record("createTail", [scriptName]);
      maybeFail("createTail");
      const id = uid("tail");
      const tail = {
        id,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        url: `ws://fake-tail.cloudflare.test/${id}`,
      };
      const existing = tails.get(scriptName) ?? [];
      existing.push(tail);
      tails.set(scriptName, existing);
      return tail;
    },

    async deleteTail(scriptName, tailId, signal) {
      record("deleteTail", [scriptName, tailId]);
      maybeFail("deleteTail");
      const existing = tails.get(scriptName) ?? [];
      tails.set(scriptName, existing.filter((t) => t.id !== tailId));
    },

    async listTails(scriptName, signal) {
      record("listTails", [scriptName]);
      maybeFail("listTails");
      return tails.get(scriptName) ?? [];
    },
  };
}
