import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  cloudflareCapabilityProfile,
  localCapabilityProfile,
  neonCapabilityProfile,
  railwayCapabilityProfile,
  vercelCapabilityProfile,
} from "../../src/providers/capability-profile.js";
import { composeDBSchema, DBSchema } from "../../src/tools/db/schema.js";
import { composeShipSchema, shipSchema } from "../../src/tools/ship/schema.js";

const commonDB = [
  { action: "inspect" },
  { action: "browse", table: "items" },
  { action: "query", sql: "select 1" },
  { action: "plan", sql: "select 1" },
  { action: "apply_plan", planId: "p", planDigest: "d" },
  { action: "migration_status" },
  { action: "import", table: "items", format: "json", rows: [] },
  { action: "reset" },
] as const;

describe("provider capability profiles", () => {
  it("narrows ship variants by provider", () => {
    const railway = composeShipSchema(railwayCapabilityProfile.ship);
    const vercel = composeShipSchema(vercelCapabilityProfile.ship);
    const cloudflare = composeShipSchema(cloudflareCapabilityProfile.ship);
    const neon = composeShipSchema(neonCapabilityProfile.ship);

    expect(Value.Check(railway, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(true);
    expect(Value.Check(railway, { action: "plan", environment: "preview" })).toBe(false);
    expect(Value.Check(vercel, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(false);
    expect(Value.Check(cloudflare, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(false);
    expect(Value.Check(neon, { action: "plan", environment: "development" })).toBe(true);
    expect(Value.Check(neon, { action: "logs", lines: 10 })).toBe(false);
  });

  it("keeps all shared DB actions and scopes migration planning", () => {
    const profiles = [localCapabilityProfile, railwayCapabilityProfile, vercelCapabilityProfile, cloudflareCapabilityProfile, neonCapabilityProfile];
    for (const profile of profiles) {
      const schema = composeDBSchema(profile.databaseAdditions);
      for (const input of commonDB) expect(Value.Check(schema, input), `${profile.id}: ${input.action}`).toBe(true);
      expect(Value.Check(schema, { action: "plan_migration" }), profile.id).toBe(profile.id === "railway" || profile.id === "neon");
    }
  });

  it("retains broad public schema compatibility", () => {
    expect(Value.Check(shipSchema, { action: "plan", environment: "development" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "plan_migration" })).toBe(true);
  });
});
