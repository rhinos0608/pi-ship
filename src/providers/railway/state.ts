import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";
import { readPersisted, saveAtomic } from "../../persistence/state-store.js";

const Strict = { additionalProperties: false } as const;
const Service = Type.Object({ app: Type.Optional(Type.String()), postgres: Type.Optional(Type.String()) }, Strict);
const Release = Type.Object({ id: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }), url: Type.Optional(Type.String()), at: Type.String({ minLength: 1 }) }, Strict);
const History = Type.Object({ planId: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }), at: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]) }, Strict);
export const PreviewState = Type.Object({
  environmentId: Type.String(),
  serviceId: Type.String(),
  projectId: Type.String(),
  postgresServiceId: Type.Optional(Type.String()),
  createdAt: Type.String(),
}, Strict);

const V1LocalStateSchema = Type.Object({ version: Type.Literal(1), provider: Type.Literal("railway"), projectId: Type.Optional(Type.String()), projectName: Type.Optional(Type.String()), environmentId: Type.Optional(Type.String()), environmentName: Type.Optional(Type.String()), serviceIds: Service, serviceNames: Type.Optional(Service), lastRelease: Type.Optional(Release), history: Type.Array(History) }, Strict);

const LocalStateSchema = Type.Object({ version: Type.Literal(2), provider: Type.Literal("railway"), projectId: Type.Optional(Type.String()), projectName: Type.Optional(Type.String()), environmentId: Type.Optional(Type.String()), environmentName: Type.Optional(Type.String()), serviceIds: Service, serviceNames: Type.Optional(Service), lastRelease: Type.Optional(Release), history: Type.Array(History), previews: Type.Optional(Type.Record(Type.String(), PreviewState)) }, Strict);
export type LocalState = Static<typeof LocalStateSchema>;

export function isRailwayState(value: unknown): value is LocalState {
  if (Value.Check(LocalStateSchema, value)) return true;
  if (Value.Check(V1LocalStateSchema, value)) {
    const v1 = value as { version: number; previews?: Record<string, unknown> };
    v1.version = 2;
    v1.previews = {};
    return true;
  }
  return false;
}

export function defaultState(): LocalState { return { version: 2, provider: "railway", environmentId: undefined, environmentName: "production", serviceIds: {}, serviceNames: {}, history: [], previews: {} }; }

/**
 * Load Railway state from the persisted state.json.
 * Validates only against Railway schema. Cross-provider conflict detection
 * is handled by the registry layer via package conflictMessage.
 */
export async function loadRailwayState(cwd: string): Promise<LocalState> {
  const value = await readPersisted(cwd);
  if (value === undefined) return defaultState();
  if (isRailwayState(value)) return value;
  throw err("E_CONFIG_INVALID", "state.json has invalid shape");
}

/**
 * Save Railway state atomically.
 * Validates only against Railway schema. Cross-provider overwrite protection
 * is handled by the registry layer via package conflictMessage.
 */
export async function saveRailwayState(cwd: string, state: LocalState): Promise<void> {
  if (!isRailwayState(state)) throw err("E_CONFIG_INVALID", "state has invalid shape");
  const existing = await readPersisted(cwd);
  if (existing !== undefined && !Value.Check(LocalStateSchema, existing)) {
    throw err("E_CONFIG_INVALID", "state.json has invalid shape");
  }
  await saveAtomic(cwd, state);
}
