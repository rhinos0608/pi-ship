import { describe, expect, it } from "vitest";
import {
  buildCloudflareOperations,
  computeCloudflarePlanDigest,
  isCloudflarePlan,
} from "../../../src/providers/cloudflare/plan.js";

describe("CloudflarePlan", () => {
  describe("buildCloudflareOperations", () => {
    it("produces correct deploy operation chain", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
        secretNames: ["API_KEY"],
        source: "src/index.ts",
      });

      expect(ops).toHaveLength(4);
      expect(ops[0].kind).toBe("ensure_worker");
      expect(ops[1].kind).toBe("upload_version");
      expect(ops[2].kind).toBe("set_secrets");
      expect(ops[3].kind).toBe("deploy");
    });

    it("sets dependsOn chain correctly", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
        secretNames: ["API_KEY"],
      });

      expect(ops[0].dependsOn).toEqual([]);
      expect(ops[1].dependsOn).toEqual([ops[0].operationId]);
      expect(ops[2].dependsOn).toEqual([ops[1].operationId]);
      expect(ops[3].dependsOn).toEqual([ops[2].operationId]);
    });

    it("produces rollback operation for rollback intent", () => {
      const ops = buildCloudflareOperations("rollback", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
        targetVersionId: "v-abc",
      });

      expect(ops).toHaveLength(1);
      expect(ops[0].kind).toBe("rollback");
      expect(ops[0].workerName).toBe("my-worker");
      if (ops[0].kind === "rollback") {
        expect(ops[0].targetVersionId).toBe("v-abc");
      }
    });

    it("throws when rollback has no targetVersionId", () => {
      expect(() =>
        buildCloudflareOperations("rollback", "production", {
          workerName: "my-worker",
          accountId: "acc-123",
        })
      ).toThrow();
    });

    it("sets versionId on deploy operation when provided", () => {
      const ops = buildCloudflareOperations("deploy", "preview", {
        workerName: "my-worker",
        accountId: "acc-123",
        versionId: "v-1",
      });

      expect(ops[3].kind).toBe("deploy");
      if (ops[3].kind === "deploy") {
        expect(ops[3].versionId).toBe("v-1");
      }
    });

    it("defaults versionId to 'pending' when not provided", () => {
      const ops = buildCloudflareOperations("deploy", "preview", {
        workerName: "my-worker",
        accountId: "acc-123",
      });

      expect(ops[3].kind).toBe("deploy");
      if (ops[3].kind === "deploy") {
        expect(ops[3].versionId).toBe("pending");
      }
    });

    it("includes source on ensure_worker and upload_version when provided", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
        source: "src/index.ts",
      });

      expect(ops[0].kind).toBe("ensure_worker");
      expect(ops[0]).toHaveProperty("source", "src/index.ts");
      expect(ops[1].kind).toBe("upload_version");
      expect(ops[1]).toHaveProperty("source", "src/index.ts");
    });

    it("omits secrets when empty", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });

      expect(ops[2].kind).toBe("set_secrets");
      if (ops[2].kind === "set_secrets") {
        expect(ops[2].secretNames).toEqual([]);
      }
    });
  });

  describe("computeCloudflarePlanDigest", () => {
    it("is deterministic for same input", () => {
      const plan1 = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });
      const plan2 = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });

      const d1 = computeCloudflarePlanDigest({ operations: plan1, planDigest: "" });
      const d2 = computeCloudflarePlanDigest({ operations: plan2, planDigest: "" });
      expect(d1).toBe(d2);
    });

    it("changes when manifest changes", () => {
      const planA = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });
      const planB = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-999",
      });

      const dA = computeCloudflarePlanDigest({ operations: planA, planDigest: "" });
      const dB = computeCloudflarePlanDigest({ operations: planB, planDigest: "" });
      expect(dA).not.toBe(dB);
    });

    it("changes when operation kind changes", () => {
      const deployOps = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });
      const rollbackOps = buildCloudflareOperations("rollback", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
        targetVersionId: "v-1",
      });

      const dDeploy = computeCloudflarePlanDigest({ operations: deployOps, planDigest: "" });
      const dRollback = computeCloudflarePlanDigest({ operations: rollbackOps, planDigest: "" });
      expect(dDeploy).not.toBe(dRollback);
    });

    it("excludes planDigest field from digest computation", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });
      const withDigest = computeCloudflarePlanDigest({ operations: ops, planDigest: "abc" });
      const withoutDigest = computeCloudflarePlanDigest({ operations: ops, planDigest: "xyz" });
      expect(withDigest).toBe(withoutDigest);
    });
  });

  describe("isCloudflarePlan", () => {
    it("returns true for valid plan shape", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });

      const plan = {
        version: 1 as const,
        planId: "plan-1",
        planDigest: "abc",
        provider: "cloudflare" as const,
        environment: "production" as const,
        intent: "deploy" as const,
        identity: {
          account: { kind: "user" as const, id: "acc-123" },
          worker: { name: "my-worker" },
        },
        accountFingerprint: "fp-acc",
        targetFingerprint: "fp-target",
        manifestFingerprint: "fp-manifest",
        secretNames: [],
        operations: ops,
        createdAt: new Date().toISOString(),
      };

      expect(isCloudflarePlan(plan)).toBe(true);
    });

    it("rejects plan with wrong provider", () => {
      const ops = buildCloudflareOperations("deploy", "production", {
        workerName: "my-worker",
        accountId: "acc-123",
      });

      expect(isCloudflarePlan({
        version: 1,
        planId: "plan-1",
        planDigest: "abc",
        provider: "vercel",
        environment: "production",
        intent: "deploy",
        identity: { account: { kind: "user", id: "acc-123" }, worker: { name: "my-worker" } },
        accountFingerprint: "fp",
        targetFingerprint: "fp",
        manifestFingerprint: "fp-manifest",
        secretNames: [],
        operations: ops,
        createdAt: new Date().toISOString(),
      })).toBe(false);
    });
  });
});
