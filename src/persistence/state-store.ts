import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err } from "../core/errors.js";
import type { ProviderPackage } from "../providers/contracts.js";

export function statePath(cwd: string): string {
  return join(cwd, ".pi-ship", "state.json");
}

export async function readPersisted(cwd: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(statePath(cwd), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw err("E_CONFIG_INVALID", `state.json is invalid JSON: ${error.message}`);
    throw error;
  }
}

export async function loadRegisteredState(
  cwd: string,
  expected: ProviderPackage,
  packages: readonly ProviderPackage[],
): Promise<unknown> {
  const state = await readPersisted(cwd);
  if (state === undefined) return expected.defaultState();
  const owners = packages.filter((candidate) => candidate.isState(state));
  if (owners.length > 1) {
    throw err("E_CONFIG_INVALID", "ambiguous state contract matched multiple provider packages");
  }
  const owner = owners[0];
  if (owner && owner.id !== expected.id) {
    throw err("E_STATE_CONFLICT", expected.conflictMessage.loadStateFromOther);
  }
  if (!owner) {
    // Try to detect provider from raw state to give a better error
    if (state && typeof state === "object" && "provider" in state) {
      const rawProvider = (state as Record<string, unknown>).provider;
      if (typeof rawProvider === "string" && rawProvider !== expected.id) {
        throw err("E_STATE_CONFLICT", expected.conflictMessage.loadStateFromOther);
      }
    }
    // Fallback: probe all packages for the state
    for (const pkg of packages) {
      if (pkg.id !== expected.id && pkg.isState(state)) {
        throw err("E_STATE_CONFLICT", expected.conflictMessage.loadStateFromOther);
      }
    }
    throw err("E_CONFIG_INVALID", "state.json has invalid shape");
  }
  if (owner.id !== expected.id) {
    throw err("E_STATE_CONFLICT", expected.conflictMessage.loadStateFromOther);
  }
  return state;
}

export async function saveRegisteredState(
  cwd: string,
  state: unknown,
  expected: ProviderPackage,
  packages: readonly ProviderPackage[],
): Promise<void> {
  if (!expected.isState(state)) {
    throw err("E_CONFIG_INVALID", expected.stateInvalidSaveMessage ?? "state has invalid shape");
  }
  const existing = await readPersisted(cwd);
  if (existing !== undefined) {
    const owners = packages.filter((candidate) => candidate.isState(existing));
    if (owners.length > 1) {
      throw err("E_CONFIG_INVALID", "ambiguous state contract matched multiple provider packages");
    }
    const owner = owners[0];
    if (owner && owner.id !== expected.id) {
      throw err("E_STATE_CONFLICT", expected.conflictMessage.saveStateOverOther);
    }
    if (!owner) {
      // Try to detect provider from raw state to give a better error
      if (existing && typeof existing === "object" && "provider" in existing) {
        const rawProvider = (existing as Record<string, unknown>).provider;
        if (typeof rawProvider === "string" && rawProvider !== expected.id) {
          throw err("E_STATE_CONFLICT", expected.conflictMessage.saveStateOverOther);
        }
      }
      // Fallback: probe all packages for the state
      for (const pkg of packages) {
        if (pkg.id !== expected.id && pkg.isState(existing)) {
          throw err("E_STATE_CONFLICT", expected.conflictMessage.saveStateOverOther);
        }
      }
      throw err("E_CONFIG_INVALID", "state.json has invalid shape");
    }
    if (owner.id !== expected.id) {
      throw err("E_STATE_CONFLICT", expected.conflictMessage.saveStateOverOther);
    }
  }
  await saveAtomic(cwd, state);
}

export async function saveAtomic(cwd: string, state: unknown): Promise<void> {
  const path = statePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}
