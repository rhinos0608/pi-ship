import { Type, type Static, type TSchema } from "typebox";

const strict = { additionalProperties: false } as const;

export const validateVariant = Type.Object({ action: Type.Literal("validate") }, strict);
export const railwayPreviewPlanVariant = Type.Object({
  action: Type.Literal("plan"),
  environment: Type.Literal("preview"),
  previewId: Type.String({ minLength: 1 }),
}, strict);
export const railwayProductionPlanVariant = Type.Object({
  action: Type.Literal("plan"),
  environment: Type.Literal("production"),
}, strict);
export const standardPlanVariant = Type.Object({
  action: Type.Literal("plan"),
  environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
}, strict);
/** Legacy compatibility: plan with optional previewId, used only in public shipSchema (not provider profiles). */
export const legacyPlanVariant = Type.Object({
  action: Type.Literal("plan"),
  environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
  previewId: Type.Optional(Type.String({ minLength: 1 })),
}, strict);
export const neonPlanVariant = Type.Object({
  action: Type.Literal("plan"),
  environment: Type.Union([Type.Literal("development"), Type.Literal("preview"), Type.Literal("production")]),
}, strict);
export const rollbackPlanVariant = Type.Object({
  action: Type.Literal("plan"),
  environment: Type.Literal("production"),
  intent: Type.Literal("rollback"),
  targetReleaseId: Type.String({ minLength: 1 }),
}, strict);
export const applyPlanVariant = Type.Object({
  action: Type.Literal("apply_plan"),
  planId: Type.String({ minLength: 1 }),
  planDigest: Type.String({ minLength: 1 }),
}, strict);
export const statusVariant = Type.Object({ action: Type.Literal("status") }, strict);
export const logsVariant = Type.Object({
  action: Type.Literal("logs"),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
}, strict);

export function composeShipSchema(variants: readonly TSchema[]): TSchema {
  if (variants.length === 0) return Type.Never();
  return Type.Union([...variants]);
}

export const shipSchema = Type.Union([
  validateVariant,
  railwayPreviewPlanVariant,
  railwayProductionPlanVariant,
  standardPlanVariant,
  legacyPlanVariant,
  neonPlanVariant,
  rollbackPlanVariant,
  applyPlanVariant,
  statusVariant,
  logsVariant,
]);

export type ShipInput = Static<typeof shipSchema>;

// ── Narrow per-action input types (shared contracts for provider handlers) ──
export type ValidateInput = Static<typeof validateVariant>;
export type StandardPlanInput = Static<typeof standardPlanVariant>;
export type RailwayPreviewPlanInput = Static<typeof railwayPreviewPlanVariant>;
export type RailwayProductionPlanInput = Static<typeof railwayProductionPlanVariant>;
export type NeonPlanInput = Static<typeof neonPlanVariant>;
export type RollbackPlanInput = Static<typeof rollbackPlanVariant>;
export type ApplyPlanInput = Static<typeof applyPlanVariant>;
export type StatusInput = Static<typeof statusVariant>;
export type LogsInput = Static<typeof logsVariant>;
