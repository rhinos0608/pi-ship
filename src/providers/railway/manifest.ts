import { readJSON } from "../../persistence/json.js";
import { manifestPath } from "../../persistence/manifest-store.js";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";

export const ArgvCommandSchema = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
});

export const RailwayManifestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    provider: Type.Literal("railway"),
    project: Type.String({ minLength: 1 }),
    run: Type.Object(
      {
        command: ArgvCommandSchema,
      },
      { additionalProperties: false }
    ),
    build: Type.Optional(
      Type.Object(
        {
          command: ArgvCommandSchema,
        },
        { additionalProperties: false }
      )
    ),
    checks: Type.Optional(Type.Array(ArgvCommandSchema, { minItems: 1 })),
    secrets: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    db: Type.Optional(
      Type.Object(
        {
          migrate: Type.Optional(
            Type.Object(
              {
                command: ArgvCommandSchema,
                allowProductionMigrations: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false }
            )
          ),
          provision: Type.Optional(
            Type.Union([Type.Literal("railway-postgres"), Type.Literal("external")])
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export type RailwayManifest = Static<typeof RailwayManifestSchema>;

export function isRailwayManifest(value: unknown): value is RailwayManifest { return Value.Check(RailwayManifestSchema, value); }

function firstRailwayError(value: unknown): {
  instancePath: string;
  message: string;
  keyword?: string;
  params?: Record<string, unknown>;
} | undefined {
  for (const e of Value.Errors(RailwayManifestSchema, value)) {
    return e as {
      instancePath: string;
      message: string;
      keyword?: string;
      params?: Record<string, unknown>;
    };
  }
  return undefined;
}

/** Format first Railway TypeBox error into a human-readable message. */
export function formatRailwayManifestError(value: unknown): string {
  const first = firstRailwayError(value);
  const path = first?.instancePath.slice(1).replace(/\//g, ".") || "manifest";
  if (first?.keyword === "additionalProperties" && Array.isArray(first.params?.additionalProperties)) {
    const key = first.params.additionalProperties[0] as string;
    return `${path}.${key} is not a valid key`;
  }
  return first ? `${path} ${first.message}` : "manifest validation failed";
}

/** Validate a raw manifest value against RailwayManifestSchema, throwing detailed E_CONFIG_INVALID. */
export function validateRailwayManifest(value: unknown): asserts value is RailwayManifest {
  if (!Value.Check(RailwayManifestSchema, value)) {
    throw err("E_CONFIG_INVALID", formatRailwayManifestError(value));
  }
}

/**
 * Load and validate a Railway manifest from the default manifest path.
 * Returns typed RailwayManifest. For cross-provider loading, use the registry.
 */
export async function loadRailwayManifest(cwd: string): Promise<RailwayManifest> {
  const parsed = await readJSON(manifestPath(cwd));
  if (parsed === undefined) {
    throw err("E_CONFIG_INVALID", `manifest not found at ${manifestPath(cwd)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw err("E_CONFIG_INVALID", "manifest must be a JSON object");
  }
  validateRailwayManifest(parsed);
  return parsed as RailwayManifest;
}
