import { isAbsolute, posix } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";

const NonEmpty = Type.String({ minLength: 1 });
const Strict = { additionalProperties: false } as const;

export const VercelManifestSchema = Type.Object({
  version: Type.Literal(2),
  name: NonEmpty,
  app: Type.Object({
    provider: Type.Literal("vercel"),
    config: Type.Object({
      projectName: NonEmpty,
      teamId: Type.Optional(NonEmpty),
      rootDirectory: Type.Optional(NonEmpty),
    }, Strict),
  }, Strict),
  database: Type.Optional(Type.Object({
    provider: Type.Literal("external"),
    config: Type.Object({ urlSecretName: NonEmpty }, Strict),
  }, Strict)),
  checks: Type.Optional(Type.Array(Type.Array(NonEmpty, { minItems: 1 }), { minItems: 1 })),
  secrets: Type.Optional(Type.Array(NonEmpty, { minItems: 1 })),
}, Strict);

export type VercelManifest = Static<typeof VercelManifestSchema>;

export function validateVercelManifestSemantics(manifest: VercelManifest): void {
  const root = manifest.app.config.rootDirectory;
  if (root !== undefined) {
    const segments = root.split("/");
    if (isAbsolute(root) || root.includes("\\") || root.includes("\0") || segments.some((segment) => segment === ".." || segment === "") || posix.normalize(root) !== root) {
      throw err("E_CONFIG_INVALID", "rootDirectory must be relative, normalized, and inside cwd");
    }
  }
  if (manifest.database && !(manifest.secrets ?? []).includes(manifest.database.config.urlSecretName)) {
    throw err("E_CONFIG_INVALID", "database.config.urlSecretName must appear in secrets");
  }
}

export function isVercelManifest(value: unknown): value is VercelManifest {
  return Value.Check(VercelManifestSchema, value);
}
