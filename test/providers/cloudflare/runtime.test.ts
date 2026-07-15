import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudflareRuntime } from "../../../src/providers/cloudflare/runtime.js";
import { createFakeCloudflareClient } from "../../support/cloudflare-fake.js";
import type { CloudflareClient } from "../../../src/providers/cloudflare/client.js";
import type { CloudflareOperation } from "../../../src/providers/cloudflare/plan.js";

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("CloudflareRuntime", () => {
  function createRuntime(client?: CloudflareClient) {
    const fake = client ?? createFakeCloudflareClient();
    return {
      rt: createCloudflareRuntime({ client: fake, accountId: "test-account-id", cwd: "/tmp/test-cwd" }),
      fake,
    };
  }

  describe("checkAuth", () => {
    it("returns verified account", async () => {
      const { rt } = createRuntime();
      const result = await rt.checkAuth();
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toEqual({ kind: "user", id: "test-account-id" });
      }
    });

    it("returns unverified on error", async () => {
      const fake = createFakeCloudflareClient({
        failures: { checkAuth: () => new Error("network error") },
      });
      const { rt } = createRuntime(fake);
      const result = await rt.checkAuth();
      expect(result.status).toBe("unverified");
    });
  });

  describe("discover", () => {
    it("returns worker snapshot with existing worker", async () => {
      const fake = createFakeCloudflareClient({
        initialWorkers: {
          "my-worker": {
            id: "s1", etag: "e1", handlers: ["fetch"],
            created_on: "2024-01-01", modified_on: "2024-01-01",
          },
        },
      });
      const { rt } = createRuntime(fake);
      const result = await rt.discover({ workerName: "my-worker" });
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.account).toEqual({ kind: "user", id: "test-account-id" });
        expect(result.value.worker.exists).toBe(true);
        expect(result.value.worker.name).toBe("my-worker");
      }
    });

    it("returns snapshot with exists=false when worker absent", async () => {
      const { rt } = createRuntime();
      const result = await rt.discover({ workerName: "nonexistent" });
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.worker.exists).toBe(false);
      }
    });

    it("returns unverified when auth fails", async () => {
      const fake = createFakeCloudflareClient({
        failures: { checkAuth: () => Object.assign(new Error("unauthorized"), { code: "E_AUTH_MISSING" }) },
      });
      const { rt } = createRuntime(fake);
      const result = await rt.discover({ workerName: "my-worker" });
      expect(result.status).toBe("unverified");
    });
  });

  describe("plan", () => {
    it("returns deploy operations", async () => {
      const { rt } = createRuntime();
      const result = await rt.plan("deploy", {
        environment: "production",
        workerName: "my-worker",
        accountId: "acc-123",
        versionId: "v-1",
      }, {
        account: { kind: "user", id: "acc-123" },
        worker: { name: "my-worker", exists: false },
      });

      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toHaveLength(4);
        expect(result.value[0].kind).toBe("ensure_worker");
        expect(result.value[1].kind).toBe("upload_version");
        expect(result.value[2].kind).toBe("set_secrets");
        expect(result.value[3].kind).toBe("deploy");
      }
    });

    it("returns unverified missing_payload when deploy has no versionId", async () => {
      const { rt } = createRuntime();
      const result = await rt.plan("deploy", {
        environment: "production",
        workerName: "my-worker",
        accountId: "acc-123",
      }, {
        account: { kind: "user", id: "acc-123" },
        worker: { name: "my-worker", exists: false },
      });

      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("missing_payload");
      }
    });

    it("returns rollback operations", async () => {
      const { rt } = createRuntime();
      const result = await rt.plan("rollback", {
        environment: "production",
        workerName: "my-worker",
        accountId: "acc-123",
        targetVersionId: "v-abc",
      }, {
        account: { kind: "user", id: "acc-123" },
        worker: { name: "my-worker", exists: true },
      });

      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].kind).toBe("rollback");
      }
    });

    it("returns unverified when rollback has no targetVersionId", async () => {
      const { rt } = createRuntime();
      const result = await rt.plan("rollback", {
        environment: "production",
        workerName: "my-worker",
        accountId: "acc-123",
      }, {
        account: { kind: "user", id: "acc-123" },
        worker: { name: "my-worker", exists: true },
      });

      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("missing_payload");
      }
    });

    it("includes secret names in operations", async () => {
      const { rt } = createRuntime();
      const result = await rt.plan("deploy", {
        environment: "production",
        workerName: "my-worker",
        accountId: "acc-123",
        versionId: "v-1",
        secretNames: ["API_KEY", "DB_URL"],
      }, {
        account: { kind: "user", id: "acc-123" },
        worker: { name: "my-worker", exists: false },
      });

      expect(result.status).toBe("verified");
      if (result.status === "verified" && result.value[2].kind === "set_secrets") {
        expect(result.value[2].secretNames).toEqual(["API_KEY", "DB_URL"]);
      }
    });
  });

  describe("execute", () => {
    describe("ensure_worker", () => {
      it("succeeds when worker already exists", async () => {
        const fake = createFakeCloudflareClient({
          initialWorkers: {
            "my-worker": {
              id: "s1", etag: "e1", handlers: ["fetch"],
              created_on: "2024-01-01", modified_on: "2024-01-01",
            },
          },
        });
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op1",
          provider: "cloudflare",
          kind: "ensure_worker",
          workerName: "my-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.resourceRef).toBe("s1");
        }
      });

      it("creates worker when not found", async () => {
        const fake = createFakeCloudflareClient();
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op2",
          provider: "cloudflare",
          kind: "ensure_worker",
          workerName: "new-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.resourceRef).toBeDefined();
        }
      });

      it("returns readResult on error when checking", async () => {
        const fake = createFakeCloudflareClient({
          failures: { getWorker: () => Object.assign(new Error("not found"), { code: "E_PROVIDER", retryable: false, details: { status: 404 } }) },
        });
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op3",
          provider: "cloudflare",
          kind: "ensure_worker",
          workerName: "error-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("failed");
      });

      it("reads source file from disk and uploads content", async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), "cf-test-"));
        try {
          const sourceContent = 'export default { fetch() { return new Response("hello"); } };';
          await writeFile(join(tmpDir, "my-worker.js"), sourceContent);

          const fake = createFakeCloudflareClient();
          const rt = createCloudflareRuntime({ client: fake, accountId: "test-account-id", cwd: tmpDir });

          const op: CloudflareOperation = {
            operationId: "op-source",
            provider: "cloudflare",
            kind: "ensure_worker",
            workerName: "source-worker",
            accountId: "acc-123",
            targetFingerprint: "tf1",
            requestFingerprint: "rf1",
            expectedStateFingerprint: "esf1",
            dependsOn: [],
            source: "my-worker.js",
          };

          const result = await rt.execute(op, { secretValues: {} });
          expect(result.status).toBe("succeeded");

          expect(fake.uploadedContent.get("source-worker")).toBe(sourceContent);
        } finally {
          await rm(tmpDir, { recursive: true, force: true });
        }
      });
    });

    describe("upload_version", () => {
      it("succeeds and returns version id", async () => {
        const fake = createFakeCloudflareClient();
        const { rt } = createRuntime(fake);
        // Ensure worker exists first
        await fake.uploadWorker("my-worker", {}, "export default {}");
        const op: CloudflareOperation = {
          operationId: "op4",
          provider: "cloudflare",
          kind: "upload_version",
          workerName: "my-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.resourceRef).toBeDefined();
        }
      });
    });

    describe("set_secrets", () => {
      it("succeeds with provided secret values", async () => {
        const fake = createFakeCloudflareClient();
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op5",
          provider: "cloudflare",
          kind: "set_secrets",
          workerName: "my-worker",
          secretNames: ["API_KEY"],
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: { API_KEY: "sk-123" } });
        expect(result.status).toBe("succeeded");
        // Verify secrets were actually written to the fake
        const stored = fake.secrets.get("my-worker");
        expect(stored).toBeDefined();
        expect(stored!.some((s: { name: string }) => s.name === "API_KEY")).toBe(true);
      });

      it("succeeds with empty secret names", async () => {
        const { rt } = createRuntime();
        const op: CloudflareOperation = {
          operationId: "op6",
          provider: "cloudflare",
          kind: "set_secrets",
          workerName: "my-worker",
          secretNames: [],
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
      });

      it("fails when secret value missing", async () => {
        const { rt } = createRuntime();
        const op: CloudflareOperation = {
          operationId: "op7",
          provider: "cloudflare",
          kind: "set_secrets",
          workerName: "my-worker",
          secretNames: ["MISSING_SECRET"],
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.code).toBe("E_PRECONDITION");
        }
      });
    });

    describe("deploy", () => {
      it("succeeds using latest version", async () => {
        const fake = createFakeCloudflareClient();
        const { rt } = createRuntime(fake);
        // Seed a version and capture its actual ID
        const version = await fake.uploadVersion("my-worker", {}, "export default {}");
        const op: CloudflareOperation = {
          operationId: "op8",
          provider: "cloudflare",
          kind: "deploy",
          workerName: "my-worker",
          versionId: version.id,
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.resourceRef).toBeDefined();
          expect(result.providerRequestId).toBeDefined();
        }
      });

      it("falls back to listVersions when versionId is pending", async () => {
        const fake = createFakeCloudflareClient();
        const version = await fake.uploadVersion("my-worker", {}, "export default {}");
        const rt = createCloudflareRuntime({ client: fake, accountId: "test-account-id", cwd: "/tmp/test-cwd", workerName: "my-worker" });
        const op: CloudflareOperation = {
          operationId: "op-pending",
          provider: "cloudflare",
          kind: "deploy",
          workerName: "my-worker",
          versionId: "pending",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.providerRequestId).toBe(version.id);
        }
      });

      it("fails when version not found", async () => {
        const { rt } = createRuntime();
        const op: CloudflareOperation = {
          operationId: "op9",
          provider: "cloudflare",
          kind: "deploy",
          workerName: "no-versions-worker",
          versionId: "v-1",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.code).toBe("E_PROVIDER");
        }
      });
    });

    describe("rollback", () => {
      it("succeeds and creates deployment with target version", async () => {
        const fake = createFakeCloudflareClient();
        // Seed a version so createDeployment validation passes
        const version = await fake.uploadVersion("my-worker", {}, "export default {}");
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op10",
          provider: "cloudflare",
          kind: "rollback",
          workerName: "my-worker",
          targetVersionId: version.id,
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.resourceRef).toBeDefined();
        }
      });
    });

    describe("error classification", () => {
      it("mutationResult: 401 returns failed not_applied", async () => {
        const fake = createFakeCloudflareClient({
          failures: { uploadWorker: () => Object.assign(new Error("unauthorized"), { code: "E_AUTH_MISSING", retryable: false }) },
        });
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op-err",
          provider: "cloudflare",
          kind: "ensure_worker",
          workerName: "new-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        // First call to getWorker will return null (no worker), then uploadWorker fails
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.certainty).toBe("not_applied");
          expect(result.code).toBe("E_AUTH_MISSING");
        }
      });

      it("readResult: 404 returns failed not_applied", async () => {
        const fake = createFakeCloudflareClient({
          failures: { getWorker: () => Object.assign(new Error("not found"), { code: "E_PROVIDER", retryable: false, details: { status: 404 } }) },
        });
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op-err2",
          provider: "cloudflare",
          kind: "ensure_worker",
          workerName: "error-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.certainty).toBe("not_applied");
        }
      });

      it("mutationResult: 429 returns ambiguous rate_limited", async () => {
        const fake = createFakeCloudflareClient({
          failures: { uploadWorker: () => Object.assign(new Error("rate limited"), { code: "E_PROVIDER", details: { status: 429 }, retryable: true }) },
        });
        const { rt } = createRuntime(fake);
        const op: CloudflareOperation = {
          operationId: "op-err3",
          provider: "cloudflare",
          kind: "ensure_worker",
          workerName: "new-worker",
          accountId: "acc-123",
          targetFingerprint: "tf1",
          requestFingerprint: "rf1",
          expectedStateFingerprint: "esf1",
          dependsOn: [],
        };
        const result = await rt.execute(op, { secretValues: {} });
        expect(result.status).toBe("ambiguous");
        if (result.status === "ambiguous") {
          expect(result.reason).toBe("rate_limited");
        }
      });
    });
  });

  describe("reconcile", () => {
    it("ensure_worker: matches when worker exists", async () => {
      const fake = createFakeCloudflareClient({
        initialWorkers: {
          "my-worker": {
            id: "s1", etag: "e1", handlers: ["fetch"],
            created_on: "2024-01-01", modified_on: "2024-01-01",
          },
        },
      });
      const { rt } = createRuntime(fake);
      const op: CloudflareOperation = {
        operationId: "op-rec",
        provider: "cloudflare",
        kind: "ensure_worker",
        workerName: "my-worker",
        accountId: "acc-123",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("matches_expected");
      }
    });

    it("ensure_worker: not_applied when worker absent", async () => {
      const { rt } = createRuntime();
      const op: CloudflareOperation = {
        operationId: "op-rec2",
        provider: "cloudflare",
        kind: "ensure_worker",
        workerName: "nonexistent",
        accountId: "acc-123",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("not_applied");
      }
    });

    it("ensure_worker: conflict when resourceRef provided", async () => {
      const { rt, fake } = createRuntime();
      // Seed a worker so getWorker returns non-null
      await fake.uploadWorker("my-worker", {}, "code");
      const op: CloudflareOperation = {
        operationId: "op-rec3",
        provider: "cloudflare",
        kind: "ensure_worker",
        workerName: "my-worker",
        accountId: "acc-123",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op, "conflict-ref");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("conflict");
      }
    });

    it("upload_version: always unverified (write-only)", async () => {
      const { rt } = createRuntime();
      const op: CloudflareOperation = {
        operationId: "op-rec4",
        provider: "cloudflare",
        kind: "upload_version",
        workerName: "my-worker",
        accountId: "acc-123",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
    });

    it("set_secrets: always unverified (write-only)", async () => {
      const { rt } = createRuntime();
      const op: CloudflareOperation = {
        operationId: "op-rec5",
        provider: "cloudflare",
        kind: "set_secrets",
        workerName: "my-worker",
        secretNames: ["API_KEY"],
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
    });

    it("deploy: matches when deployment exists", async () => {
      const fake = createFakeCloudflareClient();
      const { rt } = createRuntime(fake);
      // Seed a version so createDeployment validation passes
      const version = await fake.uploadVersion("my-worker", {}, "export default {}");
      const deployment = await fake.createDeployment("my-worker", [{ version_id: version.id, percentage: 100 }]);
      const op: CloudflareOperation = {
        operationId: "op-rec6",
        provider: "cloudflare",
        kind: "deploy",
        workerName: "my-worker",
        versionId: version.id,
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op, deployment.id);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("matches_expected");
      }
    });

    it("deploy: not_applied on 404", async () => {
      const fake = createFakeCloudflareClient();
      const { rt } = createRuntime(fake);
      const op: CloudflareOperation = {
        operationId: "op-rec7",
        provider: "cloudflare",
        kind: "deploy",
        workerName: "my-worker",
        versionId: "v1",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      // getDeployment returns null when deployment not in map
      const result = await rt.reconcile(op, "nonexistent-deploy");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("not_applied");
      }
    });

    it("rollback: always unverified (write-only)", async () => {
      const { rt } = createRuntime();
      const op: CloudflareOperation = {
        operationId: "op-rec8",
        provider: "cloudflare",
        kind: "rollback",
        workerName: "my-worker",
        targetVersionId: "v1",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
    });

    it("returns unverified on transport error", async () => {
      const fake = createFakeCloudflareClient({
        failures: { getWorker: () => new TypeError("timeout") },
      });
      const { rt } = createRuntime(fake);
      const op: CloudflareOperation = {
        operationId: "op-rec9",
        provider: "cloudflare",
        kind: "ensure_worker",
        workerName: "error-worker",
        accountId: "acc-123",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op);
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("transport");
      }
    });

    it("deploy: not_applied on 404 via exception", async () => {
      const fake = createFakeCloudflareClient({
        failures: { getDeployment: () => Object.assign(new Error("not found"), { code: "E_PROVIDER", details: { status: 404 }, retryable: false }) },
      });
      const { rt } = createRuntime(fake);
      const op: CloudflareOperation = {
        operationId: "op-rec-ex",
        provider: "cloudflare",
        kind: "deploy",
        workerName: "my-worker",
        versionId: "v1",
        targetFingerprint: "tf1",
        requestFingerprint: "rf1",
        expectedStateFingerprint: "esf1",
        dependsOn: [],
      };
      const result = await rt.reconcile(op, "some-deploy-id");
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value.outcome).toBe("not_applied");
      }
    });
  });

  describe("status", () => {
    it("returns deployed when deployment exists", async () => {
      const fake = createFakeCloudflareClient();
      // Seed a version and deployment so getDeployment succeeds
      const version = await fake.uploadVersion("my-worker", {}, "export default {}");
      const deployment = await fake.createDeployment("my-worker", [{ version_id: version.id, percentage: 100 }]);
      const rt = createCloudflareRuntime({ client: fake, accountId: "test-account-id", cwd: "/tmp/test-cwd", workerName: "my-worker" });
      const result = await rt.status(deployment.id);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toBe("deployed");
      }
    });
  });

  describe("logs", () => {
    // Track mock WebSocket instances for test access
    const mockSockets: Array<{
      url: string;
      onopen: ((event: unknown) => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event: unknown) => void) | null;
      onclose: ((event: unknown) => void) | null;
      close(): void;
      _open(): void;
      _message(data: string): void;
      _error(): void;
    }> = [];

    class MockWebSocket {
      url: string;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        mockSockets.push(this);
      }

      close() {
        // Defer close to let the current execution block finish
        queueMicrotask(() => {
          if (this.onclose) this.onclose({});
        });
      }

      _open() { if (this.onopen) this.onopen({}); }
      _message(data: string) { if (this.onmessage) this.onmessage({ data }); }
      _error() { if (this.onerror) this.onerror({}); }
    }

    let originalWebSocket: typeof globalThis.WebSocket;

    beforeEach(() => {
      originalWebSocket = globalThis.WebSocket;
      globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket;
      mockSockets.length = 0;
    });

    afterEach(() => {
      globalThis.WebSocket = originalWebSocket;
    });

    function createRuntimeWithWorkerName(workerName: string) {
      const fake = createFakeCloudflareClient();
      const rt = createCloudflareRuntime({ client: fake, accountId: "test-account-id", cwd: "/tmp/test-cwd", workerName });
      return { rt, fake };
    }

    it("returns live worker tail with events", async () => {
      const { rt } = createRuntimeWithWorkerName("my-worker");
      const logsPromise = rt.logs("rel-1", { lines: 10, secretValues: [] });

      // Yield to let doLogs create the WebSocket
      await Promise.resolve();

      const ws = mockSockets[0];
      expect(ws).toBeDefined();
      ws._open();
      ws._message(JSON.stringify([{
        outcome: "ok",
        scriptName: "my-worker",
        eventTimestamp: Date.now(),
        logs: [{ message: "hello world", level: "log", timestamp: Date.now() }],
        exceptions: [],
        event: {},
      }]));
      // Close triggers cleanup via onclose
      ws.close();

      const result = await logsPromise;
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toContain("hello world");
        expect(result.value).toContain("[log]");
      }
    });

    it("tail cleanup on abort", async () => {
      const { rt, fake } = createRuntimeWithWorkerName("abort-worker");
      const ac = new AbortController();
      const logsPromise = rt.logs("rel-2", { lines: 10, secretValues: [] }, ac.signal);

      await Promise.resolve();

      const ws = mockSockets[0];
      expect(ws).toBeDefined();
      ws._open();
      // Abort triggers abort handler -> ws.close() -> onclose -> resolve
      ac.abort();

      const result = await logsPromise;
      expect(result.status).toBe("verified");
      // Tail should be deleted even on abort
      expect(fake.calls.some((c) => c.method === "deleteTail")).toBe(true);
    });

    it("tail cleanup on error", async () => {
      const fake = createFakeCloudflareClient({
        failures: { createTail: () => new Error("tail creation failed") },
      });
      const rt = createCloudflareRuntime({ client: fake, accountId: "test-account-id", cwd: "/tmp/test-cwd", workerName: "err-worker" });

      const result = await rt.logs("rel-3", { lines: 10, secretValues: [] });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("transport");
      }
    });

    it("empty logs when no messages received", async () => {
      const { rt } = createRuntimeWithWorkerName("silent-worker");
      const logsPromise = rt.logs("rel-4", { lines: 10, secretValues: [] });

      await Promise.resolve();

      const ws = mockSockets[0];
      expect(ws).toBeDefined();
      ws._open();
      ws.close();

      const result = await logsPromise;
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.value).toContain("No log messages");
      }
    });
  });
});
