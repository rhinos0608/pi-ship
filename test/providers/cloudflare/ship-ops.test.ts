import { describe, expect, it, vi } from "vitest";
import { ApprovalRegistry } from "../../../src/core/approval.js";
import { handleCloudflareShipOps } from "../../../src/providers/cloudflare/ship-ops.js";
import type { RegistryServices } from "../../../src/providers/contracts.js";

const manifest = {
  provider: "cloudflare" as const, version: 1 as const, accountId: "acct",
  name: "worker", mainModule: "main.js", compatibilityDate: "2024-01-01",
  secrets: ["API_KEY"],
};
const state = { provider: "cloudflare" as const, version: 1 as const, deployments: [{ id: "dep", versionId: "v1", planId: "p", digest: "d", at: "2024-01-01T00:00:00Z" }], history: [] };

function setup() {
  const logs = vi.fn(async (_id: string, input: { lines: number; secretValues: readonly string[] }) => ({ status: "verified" as const, value: `lines=${input.lines} secret=[redacted:${input.secretValues.length}]` }));
  const runtime = { logs };
  const services: RegistryServices = {
    credentialSource: { get: () => undefined },
    loadManifest: async () => manifest, loadState: async () => state,
    saveState: async () => {}, loadPlan: async () => undefined, persistPlan: async () => {},
    createExecution: () => ({ provider: "cloudflare", contract: 1, runtime, client: {} }),
  };
  const credentialSource = { get: (name: string) => ({ CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "acct", API_KEY: "secret-value" }[name]) };
  const context = {
    manifest, cwd: "/tmp", pi: {} as never, ctx: { hasUI: false, cwd: "/tmp" } as never,
    registry: new ApprovalRegistry("/tmp"), credentialSource, services,
  } as never;
  return { logs, context };
}

describe("Cloudflare ship logs handler", () => {
  it("forwards requested lines and app secret values", async () => {
    const { logs, context } = setup();
    const result = await handleCloudflareShipOps({ action: "logs", lines: 37 }, context);
    expect(logs).toHaveBeenCalledWith("dep", { lines: 37, secretValues: ["secret-value"] }, undefined);
    expect(result.content[0].text).toContain("lines=37");
    expect(result.content[0].text).not.toContain("secret-value");
  });

  it("defaults logs to 100 lines", async () => {
    const { logs, context } = setup();
    await handleCloudflareShipOps({ action: "logs" }, context);
    expect(logs).toHaveBeenCalledWith("dep", { lines: 100, secretValues: ["secret-value"] }, undefined);
  });
});
