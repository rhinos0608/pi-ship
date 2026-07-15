import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";
import { readPersisted, saveAtomic } from "../../persistence/state-store.js";

const Strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1 });

const WorkerStateSchema = Type.Object({
  name: NonEmpty,
  etag: Type.Optional(NonEmpty),
}, Strict);

const DeploymentRefSchema = Type.Object({
  id: NonEmpty,
  versionId: NonEmpty,
  planId: NonEmpty,
  digest: NonEmpty,
  at: NonEmpty,
}, Strict);

const HistoryEntrySchema = Type.Object({
  planId: NonEmpty,
  digest: NonEmpty,
  status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
  at: NonEmpty,
}, Strict);

export const CloudflareStateSchema = Type.Object({
  provider: Type.Literal("cloudflare"),
  version: Type.Literal(1),
  accountId: Type.Optional(NonEmpty),
  worker: Type.Optional(WorkerStateSchema),
  deployments: Type.Array(DeploymentRefSchema),
  history: Type.Array(HistoryEntrySchema),
}, Strict);

export type CloudflareState = Static<typeof CloudflareStateSchema>;

export function isCloudflareState(value: unknown): value is CloudflareState {
  return Value.Check(CloudflareStateSchema, value);
}

export function defaultCloudflareState(): CloudflareState {
  return { provider: "cloudflare", version: 1, deployments: [], history: [] };
}

export async function loadCloudflareState(cwd: string): Promise<CloudflareState> {
  const value = await readPersisted(cwd);
  if (value === undefined) return defaultCloudflareState();
  if (isCloudflareState(value)) return value;
  throw err("E_CONFIG_INVALID", "state.json has invalid Cloudflare state shape");
}

export async function saveCloudflareState(cwd: string, state: CloudflareState): Promise<void> {
  if (!isCloudflareState(state)) throw err("E_CONFIG_INVALID", "Cloudflare state has invalid shape");
  const existing = await readPersisted(cwd);
  if (existing !== undefined && !isCloudflareState(existing)) {
    throw err("E_CONFIG_INVALID", "state.json has invalid shape");
  }
  await saveAtomic(cwd, state);
}
