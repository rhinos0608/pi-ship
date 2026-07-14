import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { shipOpsSchema } from "../../src/tools/ship-ops.js";
import { dbOpsSchema } from "../../src/tools/db-ops.js";

describe("tool schemas", () => {
  it("accepts each ship action and rejects extra fields", () => {
    for (const value of [
      { action: "validate" }, { action: "plan", environment: "production" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
      { action: "status" }, { action: "logs", lines: 10 }, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "r" },
    ]) { expect(Value.Check(shipOpsSchema, value), JSON.stringify(value)).toBe(true); }
    expect(Value.Check(shipOpsSchema, { action: "status", extra: true })).toBe(false);
  });
  it("accepts each db action and rejects unknown actions", () => {
    for (const value of [
      { action: "inspect" }, { action: "provision", environment: "production" },
      { action: "migration_status" }, { action: "plan_migration", environment: "development" },
      { action: "apply_plan", planId: "p", planDigest: "d" },
    ]) { expect(Value.Check(dbOpsSchema, value), JSON.stringify(value)).toBe(true); }
    expect(Value.Check(dbOpsSchema, { action: "apply_migration" })).toBe(false);
  });
});
