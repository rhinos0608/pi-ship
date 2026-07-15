import { Type, type Static } from "typebox";

export const shipSchema = Type.Union(
  [
    Type.Object(
      {
        action: Type.Literal("validate"),
      },
      { additionalProperties: false }

    ),
    Type.Object({ action: Type.Literal("plan"), environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]), previewId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("plan"), environment: Type.Literal("production"), intent: Type.Literal("rollback"), targetReleaseId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object(
      {
        action: Type.Literal("apply_plan"),
        planId: Type.String({ minLength: 1 }),
        planDigest: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        action: Type.Literal("status"),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        action: Type.Literal("logs"),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      },
      { additionalProperties: false }
    ),
  ]
);

export type ShipInput = Static<typeof shipSchema>;
