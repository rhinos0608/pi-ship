import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { handleCloudflareShipOps } from "../../src/providers/cloudflare/ship-ops.js";
import type { RegistryServices } from "../../src/providers/contracts.js";
import { defaultCloudflareState, type CloudflareState } from "../../src/providers/cloudflare/state.js";

const manifest = {
  provider: "cloudflare" as const, version: 1 as const, accountId: "acct", name: "acceptance-worker",
  mainModule: "main.js", compatibilityDate: "2024-01-01", secrets: ["API_KEY"],
};
const credentials = { get: (name: string) => ({ CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "acct", API_KEY: "secret-value" }[name]) };

describe("Cloudflare cloud-free lifecycle", () => {
  it("runs validate, plan, apply, status, logs, and rollback through injected seam", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cloudflare-"));
    try {
      let state: CloudflareState = defaultCloudflareState();
      const plans = new Map<string, any>();
      const calls: string[] = [];
      const runtime = {
        checkAuth: async () => { calls.push("auth"); return { status: "verified" as const, value: { kind: "user" as const, id: "acct" } }; },
        discover: async () => { calls.push("discover"); return { status: "verified" as const, value: { account: { kind: "user" as const, id: "acct" }, worker: { name: manifest.name, exists: false } } }; },
        execute: async (op: any) => { calls.push(`execute:${op.kind}`); return { status: "succeeded" as const, resourceRef: `${op.kind}-ref`, providerRequestId: op.kind === "upload_version" ? "version-ref" : undefined, observedStateFingerprint: op.expectedStateFingerprint }; },
        reconcile: async () => ({ status: "verified" as const, value: { outcome: "matches_expected" as const, observedStateFingerprint: "ok" } }),
        status: async () => ({ status: "verified" as const, value: "deployed" }),
        logs: async (_id: string, input: any) => { calls.push(`logs:${input.lines}`); return { status: "verified" as const, value: "safe [REDACTED]" }; },
      };
      const services: RegistryServices = {
        credentialSource: { get: () => undefined },
        loadManifest: async () => manifest, loadState: async () => state, saveState: async (_id, next) => { state = next as CloudflareState; },
        loadPlan: async (_id, id) => plans.get(id), persistPlan: async (_id, plan) => { const value = plan as any; plans.set(value.planId, value); },
        createExecution: () => ({ provider: "cloudflare", contract: 1, runtime, client: {} }),
      };
      const registry = new ApprovalRegistry(cwd);
      const context = { manifest, cwd, pi: {} as never, ctx: { hasUI: true, cwd, ui: { confirm: async () => true } } as never, registry, credentialSource: credentials, services } as never;

      const validate = await handleCloudflareShipOps({ action: "validate" }, context);
      expect(validate.content[0].text).toContain("Manifest valid");
      const planned = await handleCloudflareShipOps({ action: "plan", environment: "production" }, context);
      const planDetails = planned.details as { planId: string; planDigest: string };
      expect(planDetails.planId).toBeTruthy();
      // Stored plan is supplied by injected service, avoiding native Cloudflare network.
      await handleCloudflareShipOps({ action: "apply_plan", planId: planDetails.planId, planDigest: planDetails.planDigest }, context);
      expect(state.deployments).toHaveLength(1);
      const status = await handleCloudflareShipOps({ action: "status" }, context);
      expect(status.content[0].text).toContain("deployed");
      const logs = await handleCloudflareShipOps({ action: "logs", lines: 7 }, context);
      expect(logs.content[0].text).toContain("REDACTED");
      const rollback = await handleCloudflareShipOps({ action: "plan", environment: "production", intent: "rollback", targetReleaseId: "version-ref" }, context);
      expect((rollback.details as { intent: string }).intent).toBe("rollback");
      expect(calls).toContain("auth");
      expect(calls).toContain("logs:7");
      expect(logs.content[0].text).not.toContain("secret-value");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
