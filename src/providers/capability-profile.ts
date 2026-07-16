import type { TSchema } from "typebox";
import type { ProviderPackage } from "./contracts.js";
import {
  validateVariant,
  railwayPreviewPlanVariant,
  railwayProductionPlanVariant,
  standardPlanVariant,
  neonPlanVariant,
  rollbackPlanVariant,
  applyPlanVariant,
  statusVariant,
  logsVariant,
} from "../tools/ship/schema.js";
import { planMigrationVariant } from "../tools/db/schema.js";

export type ToolName = "ship" | "DB";
export type BoundaryResourceName =
  | "railway-deployment"
  | "vercel-deployment"
  | "cloudflare-deployment"
  | "neon-control-plane";

export type ShipVariant = TSchema;
export type DBVariant = TSchema;

export interface ProviderCapabilityProfile {
  readonly id: string;
  readonly ship: readonly ShipVariant[];
  readonly databaseAdditions: readonly DBVariant[];
  readonly commands: readonly string[];
  readonly boundaryResource?: BoundaryResourceName;
}

export interface ProviderRuntimeBinding {
  readonly cwd: string;
  readonly manifest: unknown | undefined;
  readonly package: ProviderPackage | undefined;
  readonly profile: ProviderCapabilityProfile;
  readonly manifestBytesDigest: string | undefined;
  assertIntact(runtimeCwd: string): Promise<void>;
}

// ── Local profile (no manifest) ───────────────────────────────────────────
// No ship variants, no provider commands, no boundary resource.
// DB additions are empty — composeDBSchema adds all common actions.
export const localCapabilityProfile: ProviderCapabilityProfile = {
  id: "local",
  ship: [],
  databaseAdditions: [],
  commands: [],
};

// ── Railway profile ────────────────────────────────────────────────────────
// Ship: validate, plan (preview+previewId, production, rollback), apply_plan, status, logs
// DB addition: plan_migration
// Commands: ship-init, ship-plan, ship-apply, ship-status, ship-logs, ship-rollback
// Boundary: railway-deployment
export const railwayCapabilityProfile: ProviderCapabilityProfile = {
  id: "railway",
  ship: [
    validateVariant,
    railwayPreviewPlanVariant,
    railwayProductionPlanVariant,
    rollbackPlanVariant,
    applyPlanVariant,
    statusVariant,
    logsVariant,
  ],
  databaseAdditions: [planMigrationVariant],
  commands: [
    "ship-init",
    "ship-plan",
    "ship-apply",
    "ship-status",
    "ship-logs",
    "ship-rollback",
  ],
  boundaryResource: "railway-deployment",
};

// ── Vercel profile ────────────────────────────────────────────────────────
// Ship: validate, plan (preview/production, no previewId), apply_plan, status, logs
// No DB additions, no commands
// Boundary: vercel-deployment
export const vercelCapabilityProfile: ProviderCapabilityProfile = {
  id: "vercel",
  ship: [
    validateVariant,
    standardPlanVariant,
    rollbackPlanVariant,
    applyPlanVariant,
    statusVariant,
    logsVariant,
  ],
  databaseAdditions: [],
  commands: [],
  boundaryResource: "vercel-deployment",
};

// ── Cloudflare profile ──────────────────────────────────────────────────────
// Ship: validate, plan (preview/production, no previewId), apply_plan, status, logs
// No DB additions, no commands
// Boundary: cloudflare-deployment
export const cloudflareCapabilityProfile: ProviderCapabilityProfile = {
  id: "cloudflare",
  ship: [
    validateVariant,
    standardPlanVariant,
    rollbackPlanVariant,
    applyPlanVariant,
    statusVariant,
    logsVariant,
  ],
  databaseAdditions: [],
  commands: [],
  boundaryResource: "cloudflare-deployment",
};

// ── Neon profile ────────────────────────────────────────────────────────────
// Ship: validate, plan (development/preview/production), apply_plan, status
// No logs, DB addition: plan_migration, no commands
// Boundary: neon-control-plane
export const neonCapabilityProfile: ProviderCapabilityProfile = {
  id: "neon",
  ship: [
    validateVariant,
    neonPlanVariant,
    rollbackPlanVariant,
    applyPlanVariant,
    statusVariant,
  ],
  databaseAdditions: [planMigrationVariant],
  commands: [],
  boundaryResource: "neon-control-plane",
};
