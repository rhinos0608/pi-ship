/**
 * Generic atomic JSON I/O utilities.
 * No provider imports — pure file-system helpers.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err } from "../core/errors.js";

/** Read and parse a JSON file; return undefined on ENOENT. */
export async function readJSON(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw err("E_CONFIG_INVALID", `invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

/** Write data atomically to a JSON file (tmp + rename). */
export async function writeJSONAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
