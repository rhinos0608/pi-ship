import { Type, type Static } from "typebox";

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
export const DBSchema = Type.Union([
  Type.Object({ action: Type.Literal("inspect") }, strict),
  Type.Object({
    action: Type.Literal("browse"),
    schema: Type.Optional(Type.String({ minLength: 1, maxLength: 100000 })),
    table: Type.String({ minLength: 1, maxLength: 100000 }),
    columns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100000 }), { maxItems: 100 })),
    filters: Type.Optional(Type.Array(DBFilterSchema, { maxItems: 50 })),
    orderBy: Type.Optional(Type.Array(DBOrderSchema, { maxItems: 20 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  }, strict),
  Type.Object({
    action: Type.Literal("query"),
    sql: Type.String({ minLength: 1, maxLength: 100000 }),
    params: parameters,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }, strict),
  Type.Object({
    action: Type.Literal("plan"),
    sql: Type.String({ minLength: 1, maxLength: 100000 }),
    params: parameters,
  }, strict),
  Type.Object({ action: Type.Literal("plan_migration") }, strict),
  Type.Object({ action: Type.Literal("migration_status") }, strict),
  Type.Object({
    action: Type.Literal("apply_plan"),
    planId: Type.String({ minLength: 1 }),
    planDigest: Type.String({ minLength: 1 }),
  }, strict),
]);

export type DBInput = Static<typeof DBSchema>;
export type DBValue = Static<typeof DBValueSchema>;
export type DBFilter = Static<typeof DBFilterSchema>;
export type DBOrder = Static<typeof DBOrderSchema>;
