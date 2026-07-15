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
