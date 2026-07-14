import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "./errors.js";

export const ArgvCommandSchema = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
});

export const ManifestSchema = Type.Object(
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

export type Manifest = Static<typeof ManifestSchema>;

export async function loadManifest(cwd: string): Promise<Manifest> {
  const path = join(cwd, "pi-ship.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw err("E_CONFIG_INVALID", `manifest not found at ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw err("E_CONFIG_INVALID", `invalid JSON in ${path}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw err("E_CONFIG_INVALID", "manifest must be a JSON object");
  }
  if (!Value.Check(ManifestSchema, parsed)) {
    let first:
      | { instancePath: string; message: string; keyword?: string; params?: Record<string, unknown> }
      | undefined;
    for (const e of Value.Errors(ManifestSchema, parsed)) {
      first = e as {
        instancePath: string;
        message: string;
        keyword?: string;
        params?: Record<string, unknown>;
      };
      break;
    }
    const path = first?.instancePath.slice(1).replace(/\//g, ".") || "manifest";
    let message: string;
    if (first?.keyword === "additionalProperties" && Array.isArray(first.params?.additionalProperties)) {
      const key = first.params.additionalProperties[0] as string;
      message = `${path}.${key} is not a valid key`;
    } else {
      message = first ? `${path} ${first.message}` : "manifest validation failed";
    }
    throw err("E_CONFIG_INVALID", message);
  }
  return parsed as Manifest;
}
