import { describe, expect, it } from "vitest";
import { isNeonManifest, validateNeonManifest } from "../../../src/providers/neon/manifest.js";

describe("NeonManifest", () => {
  const valid = {
    provider: "neon",
    version: 1,
    project: "my-project",
  };

  it("valid manifest parses correctly", () => {
    expect(isNeonManifest(valid)).toBe(true);
    expect(() => validateNeonManifest(valid)).not.toThrow();
  });

  it("invalid manifest rejected", () => {
    expect(isNeonManifest({})).toBe(false);
    expect(() => validateNeonManifest({})).toThrow();
  });

  it("missing required project field rejected", () => {
    const m = { provider: "neon", version: 1 };
    expect(isNeonManifest(m)).toBe(false);
    expect(() => validateNeonManifest(m)).toThrow();
  });

  it("wrong provider rejected", () => {
    const m = { ...valid, provider: "aws" };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("wrong version rejected", () => {
    const m = { ...valid, version: 2 };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("extra top-level key rejected", () => {
    const m = { ...valid, extra: true };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("pgVersion optional field accepted", () => {
    const m = { ...valid, pgVersion: 16 };
    expect(isNeonManifest(m)).toBe(true);
    expect(() => validateNeonManifest(m)).not.toThrow();
  });

  it("pgVersion below minimum rejected", () => {
    const m = { ...valid, pgVersion: 13 };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("pgVersion above maximum rejected", () => {
    const m = { ...valid, pgVersion: 19 };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("pgVersion 18 accepted", () => {
    const m = { ...valid, pgVersion: 18 };
    expect(isNeonManifest(m)).toBe(true);
  });

  it("regionId optional field accepted", () => {
    const m = { ...valid, regionId: "aws-us-east-1" };
    expect(isNeonManifest(m)).toBe(true);
  });

  it("branch optional fields accepted", () => {
    const m = { ...valid, branch: { name: "main", databaseName: "mydb", roleName: "myrole" } };
    expect(isNeonManifest(m)).toBe(true);
  });

  it("branch rejects extra keys", () => {
    const m = { ...valid, branch: { name: "main", extra: true } };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("compute optional fields accepted", () => {
    const m = { ...valid, compute: { minCu: 1, maxCu: 4, suspendTimeoutSeconds: 300 } };
    expect(isNeonManifest(m)).toBe(true);
  });

  it("compute rejects negative minCu", () => {
    const m = { ...valid, compute: { minCu: -1 } };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("compute rejects minCu below 0.25", () => {
    const m = { ...valid, compute: { minCu: 0 } };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("compute rejects non-discrete CU size", () => {
    const m = { ...valid, compute: { minCu: 0.3 } };
    expect(isNeonManifest(m)).toBe(true);
    expect(() => validateNeonManifest(m)).toThrow();
  });

  it("compute validates minCu <= maxCu", () => {
    const m = { ...valid, compute: { minCu: 2, maxCu: 1 } };
    expect(isNeonManifest(m)).toBe(true);
    expect(() => validateNeonManifest(m)).toThrow();
  });

  it("compute accepts valid discrete CU sizes", () => {
    expect(isNeonManifest({ ...valid, compute: { minCu: 0.25 } })).toBe(true);
    expect(isNeonManifest({ ...valid, compute: { minCu: 0.5 } })).toBe(true);
    expect(isNeonManifest({ ...valid, compute: { minCu: 1, maxCu: 4 } })).toBe(true);
    expect(() => validateNeonManifest({ ...valid, compute: { minCu: 0.25 } })).not.toThrow();
    expect(() => validateNeonManifest({ ...valid, compute: { minCu: 0.5 } })).not.toThrow();
    expect(() => validateNeonManifest({ ...valid, compute: { minCu: 1, maxCu: 4 } })).not.toThrow();
  });

  it("migrations optional fields accepted", () => {
    const m = { ...valid, migrations: { command: ["npx", "prisma", "migrate", "deploy"] } };
    expect(isNeonManifest(m)).toBe(true);
  });

  it("migrations rejects empty command array", () => {
    const m = { ...valid, migrations: { command: [] } };
    expect(isNeonManifest(m)).toBe(false);
  });

  it("full manifest with all fields passes", () => {
    const m = {
      ...valid,
      pgVersion: 15,
      regionId: "aws-us-west-2",
      branch: { name: "dev", databaseName: "devdb", roleName: "devrole" },
      compute: { minCu: 0.5, maxCu: 2, suspendTimeoutSeconds: 600 },
      migrations: { command: ["npx", "prisma", "migrate", "deploy"] },
    };
    expect(isNeonManifest(m)).toBe(true);
    expect(() => validateNeonManifest(m)).not.toThrow();
  });
});
