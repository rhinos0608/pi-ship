import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";
import { readPersisted, saveAtomic } from "../../persistence/state-store.js";

/**
 * Strip password from a PostgreSQL connection URI for safe storage.
 * postgresql://user:pass@host:port/db → postgresql://user:[REDACTED]@host:port/db
 */
export function redactConnectionUri(uri: string): string {
  try {
    const atIdx = uri.indexOf("@");
    const protocolEnd = uri.indexOf("://");
    if (atIdx === -1 || protocolEnd === -1) return "[REDACTED]";
    // Replace everything between colon after user and the @
    const userInfo = uri.slice(protocolEnd + 3, atIdx);
    const colonIdx = userInfo.indexOf(":");
    if (colonIdx === -1) return uri; // no password
    const user = userInfo.slice(0, colonIdx);
    return `${uri.slice(0, protocolEnd + 3)}${user}:[REDACTED]${uri.slice(atIdx)}`;
  } catch {
    return "[REDACTED]";
  }
}

const Strict = { additionalProperties: false } as const;

const HistoryEntry = Type.Object({
  planId: Type.String({ minLength: 1 }),
  digest: Type.String({ minLength: 1 }),
  status: Type.String({ minLength: 1 }),
  at: Type.String({ minLength: 1 }),
}, Strict);

const RestorePointEntry = Type.Object({
  planId: Type.String({ minLength: 1 }),
  planDigest: Type.String({ minLength: 1 }),
  projectId: Type.String({ minLength: 1 }),
  branchId: Type.String({ minLength: 1 }),
  timestamp: Type.String({ minLength: 1 }),
  at: Type.String({ minLength: 1 }),
}, Strict);

export const NeonStateSchema = Type.Object({
  provider: Type.Literal("neon"),
  version: Type.Literal(1),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  projectName: Type.Optional(Type.String({ minLength: 1 })),
  branchIds: Type.Record(Type.String(), Type.String()),
  connectionUris: Type.Record(Type.String(), Type.String()),
  history: Type.Array(HistoryEntry),
  restorePoints: Type.Optional(Type.Array(RestorePointEntry)),
}, Strict);

export type NeonState = Static<typeof NeonStateSchema>;

export function defaultNeonState(): NeonState {
  return {
    version: 1,
    provider: "neon",
    branchIds: {},
    connectionUris: {},
    history: [],
    restorePoints: [],
  };
}

export function isNeonState(value: unknown): value is NeonState {
  return Value.Check(NeonStateSchema, value);
}

export async function loadNeonState(cwd: string): Promise<NeonState> {
  const value = await readPersisted(cwd);
  if (value === undefined) return defaultNeonState();
  if (isNeonState(value)) return value;
  throw err("E_CONFIG_INVALID", "state.json has invalid shape for Neon provider");
}

export async function saveNeonState(cwd: string, state: NeonState): Promise<void> {
  if (!isNeonState(state)) throw err("E_CONFIG_INVALID", "state has invalid shape");
  const existing = await readPersisted(cwd);
  if (existing !== undefined && !Value.Check(NeonStateSchema, existing)) {
    throw err("E_CONFIG_INVALID", "state.json has invalid shape");
  }
  await saveAtomic(cwd, state);
}
