import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Dynamic import — lazy-loads PGlite only when local target is used. */
async function importPGlite(): Promise<typeof import("@electric-sql/pglite")> {
  return import("@electric-sql/pglite");
}

type PGliteInstance = InstanceType<Awaited<ReturnType<typeof importPGlite>>["PGlite"]>;

const instances = new Map<string, PGliteInstance>();
const inits = new Map<string, Promise<void>>();

/**
 * Get or create a PGlite instance for the given datadir.
 * Cached per-process. ~500ms cold start paid once per datadir.
 * Operations on a given datadir are implicitly serialized (PGlite is single-connection).
 */
export async function getPGliteInstance(dataDir: string): Promise<PGliteInstance> {
  const existing = instances.get(dataDir);
  if (existing) return existing;

  const pending = inits.get(dataDir);
  if (pending) {
    await pending;
    return instances.get(dataDir)!;
  }

  const promise = (async () => {
    const { PGlite } = await importPGlite();
    // Ensure parent directory exists — PGlite's WASM FS may fail
    // to create intermediate directories when a path component
    // starts with a dot (e.g. .pi-ship/local-db).
    const parentDir = dirname(dataDir);
    if (parentDir && parentDir !== ".") {
      await mkdir(parentDir, { recursive: true }).catch(() => {});
    }
    const instance = new PGlite(dataDir);
    instances.set(dataDir, instance as PGliteInstance);
  })();

  inits.set(dataDir, promise);
  try {
    await promise;
  } finally {
    inits.delete(dataDir);
  }

  return instances.get(dataDir)!;
}

/**
 * Close and remove a cached PGlite instance.
 * Used by reset and process cleanup.
 */
export async function closePGliteInstance(dataDir: string): Promise<void> {
  const instance = instances.get(dataDir);
  if (instance) {
    instances.delete(dataDir);
    try { await instance.close(); } catch { /* best-effort */ }
  }
}

/**
 * Wipe the local datadir and remove from cache.
 * Deletes the directory, then removes the in-memory cache entry.
 */
export async function resetPGliteInstance(dataDir: string): Promise<void> {
  await closePGliteInstance(dataDir);
  await rm(dataDir, { recursive: true, force: true });
}
