import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { err } from "../core/errors.js";

// ── Canonicalization (deterministic key-sorted JSON) ──────────────────────

function deepSort(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(deepSort);
  if (val && typeof val === "object" && !(val instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[key] = deepSort((val as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return val;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(deepSort(value));
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

export function computeEntryHash(entry: unknown): string {
  return createHash("sha256").update(canonicalize(entry)).digest("hex");
}

export function validateHashChain(entries: Array<{ entryHash: string; previousHash: string | null }>): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.previousHash !== (index ? entries[index - 1].entryHash : null)) {
      throw err("E_STATE_CONFLICT", `operation-journal hash chain broken at entry ${index}`);
    }
    const { entryHash, ...rest } = entry;
    if (entryHash !== computeEntryHash(rest)) {
      throw err("E_STATE_CONFLICT", `operation-journal entry ${index} hash mismatch`);
    }
  }
}

// ── Journal factory ──────────────────────────────────────────────────────────

export interface OperationJournal<TEntry extends { entryHash: string; previousHash: string | null }> {
  /** Full physical journal path. */
  path(cwd: string): string;
  /** Read, validate, optionally filter by planId. */
  read(cwd: string, filter?: { planId?: string }): Promise<TEntry[]>;
  /** Append a new entry, computing chain hash. */
  append(cwd: string, entry: Omit<TEntry, "entryHash" | "previousHash">): Promise<TEntry>;
}

export function createOperationJournal<TEntry extends { entryHash: string; previousHash: string | null }>(
  schema: TSchema,
  pathFn: (cwd: string) => string,
): OperationJournal<TEntry> {
  const withoutChain = Type.Omit(schema, ["entryHash", "previousHash"]);

  async function read(cwd: string, filter?: { planId?: string }): Promise<TEntry[]> {
    let text: string;
    try {
      text = await readFile(pathFn(cwd), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const all: TEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw err("E_STATE_CONFLICT", "operation-journal contains malformed entry");
      }
      if (!Value.Check(schema, parsed)) {
        throw err("E_STATE_CONFLICT", "operation-journal entry has invalid shape");
      }
      all.push(parsed as TEntry);
    }
    validateHashChain(all);
    if (filter?.planId) {
      // Trust boundary: schema validated, all entries have planId
      return all.filter((entry) => (entry as TEntry & { planId: string }).planId === filter.planId);
    }
    return all;
  }

  async function append(cwd: string, entry: Omit<TEntry, "entryHash" | "previousHash">): Promise<TEntry> {
    if (!Value.Check(withoutChain, entry)) {
      throw err("E_CONFIG_INVALID", "operation journal entry has invalid shape");
    }
    const all = await read(cwd);
    const previousHash = all.length ? all[all.length - 1].entryHash : null;
    // Trust boundary: schema-validated entry + deterministic chain hash
    const entryHash = computeEntryHash({ ...entry, previousHash });
    const complete = { ...entry, previousHash, entryHash } as TEntry;
    if (!Value.Check(schema, complete)) {
      throw err("E_CONFIG_INVALID", "operation journal entry has invalid shape");
    }
    await mkdir(dirname(pathFn(cwd)), { recursive: true });
    await appendFile(pathFn(cwd), `${JSON.stringify(complete)}\n`, "utf8");
    return complete;
  }

  return { path: pathFn, read, append };
}
