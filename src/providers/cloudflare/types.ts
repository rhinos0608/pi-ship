import { Type, type Static } from "typebox";

// ── Config ─────────────────────────────────────────────────────────────────
export interface CloudflareClientConfig {
  /** Cloudflare API bearer token (required) */
  apiToken: string;
  /** Cloudflare account ID (required) */
  accountId: string;
  /** Base URL (default https://api.cloudflare.com/client/v4) */
  baseUrl?: string;
}

// ── Cloudflare API response wrapper ─────────────────────────────────────────
export const CloudflareErrorSchema = Type.Object({
  code: Type.Integer(),
  message: Type.String(),
});

export const CloudflareResponseSchema = Type.Object({
  success: Type.Boolean(),
  errors: Type.Array(CloudflareErrorSchema),
  result: Type.Optional(Type.Unknown()),
});

export type CloudflareError = Static<typeof CloudflareErrorSchema>;
export type CloudflareResponse<T = unknown> = {
  success: boolean;
  errors: CloudflareError[];
  result?: T;
};

// ── Worker Script ───────────────────────────────────────────────────────────
export const ScriptSchema = Type.Object({
  id: Type.String(),
  etag: Type.String(),
  handlers: Type.Array(Type.String()),
  created_on: Type.String(),
  modified_on: Type.String(),
  usage_model: Type.Optional(Type.String()),
});

export type Script = Static<typeof ScriptSchema>;

// ── Worker Version ──────────────────────────────────────────────────────────
export const VersionMetadataSchema = Type.Object({
  author_email: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
});

export const VersionResourcesSchema = Type.Object({
  bindings: Type.Optional(Type.Array(Type.Unknown())),
  script_runtime: Type.Optional(Type.String()),
});

export const VersionSchema = Type.Object({
  id: Type.String(),
  number: Type.Integer(),
  metadata: VersionMetadataSchema,
  resources: Type.Optional(VersionResourcesSchema),
});

export type Version = Static<typeof VersionSchema>;

// ── Worker Deployment ───────────────────────────────────────────────────────
export const DeploymentVersionSchema = Type.Object({
  version_id: Type.String(),
  percentage: Type.Integer(),
});

export const DeploymentAnnotationsSchema = Type.Object({
  workers_message: Type.Optional(Type.String()),
  authored_by: Type.Optional(Type.String()),
});

export const DeploymentSchema = Type.Object({
  id: Type.String(),
  created_on: Type.String(),
  source: Type.Optional(Type.String()),
  strategy: Type.Optional(Type.String()),
  versions: Type.Optional(Type.Array(DeploymentVersionSchema)),
  annotations: Type.Optional(DeploymentAnnotationsSchema),
});

export type Deployment = Static<typeof DeploymentSchema>;

// ── Worker Secret ───────────────────────────────────────────────────────────
export const SecretSchema = Type.Object({
  name: Type.String(),
  type: Type.Literal("secret_text"),
});

export type Secret = Static<typeof SecretSchema>;
