import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonicalize } from "../core/canonicalize.js";
import { err } from "../core/errors.js";
import type { Environment } from "../core/types.js";

const hex64 = { pattern: "^[0-9a-f]{64}$" } as const;
const strict = { additionalProperties: false } as const;

export const DatabaseJournalEntrySchema = Type.Object({
  version: Type.Literal(1),
  planId: Type.String({ minLength: 1, maxLength: 200 }),
  planDigest: Type.String(hex64),
  targetFingerprint: Type.String(hex64),
  providerFingerprint: Type.String(hex64),
  manifestFingerprint: Type.String(hex64),
  sqlFingerprint: Type.String(hex64),
  paramFingerprint: Type.String(hex64),
  environment: Type.Union([
    Type.Literal("development"),
    Type.Literal("preview"),
    Type.Literal("production"),
  ]),
  risk: Type.Union([
    Type.Literal("write"),
    Type.Literal("destructive"),
  ]),
  statementCount: Type.Integer({ minimum: 1, maximum: 20 }),
  status: Type.Union([
    Type.Literal("started"),
    Type.Literal("committed"),
    Type.Literal("failed"),
    Type.Literal("ambiguous"),
  ]),
  planKind: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  at: Type.String({ minLength: 1, maxLength: 100 }),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  previousHash: Type.Union([Type.String(hex64), Type.Null()]),
  hash: Type.String(hex64),
}, strict);

export type DatabaseJournalEntry = Static<typeof DatabaseJournalEntrySchema>;

export function databaseJournalPath(cwd: string): string {
  return join(cwd, ".pi-ship", "database-journal.jsonl");
}

function digest(e: Omit<DatabaseJournalEntry, "hash">): string {
  return createHash("sha256").update(canonicalize(e)).digest("hex");
}

function validateEntry(value: unknown): value is DatabaseJournalEntry {
  if (!Value.Check(DatabaseJournalEntrySchema, value)) return false;
  const entry = value as DatabaseJournalEntry;
  // Failed and ambiguous outcomes require auditable error code; terminal success cannot carry one.
  if ((entry.status === "failed" || entry.status === "ambiguous") !== (entry.errorCode !== undefined)) return false;
  let canonicalAt: string;
  try { canonicalAt = new Date(entry.at).toISOString(); } catch { return false; }
  if (canonicalAt !== entry.at) return false;
  // Hash chain validation
  const { hash: _hash, ...rest } = entry;
  return _hash === digest(rest);
}

/**
 * Read full chain, validate every entry, check integrity.
 * Throws E_CONFIG_INVALID on corrupt entry.
 * Returns empty array when no journal file exists (ENOENT).
 */
export async function readDatabaseJournal(cwd: string): Promise<DatabaseJournalEntry[]> {
  let text: string;
  try {
    text = await readFile(databaseJournalPath(cwd), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const entries: DatabaseJournalEntry[] = [];
  let previous: string | null = null;
  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw err("E_CONFIG_INVALID", "database journal corrupt"); }
    // Reject unknown fields: serialize back and compare keys
    if (!parsed || typeof parsed !== "object") throw err("E_CONFIG_INVALID", "database journal corrupt");
    // Validate full schema + hash chain
    if (!validateEntry(parsed)) throw err("E_CONFIG_INVALID", "database journal corrupt");
    const entry = parsed as DatabaseJournalEntry;
    if (entry.previousHash !== previous) throw err("E_CONFIG_INVALID", "database journal corrupt");
    entries.push(entry);
    previous = entry.hash;
  }
  return entries;
}

export async function appendDatabaseJournal(
  cwd: string,
  entry: Omit<DatabaseJournalEntry, "previousHash" | "hash">,
): Promise<DatabaseJournalEntry> {
  const all = await readDatabaseJournal(cwd);
  const previousHash = all.at(-1)?.hash ?? null;
  const full = { ...entry, previousHash };
  const complete: DatabaseJournalEntry = { ...full, hash: digest(full) };
  // Validate semantic invariants before writing.
  if (!validateEntry(complete)) {
    throw err("E_CONFIG_INVALID", "database journal entry invalid");
  }
  await mkdir(dirname(databaseJournalPath(cwd)), { recursive: true });
  await appendFile(databaseJournalPath(cwd), `${JSON.stringify(complete)}\n`, "utf8");
  return complete;
}

/**
 * Preflight replay check: read full chain before filtering.
 * Rejects committed/ambiguous/dangling-started plans.
 * Allows manual retry for failed terminal status.
 */
export async function assertDatabaseReplayAllowed(cwd: string, planId: string, planDigest: string): Promise<void> {
  const entries = await readDatabaseJournal(cwd);
  const matching = entries.filter((e) => e.planId === planId && e.planDigest === planDigest);
  if (matching.some((e) => e.status === "committed" || e.status === "ambiguous") || matching.at(-1)?.status === "started") {
    throw err("E_STATE_CONFLICT", "database plan replay blocked");
  }
}
