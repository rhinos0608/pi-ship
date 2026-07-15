import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";

const Strict = { additionalProperties: false } as const;

export const NeonManifestSchema = Type.Object({
  provider: Type.Literal("neon"),
  version: Type.Literal(1),
  project: Type.String({ minLength: 1 }),
  pgVersion: Type.Optional(Type.Integer({ minimum: 14, maximum: 18 })),
  regionId: Type.Optional(Type.String({ minLength: 1 })),
  branch: Type.Optional(Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    databaseName: Type.Optional(Type.String({ minLength: 1 })),
    roleName: Type.Optional(Type.String({ minLength: 1 })),
  }, Strict)),
  compute: Type.Optional(Type.Object({
    minCu: Type.Optional(Type.Number({ minimum: 0.25 })),
    maxCu: Type.Optional(Type.Number({ minimum: 0.25 })),
    suspendTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  }, Strict)),
  migrations: Type.Optional(Type.Object({
    command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }, Strict)),
}, Strict);

export type NeonManifest = Static<typeof NeonManifestSchema>;

export function isNeonManifest(value: unknown): value is NeonManifest {
  return Value.Check(NeonManifestSchema, value);
}

function firstNeonError(value: unknown): {
  instancePath: string;
  message: string;
  keyword?: string;
  params?: Record<string, unknown>;
} | undefined {
  for (const e of Value.Errors(NeonManifestSchema, value)) {
    return e as {
      instancePath: string;
      message: string;
      keyword?: string;
      params?: Record<string, unknown>;
    };
  }
  return undefined;
}

function formatNeonManifestError(value: unknown): string {
  const first = firstNeonError(value);
  const path = first?.instancePath.slice(1).replace(/\//g, ".") || "manifest";
  if (first?.keyword === "additionalProperties" && Array.isArray(first.params?.additionalProperties)) {
    const key = first.params.additionalProperties[0] as string;
    return `${path}.${key} is not a valid key`;
  }
  return first ? `${path} ${first.message}` : "manifest validation failed";
}

function computeCuError(cu: number, label: string): string | undefined {
  // Neon CU sizes must be multiples of 0.25
  if (cu !== Math.round(cu * 4) / 4) {
    return `${label} ${cu} is not a valid CU size (must be multiple of 0.25)`;
  }
  return undefined;
}

export function validateNeonManifest(value: unknown): asserts value is NeonManifest {
  if (!Value.Check(NeonManifestSchema, value)) {
    throw err("E_CONFIG_INVALID", formatNeonManifestError(value));
  }
  const m = value as Record<string, unknown>;
  const compute = m.compute as Record<string, unknown> | undefined;
  if (compute) {
    const minCu = compute.minCu as number | undefined;
    const maxCu = compute.maxCu as number | undefined;
    if (minCu !== undefined) {
      const cuErr = computeCuError(minCu, "minCu");
      if (cuErr) throw err("E_CONFIG_INVALID", `compute.${cuErr}`);
    }
    if (maxCu !== undefined) {
      const cuErr = computeCuError(maxCu, "maxCu");
      if (cuErr) throw err("E_CONFIG_INVALID", `compute.${cuErr}`);
    }
    if (minCu !== undefined && maxCu !== undefined && minCu > maxCu) {
      throw err("E_CONFIG_INVALID", "compute.minCu must be <= compute.maxCu");
    }
  }
}
