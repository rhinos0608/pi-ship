import { Type, type Static, type TSchema } from "typebox";
import { err } from "../../core/errors.js";

const strict = { additionalProperties: false } as const;
const DBScalar = Type.Union([
  Type.String({ maxLength: 100000 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const DBValueSchema = DBScalar;
export const DBFilterSchema = Type.Union([
  Type.Object({
    column: Type.String({ minLength: 1, maxLength: 100000 }),
    op: Type.Union([Type.Literal("eq"), Type.Literal("neq"), Type.Literal("lt"), Type.Literal("lte"), Type.Literal("gt"), Type.Literal("gte"), Type.Literal("like"), Type.Literal("ilike")]),
    value: DBValueSchema,
  }, strict),
  Type.Object({
    column: Type.String({ minLength: 1, maxLength: 100000 }),
    op: Type.Union([Type.Literal("is_null"), Type.Literal("not_null")]),
  }, strict),
]);
export const DBOrderSchema = Type.Object({
  column: Type.String({ minLength: 1, maxLength: 100000 }),
  direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
  nulls: Type.Optional(Type.Union([Type.Literal("first"), Type.Literal("last")])),
}, strict);

const parameters = Type.Optional(Type.Array(DBValueSchema, { maxItems: 100 }));

// ── Individual DB action variants ─────────────────────────────────────────

export const inspectVariant = Type.Object({ action: Type.Literal("inspect") }, strict);

export const browseVariant = Type.Object({
  action: Type.Literal("browse"),
  schema: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })),
  table: Type.String({ minLength: 1, maxLength: 100000 }),
  columns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100000 }), { maxItems: 100 })),
  filters: Type.Optional(Type.Array(DBFilterSchema, { maxItems: 50 })),
  orderBy: Type.Optional(Type.Array(DBOrderSchema, { maxItems: 20 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
}, strict);

export const queryVariant = Type.Object({
  action: Type.Literal("query"),
  sql: Type.String({ minLength: 1, maxLength: 100000 }),
  params: parameters,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, strict);

export const planVariant = Type.Object({
  action: Type.Literal("plan"),
  sql: Type.String({ minLength: 1, maxLength: 100000 }),
  params: parameters,
}, strict);

export const planMigrationVariant = Type.Object({ action: Type.Literal("plan_migration") }, strict);

export const migrationStatusVariant = Type.Object({ action: Type.Literal("migration_status") }, strict);

export const applyPlanVariant = Type.Object({
  action: Type.Literal("apply_plan"),
  planId: Type.String({ minLength: 1 }),
  planDigest: Type.String({ minLength: 1 }),
}, strict);

export const importVariant = Type.Object({
  action: Type.Literal("import"),
  table: Type.String({ minLength: 1, maxLength: 100000 }),
  format: Type.Union([Type.Literal("json"), Type.Literal("csv")]),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })),
  rows: Type.Optional(
    Type.Array(
      Type.Object({}, { additionalProperties: true }),
      { maxItems: 5000 },
    ),
  ),
  mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("append")])),
}, strict);

export const resetVariant = Type.Object({ action: Type.Literal("reset") }, strict);

// ── Shared base DB variants (every profile gets these) ────────────────────
export const sharedDBVariants = [
  inspectVariant,
  browseVariant,
  queryVariant,
  planVariant,
  migrationStatusVariant,
  applyPlanVariant,
  importVariant,
  resetVariant,
] as const;

// ── Schema composer ─────────────────────────────────────────────────────
/**
 * Compose a DB schema from shared variants plus provider additions.
 * Always includes the eight common shared actions.
 */
export function composeDBSchema(additions: readonly TSchema[]): TSchema {
  const all = [...sharedDBVariants, ...additions];
  // Reject duplicate action discriminators (defense against misconfigured additions)
  const seen = new Set<string>();
  for (const variant of all) {
    const schema = variant as { type?: string; properties?: Record<string, unknown> };
    if (schema.type === "object" && schema.properties?.action && typeof schema.properties.action === "object") {
      const actionSchema = schema.properties.action as { const?: string };
      if (actionSchema.const && seen.has(actionSchema.const)) {
        throw err("E_CONFIG_INVALID", `duplicate DB action discriminator: ${actionSchema.const}`);
      }
      if (actionSchema.const) seen.add(actionSchema.const);
    }
  }
  return Type.Union([...all]);
}

// ── Public broad schema (inline for TypeScript discriminator narrowing) ──
export const DBSchema = Type.Union([
  inspectVariant,
  browseVariant,
  queryVariant,
  planVariant,
  migrationStatusVariant,
  applyPlanVariant,
  importVariant,
  resetVariant,
  planMigrationVariant,
]);

export type DBInput = Static<typeof DBSchema>;
export type DBValue = Static<typeof DBValueSchema>;
export type DBFilter = Static<typeof DBFilterSchema>;
export type DBOrder = Static<typeof DBOrderSchema>;
