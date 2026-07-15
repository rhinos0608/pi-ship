import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "../../core/errors.js";
import { readPersisted, saveAtomic } from "../../persistence/state-store.js";

const Strict = { additionalProperties: false } as const;
const Account = Type.Object({ kind: Type.Union([Type.Literal("team"), Type.Literal("user")]), id: Type.String({ minLength: 1 }) }, Strict);
const ReleaseStatus = Type.Union([Type.Literal("queued"), Type.Literal("building"), Type.Literal("ready"), Type.Literal("error"), Type.Literal("cancelled"), Type.Literal("blocked"), Type.Literal("unknown")]);
const AppEnvironment = Type.Object({ targetFingerprint: Type.String({ minLength: 1 }), lastRelease: Type.Optional(Type.Object({ id: Type.String({ minLength: 1 }), planId: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }), status: ReleaseStatus, url: Type.Optional(Type.String()), at: Type.String({ minLength: 1 }) }, Strict)) }, Strict);
const App = Type.Object({ provider: Type.Literal("vercel"), account: Account, accountFingerprint: Type.String({ minLength: 1 }), project: Type.Object({ id: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }), fingerprint: Type.String({ minLength: 1 }) }, Strict), environments: Type.Object({ preview: Type.Optional(AppEnvironment), production: Type.Optional(AppEnvironment) }, Strict) }, Strict);
const Database = Type.Record(Type.String({ minLength: 1 }), Type.Object({ provider: Type.Literal("external"), connectionSecretName: Type.String({ minLength: 1 }), targetFingerprint: Type.String({ minLength: 1 }) }, Strict));
export const VercelStateSchema = Type.Object({ version: Type.Literal(2), app: Type.Optional(App), databases: Database, releases: Type.Array(Type.Object({ provider: Type.Literal("vercel"), projectId: Type.String({ minLength: 1 }), environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]), releaseId: Type.String({ minLength: 1 }), planId: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }), url: Type.Optional(Type.String()), at: Type.String({ minLength: 1 }) }, Strict)), history: Type.Array(Type.Object({ planId: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }), domain: Type.Literal("app"), provider: Type.Literal("vercel"), status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]), at: Type.String({ minLength: 1 }) }, Strict)) }, Strict);
export type VercelState = Static<typeof VercelStateSchema>;

export function isVercelState(value: unknown): value is VercelState {
  return Value.Check(VercelStateSchema, value);
}

export function defaultVercelState(): VercelState { return { version: 2, databases: {}, releases: [], history: [] }; }

/**
 * Load Vercel state from persisted state.json.
 * Validates only against Vercel schema. Cross-provider conflict detection
 * is handled by the registry layer via package conflictMessage.
 */
export async function loadVercelState(cwd: string): Promise<VercelState> {
  const value = await readPersisted(cwd);
  if (value === undefined) return defaultVercelState();
  if (isVercelState(value)) return value;
  throw err("E_CONFIG_INVALID", "state.json has invalid shape");
}

/**
 * Save Vercel state atomically.
 * Validates only against Vercel schema. Cross-provider overwrite protection
 * is handled by the registry layer via package conflictMessage.
 */
export async function saveVercelState(cwd: string, state: VercelState): Promise<void> {
  if (!isVercelState(state)) throw err("E_CONFIG_INVALID", "state has invalid shape");
  const existing = await readPersisted(cwd);
  if (existing !== undefined && !isVercelState(existing)) {
    throw err("E_CONFIG_INVALID", "state.json has invalid shape");
  }
  await saveAtomic(cwd, state);
}
