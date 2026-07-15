import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { shipSchema } from "../../src/tools/ship/schema.js";
import { DBSchema } from "../../src/tools/db/schema.js";

describe("tool schemas", () => {
  it("accepts each ship action and rejects extra fields", () => {
    for (const value of [
      { action: "validate" }, { action: "plan", environment: "production" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
      { action: "status" }, { action: "logs", lines: 10 }, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "r" },
    ]) { expect(Value.Check(shipSchema, value), JSON.stringify(value)).toBe(true); }
    expect(Value.Check(shipSchema, { action: "status", extra: true })).toBe(false);
  });
  it("accepts each db action and rejects unknown actions", () => {
    for (const value of [
      { action: "inspect" }, { action: "migration_status" }, { action: "plan_migration" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
      { action: "browse", table: "items", limit: 1, offset: 0 },
      { action: "browse", table: "items" },
      { action: "query", sql: "select 1", limit: 1 },
      { action: "query", sql: "select 1" },
      { action: "plan", sql: "select 1" },
    ]) { expect(Value.Check(DBSchema, value), JSON.stringify(value)).toBe(true); }
    expect(Value.Check(DBSchema, { action: "provision" })).toBe(false);
    expect(Value.Check(DBSchema, { action: "plan_migration", environment: "production" })).toBe(false);
  });
});
