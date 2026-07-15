import { describe, expect, it } from "vitest";
import { isCloudflareManifest, validateCloudflareManifest, CloudflareManifestSchema } from "../../../src/providers/cloudflare/manifest.js";
import { Value } from "typebox/value";

describe("CloudflareManifest", () => {
  const valid = {
    provider: "cloudflare" as const,
    version: 1 as const,
    accountId: "abc123",
    name: "my-worker",
    mainModule: "src/index.ts",
    compatibilityDate: "2024-01-01",
  };

  it("accepts minimal valid manifest", () => {
    expect(isCloudflareManifest(valid)).toBe(true);
    expect(() => validateCloudflareManifest(valid)).not.toThrow();
  });

  it("accepts full valid manifest with all optional fields", () => {
    const full = {
      ...valid,
      compatibilityFlags: ["nodejs_compat"],
      secrets: ["API_KEY", "DATABASE_URL"],
      source: "src/",
    };
    expect(isCloudflareManifest(full)).toBe(true);
  });

  it("rejects missing accountId", () => {
    const { accountId: _, ...rest } = valid;
    expect(isCloudflareManifest(rest)).toBe(false);
    expect(() => validateCloudflareManifest(rest)).toThrow();
  });

  it("rejects missing name", () => {
    const { name: _, ...rest } = valid;
    expect(isCloudflareManifest(rest)).toBe(false);
  });

  it("rejects missing mainModule", () => {
    const { mainModule: _, ...rest } = valid;
    expect(isCloudflareManifest(rest)).toBe(false);
  });

  it("rejects missing compatibilityDate", () => {
    const { compatibilityDate: _, ...rest } = valid;
    expect(isCloudflareManifest(rest)).toBe(false);
  });

  it("rejects wrong provider", () => {
    expect(isCloudflareManifest({ ...valid, provider: "vercel" })).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(isCloudflareManifest({ ...valid, version: 2 })).toBe(false);
  });

  it("rejects empty accountId", () => {
    expect(isCloudflareManifest({ ...valid, accountId: "" })).toBe(false);
  });

  it("rejects empty name", () => {
    expect(isCloudflareManifest({ ...valid, name: "" })).toBe(false);
  });

  it("rejects empty mainModule", () => {
    expect(isCloudflareManifest({ ...valid, mainModule: "" })).toBe(false);
  });

  it("rejects extra top-level fields", () => {
    expect(Value.Check(CloudflareManifestSchema, { ...valid, extra: true })).toBe(false);
  });

  it("rejects empty secrets array", () => {
    expect(isCloudflareManifest({ ...valid, secrets: [] })).toBe(false);
  });

  it("rejects non-string compatibilityFlags", () => {
    expect(isCloudflareManifest({ ...valid, compatibilityFlags: [123] })).toBe(false);
  });
});
