import { describe, expect, it } from "vitest";
import { resolveDatabaseEnvironment } from "../../src/database/environment.js";

describe("resolveDatabaseEnvironment", () => {
  it("accepts exact configured database environments", () => {
    for (const value of ["development", "preview", "production"]) {
      expect(resolveDatabaseEnvironment({ get: () => value })).toBe(value);
    }
  });
  it("rejects missing or invalid configuration", () => {
    expect(() => resolveDatabaseEnvironment({ get: () => undefined })).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
    expect(() => resolveDatabaseEnvironment({ get: () => "staging" })).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
  });
});

describe("resolveDatabaseEnvironment with targetKind", () => {
  it("defaults to development for local target when unset", () => {
    expect(resolveDatabaseEnvironment({ get: () => undefined }, "local")).toBe("development");
  });

  it("defaults to development for file target when unset", () => {
    expect(resolveDatabaseEnvironment({ get: () => undefined }, "file")).toBe("development");
  });

  it("honors explicit setting on local target", () => {
    expect(resolveDatabaseEnvironment({ get: () => "preview" }, "local")).toBe("preview");
  });

  it("honors explicit setting on file target", () => {
    expect(resolveDatabaseEnvironment({ get: () => "production" }, "file")).toBe("production");
  });

  it("still throws for remote target when unset", () => {
    expect(() => resolveDatabaseEnvironment({ get: () => undefined }, "remote")).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
  });

  it("still throws for unknown kind when unset", () => {
    expect(() => resolveDatabaseEnvironment({ get: () => undefined }, "unknown")).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
  });

  it("still works without targetKind (backward compat — remote default)", () => {
    expect(resolveDatabaseEnvironment({ get: () => "production" })).toBe("production");
    expect(() => resolveDatabaseEnvironment({ get: () => undefined })).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
  });
});
