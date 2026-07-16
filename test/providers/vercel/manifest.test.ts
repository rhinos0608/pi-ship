import { describe, expect, it } from "vitest";
import { isVercelManifest, validateVercelManifestSemantics } from "../../../src/providers/vercel/manifest.js";
import { vercelPackage } from "../../../src/providers/vercel/package.js";

describe("manifest V2 contract", () => {
  const valid = { version: 2 as const, name: "app", app: { provider: "vercel" as const, config: { projectName: "site", rootDirectory: "apps/web" } }, secrets: ["DATABASE_URL"] };
  it("accepts normalized safe root", () => expect(() => validateVercelManifestSemantics(valid)).not.toThrow());
  it.each(["../site", "/site", "apps\\web", "apps//web"]) ("rejects unsafe root %s", (root) => expect(() => validateVercelManifestSemantics({ ...valid, app: { ...valid.app, config: { projectName: "site", rootDirectory: root } } })).toThrow());
  it("requires database secret allowlist", () => expect(() => validateVercelManifestSemantics({ ...valid, database: { provider: "external" as const, config: { urlSecretName: "MISSING" } } })).toThrow());
  it("uses strict nested schema", () => expect(isVercelManifest({ ...valid, app: { ...valid.app, extra: true } })).toBe(false));
  it("validates unknown manifests through package startup hook", () => {
    expect(() => vercelPackage.validateManifest?.(valid)).not.toThrow();
    expect(() => vercelPackage.validateManifest?.({ ...valid, app: { ...valid.app, config: { ...valid.app.config, rootDirectory: "../outside" } } })).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" }),
    );
    expect(() => vercelPackage.validateManifest?.({ ...valid, database: { provider: "external" as const, config: { urlSecretName: "MISSING" } } })).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" }),
    );
  });
});
