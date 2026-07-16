import { resetPGliteInstance, getPGliteInstance } from "./local/instance-cache.js";
import { err } from "../core/errors.js";

/**
 * Wipe the local database datadir and recreate an empty instance.
 * This closes the cached PGlite instance, deletes the data directory,
 * and creates a fresh empty database.
 *
 * Local target only. Caller must gate this to local targets.
 */
export async function resetLocalDatabase(dataDir: string): Promise<void> {
  try {
    await resetPGliteInstance(dataDir);
    // Re-initialize so the next operation has a fresh empty database
    await getPGliteInstance(dataDir);
  } catch (cause) {
    throw err(
      "E_PROVIDER",
      "database reset failed; local database may be in inconsistent state",
      false,
      undefined,
      { cause },
    );
  }
}
