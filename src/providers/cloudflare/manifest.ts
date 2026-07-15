import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";

const Strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1 });

export const CloudflareManifestSchema = Type.Object({
  provider: Type.Literal("cloudflare"),
  version: Type.Literal(1),
  accountId: NonEmpty,
  name: NonEmpty,
  mainModule: NonEmpty,
  compatibilityDate: NonEmpty,
  compatibilityFlags: Type.Optional(Type.Array(NonEmpty)),
  secrets: Type.Optional(Type.Array(NonEmpty, { minItems: 1 })),
  source: Type.Optional(Type.String()),
}, Strict);

export type CloudflareManifest = Static<typeof CloudflareManifestSchema>;

export function isCloudflareManifest(value: unknown): value is CloudflareManifest {
  return Value.Check(CloudflareManifestSchema, value);
}

export function validateCloudflareManifest(value: unknown): asserts value is CloudflareManifest {
  if (!isCloudflareManifest(value)) {
    throw err("E_CONFIG_INVALID", "manifest has invalid Cloudflare provider shape");
  }
}
