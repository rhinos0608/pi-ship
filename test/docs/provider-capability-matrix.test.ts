import { describe, expect, it, beforeAll } from "vitest";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localCapabilityProfile,
  railwayCapabilityProfile,
  vercelCapabilityProfile,
  cloudflareCapabilityProfile,
  neonCapabilityProfile,
} from "../../src/providers/capability-profile.js";
import { composeShipSchema, shipSchema } from "../../src/tools/ship/schema.js";
import { composeDBSchema, DBSchema, planMigrationVariant } from "../../src/tools/db/schema.js";

/**
 * Validates each provider capability profile matches the ADR 0012 matrix table.
 * Tests both profile declarations and composed schema behavior.
 * Reads ADR 0012 directly to ensure the matrix table stays in sync.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ADR_PATH = resolve(__dirname, "../../docs/adr/0012-provider-scoped-tool-surfaces.md");

describe("ADR provider capability matrix", () => {
  let adr: string;

  beforeAll(() => {
    adr = readFileSync(ADR_PATH, "utf-8");
  });

  // ── ADR file integrity ─────────────────────────────────────────────
  it("ADR 0012 exists and contains the five-profile matrix table", () => {
    expect(adr).toContain("Provider-scoped tool surfaces");
    expect(adr).toContain("| Profile");
    expect(adr).toContain("`ship` surface | DB addition | Commands | Boundary resource");
    expect(adr).toContain("| Local/no manifest");
    expect(adr).toContain("| Railway");
    expect(adr).toContain("| Vercel");
    expect(adr).toContain("| Cloudflare");
    expect(adr).toContain("| Neon");
  });

  // ── ADR table row parser ──────────────────────────────────────────
  /** Parse ADR markdown table into profile-name → cell-text map. */
  function parseTableRows(adrText: string): Map<string, string[]> {
    const rows = new Map<string, string[]>();
    const lines = adrText.split("\n");
    let inTable = false;
    for (const line of lines) {
      if (!line.startsWith("| ")) { inTable = false; continue; }
      if (line.includes("---")) continue; // separator row
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 5) continue;
      const profileName = cells[0];
      if (profileName === "Profile") continue; // header row
      rows.set(profileName, cells.slice(1, 5)); // ship, DB, commands, resource
    }
    return rows;
  }

  it("each ADR table row matches profile expectations including rollback", () => {
    const rows = parseTableRows(adr);
    expect(rows.has("Local/no manifest")).toBe(true);
    expect(rows.has("Railway")).toBe(true);
    expect(rows.has("Vercel")).toBe(true);
    expect(rows.has("Cloudflare")).toBe(true);
    expect(rows.has("Neon")).toBe(true);

    // Local/no manifest
    const local = rows.get("Local/no manifest")!;
    expect(local[0]).toBe("none"); // ship
    expect(local[1]).toBe("none"); // DB addition
    expect(local[2]).toBe("none"); // commands
    expect(local[3]).toBe("generic database resource"); // boundary resource

    // Railway
    const rail = rows.get("Railway")!;
    expect(rail[0]).toContain("validate");
    expect(rail[0]).toContain("plan");
    expect(rail[0]).toContain("apply_plan");
    expect(rail[0]).toContain("status");
    expect(rail[0]).toContain("logs");
    expect(rail[0]).toContain("rollback");
    expect(rail[0]).toContain("targetReleaseId");
    expect(rail[1]).toBe("plan_migration");
    expect(rail[2]).toContain("ship-init");
    expect(rail[2]).toContain("ship-rollback");
    expect(rail[3]).toBe("railway-deployment");

    // Vercel
    const vercel = rows.get("Vercel")!;
    expect(vercel[0]).toContain("validate");
    expect(vercel[0]).toContain("plan");
    expect(vercel[0]).toContain("apply_plan");
    expect(vercel[0]).toContain("status");
    expect(vercel[0]).toContain("logs");
    expect(vercel[0]).toContain("rollback");
    expect(vercel[0]).toContain("targetReleaseId");
    expect(vercel[1]).toBe("none");
    expect(vercel[2]).toBe("none");
    expect(vercel[3]).toBe("vercel-deployment");

    // Cloudflare
    const cf = rows.get("Cloudflare")!;
    expect(cf[0]).toContain("validate");
    expect(cf[0]).toContain("plan");
    expect(cf[0]).toContain("apply_plan");
    expect(cf[0]).toContain("status");
    expect(cf[0]).toContain("logs");
    expect(cf[0]).toContain("rollback");
    expect(cf[0]).toContain("targetReleaseId");
    expect(cf[1]).toBe("none");
    expect(cf[2]).toBe("none");
    expect(cf[3]).toBe("cloudflare-deployment");

    // Neon
    const neon = rows.get("Neon")!;
    expect(neon[0]).toContain("validate");
    expect(neon[0]).toContain("plan");
    expect(neon[0]).toContain("apply_plan");
    expect(neon[0]).toContain("status");
    expect(neon[0]).toContain("no logs");
    expect(neon[0]).toContain("rollback");
    expect(neon[0]).toContain("targetReleaseId");
    expect(neon[1]).toBe("plan_migration");
    expect(neon[2]).toBe("none");
    expect(neon[3]).toBe("neon-control-plane");
  });

  // ── Local profile ──────────────────────────────────────────────────
  it("local profile has no ship, no commands, common DB only, no boundary", () => {
    expect(localCapabilityProfile.id).toBe("local");
    expect(localCapabilityProfile.ship).toHaveLength(0);
    expect(localCapabilityProfile.commands).toHaveLength(0);
    expect(localCapabilityProfile.databaseAdditions).toHaveLength(0);
    expect(localCapabilityProfile.boundaryResource).toBeUndefined();

    // Compose empty additions → 8 shared DB actions (no plan_migration)
    const localDB = composeDBSchema([]) as { anyOf?: unknown[] };
    expect(localDB.anyOf?.length).toBe(8);
  });

  // ── Railway profile ────────────────────────────────────────────────
  it("Railway profile has full ship surface, previewId required, 6 commands, plan_migration, railway-deployment", () => {
    expect(railwayCapabilityProfile.id).toBe("railway");
    expect(railwayCapabilityProfile.commands).toEqual([
      "ship-init",
      "ship-plan",
      "ship-apply",
      "ship-status",
      "ship-logs",
      "ship-rollback",
    ]);
    expect(railwayCapabilityProfile.databaseAdditions.length).toBeGreaterThan(0);
    expect(railwayCapabilityProfile.boundaryResource).toBe("railway-deployment");

    const ship = composeShipSchema(railwayCapabilityProfile.ship);
    // Valid actions
    expect(Value.Check(ship, { action: "validate" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "production" })).toBe(true);
    // Railway rollback uses action: "plan" with intent: "rollback"
    expect(Value.Check(ship, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "rel-1" })).toBe(true);
    expect(Value.Check(ship, { action: "apply_plan", planId: "p-1", planDigest: "abc" })).toBe(true);
    expect(Value.Check(ship, { action: "status" })).toBe(true);
    expect(Value.Check(ship, { action: "logs" })).toBe(true);

    // Railway preview without previewId → rejected
    expect(Value.Check(ship, { action: "plan", environment: "preview" })).toBe(false);
  });

  // ── Vercel profile ─────────────────────────────────────────────────
  it("Vercel profile has ship surface, no previewId, rollback, no DB additions, no commands, vercel-deployment", () => {
    expect(vercelCapabilityProfile.id).toBe("vercel");
    expect(vercelCapabilityProfile.commands).toHaveLength(0);
    expect(vercelCapabilityProfile.databaseAdditions).toHaveLength(0);
    expect(vercelCapabilityProfile.boundaryResource).toBe("vercel-deployment");

    const ship = composeShipSchema(vercelCapabilityProfile.ship);
    expect(Value.Check(ship, { action: "validate" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "preview" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "production" })).toBe(true);
    expect(Value.Check(ship, { action: "apply_plan", planId: "p-1", planDigest: "abc" })).toBe(true);
    expect(Value.Check(ship, { action: "status" })).toBe(true);
    expect(Value.Check(ship, { action: "logs" })).toBe(true);

    // Vercel rejects previewId field
    expect(Value.Check(ship, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(false);
    // Vercel accepts rollback
    expect(Value.Check(ship, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "rel-1" })).toBe(true);
  });

  // ── Cloudflare profile ─────────────────────────────────────────────
  it("Cloudflare profile has ship surface, no previewId, rollback, no DB additions, no commands, cloudflare-deployment", () => {
    expect(cloudflareCapabilityProfile.id).toBe("cloudflare");
    expect(cloudflareCapabilityProfile.commands).toHaveLength(0);
    expect(cloudflareCapabilityProfile.databaseAdditions).toHaveLength(0);
    expect(cloudflareCapabilityProfile.boundaryResource).toBe("cloudflare-deployment");

    const ship = composeShipSchema(cloudflareCapabilityProfile.ship);
    expect(Value.Check(ship, { action: "validate" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "preview" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "production" })).toBe(true);
    expect(Value.Check(ship, { action: "apply_plan", planId: "p-1", planDigest: "abc" })).toBe(true);
    expect(Value.Check(ship, { action: "status" })).toBe(true);
    expect(Value.Check(ship, { action: "logs" })).toBe(true);

    // Cloudflare rejects previewId field
    expect(Value.Check(ship, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(false);
    // Cloudflare accepts rollback
    expect(Value.Check(ship, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "rel-1" })).toBe(true);
  });

  // ── Neon profile ───────────────────────────────────────────────────
  it("Neon profile has ship surface with development and rollback, no logs, plan_migration, no commands, neon-control-plane", () => {
    expect(neonCapabilityProfile.id).toBe("neon");
    expect(neonCapabilityProfile.commands).toHaveLength(0);
    expect(neonCapabilityProfile.databaseAdditions.length).toBeGreaterThan(0);
    expect(neonCapabilityProfile.boundaryResource).toBe("neon-control-plane");

    const ship = composeShipSchema(neonCapabilityProfile.ship);
    expect(Value.Check(ship, { action: "validate" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "development" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "preview" })).toBe(true);
    expect(Value.Check(ship, { action: "plan", environment: "production" })).toBe(true);
    expect(Value.Check(ship, { action: "apply_plan", planId: "p-1", planDigest: "abc" })).toBe(true);
    expect(Value.Check(ship, { action: "status" })).toBe(true);

    // Neon has no logs
    expect(Value.Check(ship, { action: "logs" })).toBe(false);
    // Neon accepts rollback
    expect(Value.Check(ship, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "rel-1" })).toBe(true);
  });

  // ── Profile declarations match profile.id ──────────────────────────
  it("profile ids match declaration prefixes", () => {
    expect(localCapabilityProfile.id).toBe("local");
    expect(railwayCapabilityProfile.id).toBe("railway");
    expect(vercelCapabilityProfile.id).toBe("vercel");
    expect(cloudflareCapabilityProfile.id).toBe("cloudflare");
    expect(neonCapabilityProfile.id).toBe("neon");
  });

  // ── composeDBSchema ────────────────────────────────────────────────
  it("composeDBSchema with planMigrationVariant accepts plan_migration", () => {
    const db = composeDBSchema([planMigrationVariant]);
    expect(Value.Check(db, { action: "inspect" })).toBe(true);
    expect(Value.Check(db, { action: "browse", table: "items" })).toBe(true);
    expect(Value.Check(db, { action: "query", sql: "SELECT 1" })).toBe(true);
    expect(Value.Check(db, { action: "plan", sql: "SELECT 1" })).toBe(true);
    expect(Value.Check(db, { action: "plan_migration" })).toBe(true);
    expect(Value.Check(db, { action: "migration_status" })).toBe(true);
    expect(Value.Check(db, { action: "import", table: "items", format: "json", rows: [] })).toBe(true);
    expect(Value.Check(db, { action: "apply_plan", planId: "p", planDigest: "d" })).toBe(true);
    expect(Value.Check(db, { action: "reset" })).toBe(true);
  });

  it("composeDBSchema without planMigrationVariant rejects plan_migration", () => {
    const db = composeDBSchema([]);
    expect(Value.Check(db, { action: "inspect" })).toBe(true);
    expect(Value.Check(db, { action: "browse", table: "items" })).toBe(true);
    expect(Value.Check(db, { action: "query", sql: "SELECT 1" })).toBe(true);
    expect(Value.Check(db, { action: "plan", sql: "SELECT 1" })).toBe(true);
    // Without planMigrationVariant, plan_migration is rejected
    expect(Value.Check(db, { action: "plan_migration" })).toBe(false);
    expect(Value.Check(db, { action: "migration_status" })).toBe(true);
    expect(Value.Check(db, { action: "import", table: "items", format: "json", rows: [] })).toBe(true);
    expect(Value.Check(db, { action: "apply_plan", planId: "p", planDigest: "d" })).toBe(true);
    expect(Value.Check(db, { action: "reset" })).toBe(true);
  });

  // ── Public broad schemas ───────────────────────────────────────────
  it("public shipSchema accepts all profile forms including Neon development", () => {
    expect(Value.Check(shipSchema, { action: "validate" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "development" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "preview" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "production" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "preview", previewId: "pr-7" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "plan", environment: "production", intent: "rollback", targetReleaseId: "rel-1" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "apply_plan", planId: "p-1", planDigest: "abc" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "status" })).toBe(true);
    expect(Value.Check(shipSchema, { action: "logs" })).toBe(true);
  });

  it("public DBSchema accepts plan_migration and all shared actions", () => {
    expect(Value.Check(DBSchema, { action: "inspect" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "browse", table: "items" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "query", sql: "SELECT 1" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "plan", sql: "SELECT 1" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "plan_migration" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "migration_status" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "import", table: "items", format: "json", rows: [] })).toBe(true);
    expect(Value.Check(DBSchema, { action: "apply_plan", planId: "p", planDigest: "d" })).toBe(true);
    expect(Value.Check(DBSchema, { action: "reset" })).toBe(true);
  });

  // ── Profile declarations compose correctly with all common DB actions ──
  it("Railway and Neon compose with plan_migration; others without", () => {
    // Railway and Neon profiles include planMigrationVariant
    expect(railwayCapabilityProfile.databaseAdditions).toContain(planMigrationVariant);
    expect(neonCapabilityProfile.databaseAdditions).toContain(planMigrationVariant);

    // Local, Vercel, Cloudflare do not
    expect(localCapabilityProfile.databaseAdditions).not.toContain(planMigrationVariant);
    expect(vercelCapabilityProfile.databaseAdditions).not.toContain(planMigrationVariant);
    expect(cloudflareCapabilityProfile.databaseAdditions).not.toContain(planMigrationVariant);
  });

  // ── Command lists match ADR ────────────────────────────────────────
  it("command lists match ADR matrix", () => {
    expect(localCapabilityProfile.commands).toEqual([]);
    expect(railwayCapabilityProfile.commands).toEqual([
      "ship-init", "ship-plan", "ship-apply", "ship-status", "ship-logs", "ship-rollback",
    ]);
    expect(vercelCapabilityProfile.commands).toEqual([]);
    expect(cloudflareCapabilityProfile.commands).toEqual([]);
    expect(neonCapabilityProfile.commands).toEqual([]);
  });
});
