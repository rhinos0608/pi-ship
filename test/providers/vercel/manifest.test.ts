import { describe, expect, it } from "vitest";
import { isVercelManifest, validateVercelManifestSemantics } from "../../../src/providers/vercel/manifest.js";

describe("manifest V2 contract", () => {
  const valid = { version: 2 as const, name: "app", app: { provider: "vercel" as const, config: { projectName: "site", rootDirectory: "apps/web" } }, secrets: ["DATABASE_URL"] };
  it("accepts normalized safe root", () => expect(() => validateVercelManifestSemantics(valid)).not.toThrow());
  it.each(["../site", "/site", "apps\\web", "apps//web"]) ("rejects unsafe root %s", (root) => expect(() => validateVercelManifestSemantics({ ...valid, app: { ...valid.app, config: { projectName: "site", rootDirectory: root } } })).toThrow());
  it("requires database secret allowlist", () => expect(() => validateVercelManifestSemantics({ ...valid, database: { provider: "external" as const, config: { urlSecretName: "MISSING" } } })).toThrow());
  it("uses strict nested schema", () => expect(isVercelManifest({ ...valid, app: { ...valid.app, extra: true } })).toBe(false));
});
