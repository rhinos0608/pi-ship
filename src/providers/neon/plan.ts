import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";
import type { Environment } from "../../core/types.js";
import { canonicalize as coreCanonicalize } from "../../core/canonicalize.js";
import type { NeonManifest } from "./manifest.js";
import { NeonManifestSchema } from "./manifest.js";

const Strict = { additionalProperties: false } as const;

export const NeonPlanSchema = Type.Object({
  planId: Type.String({ minLength: 1 }),
  planDigest: Type.String({ minLength: 1 }),
  provider: Type.Literal("neon"),
  environment: Type.Union([Type.Literal("development"), Type.Literal("preview"), Type.Literal("production")]),
  intent: Type.Union([Type.Literal("provision"), Type.Literal("migration"), Type.Literal("preview"), Type.Literal("rollback")]),
  manifest: NeonManifestSchema,
  secretNames: Type.Array(Type.String()),
  migrationCommand: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  previewExpiresAt: Type.Optional(Type.String({ minLength: 1 })),
  restoreTimestamp: Type.Optional(Type.String({ minLength: 1 })),
  targetBranchId: Type.Optional(Type.String({ minLength: 1 })),
  sourceBranchId: Type.Optional(Type.String({ minLength: 1 })),

  createdAt: Type.String({ minLength: 1 }),
}, Strict);

export type NeonPlan = Static<typeof NeonPlanSchema>;

export interface BuildNeonPlanOptions {
  planId?: string;
  createdAt?: string;
  migrationCommand?: string[];
  previewExpiresAt?: string;
  restoreTimestamp?: string;
  targetBranchId?: string;
  sourceBranchId?: string;

}

export function computeDigest(plan: Omit<NeonPlan, "planDigest">): string {
  const input = plan as Record<string, unknown>;
  const { planDigest: _, ...rest } = input;
  return createHash("sha256").update(coreCanonicalize(rest)).digest("hex");
}

export const computePlanDigest = computeDigest;

export function isNeonPlan(value: unknown): value is NeonPlan {
  return Value.Check(NeonPlanSchema, value);
}

export function buildNeonPlan(
  manifest: NeonManifest,
  environment: Environment,
  intent: "provision" | "migration" | "preview" | "rollback",
  options: BuildNeonPlanOptions = {},
): NeonPlan {
  if (intent === "migration" && (!options.migrationCommand || !options.migrationCommand.length)) {
    throw err("E_CONFIG_INVALID", "migrationCommand is required for migration intent");
  }
  if (intent === "rollback") {
    if (!options.restoreTimestamp) {
      throw err("E_CONFIG_INVALID", "restoreTimestamp is required for rollback intent");
    }
    if (!options.sourceBranchId) {
      throw err("E_CONFIG_INVALID", "sourceBranchId is required for rollback intent");
    }
    if (!options.targetBranchId) {
      throw err("E_CONFIG_INVALID", "targetBranchId is required for rollback intent");
    }
  }
  const secretNames: string[] = ["NEON_API_KEY"];
  if (intent === "migration") {
    secretNames.push("DATABASE_URL");
  }

  const base: Omit<NeonPlan, "planDigest"> = {
    planId: options.planId ?? randomUUID(),
    provider: "neon",
    environment,
    intent,
    manifest,
    secretNames,
    migrationCommand: options.migrationCommand,
    previewExpiresAt: options.previewExpiresAt,
    restoreTimestamp: options.restoreTimestamp,
    targetBranchId: options.targetBranchId,
    sourceBranchId: options.sourceBranchId,

    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  const planDigest = computeDigest(base);
  return { ...base, planDigest };
}
