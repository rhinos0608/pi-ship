import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { err, isShipError, type ShipError } from "../../core/errors.js";
import { readPersisted } from "../../persistence/state-store.js";

export interface JournalEntry {
  ts: string;
  planId: string;
  planDigest?: string;
  step: string;
  status: "start" | "ok" | "fail";
  resourceRef?: string;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}

const ErrorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  retryable: Type.Boolean(),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

export const JournalEntrySchema = Type.Object({
  ts: Type.String(),
  planId: Type.String(),
  planDigest: Type.Optional(Type.String()),
  step: Type.String(),
  status: Type.Union([Type.Literal("start"), Type.Literal("ok"), Type.Literal("fail")]),
  resourceRef: Type.Optional(Type.String()),
  error: Type.Optional(ErrorSchema),
}, { additionalProperties: false });

/** New provider-specific journal path. */
export function journalPath(cwd: string): string {
  return join(cwd, ".pi-ship", "neon-journal.jsonl");
}

/** Legacy shared path (also used by Railway). */
function legacyPath(cwd: string): string {
  return join(cwd, ".pi-ship", "journal.jsonl");
}

export async function appendJournal(cwd: string, entry: JournalEntry): Promise<void> {
  const normalized: JournalEntry = isShipError(entry.error)
    ? { ...entry, error: plainError(entry.error) }
    : entry;
  if (!Value.Check(JournalEntrySchema, normalized)) {
    throw err("E_STATE_CONFLICT", "journal entry has invalid shape");
  }
  const path = journalPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(normalized) + "\n", "utf8");
}

function plainError(error: ShipError): NonNullable<JournalEntry["error"]> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/**
 * Read Neon journal entries from the new provider-specific path.
 * Falls back to the legacy shared path using state ownership verification.
 *
 * Since Railway entries (no `planDigest`) are schema-compatible with Neon's
 * schema (`planDigest` is optional), we cannot distinguish them by schema alone.
 * To adopt legacy entries we require that the persisted Neon state references
 * a planId found in the legacy journal — proving ownership. Without this proof
 * we fail closed with a recovery message.
 */
export async function readJournal(cwd: string, planId?: string, planDigest?: string): Promise<JournalEntry[]> {
  // 1. Try new provider-specific path first
  const newEntries = await readFileLines(journalPath(cwd), planId, planDigest);
  if (newEntries.length > 0) return newEntries;

  // 2. Try legacy shared path
  let legacyText: string;
  try {
    legacyText = await readFile(legacyPath(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  // 3. Parse all legacy entries
  const allEntries: JournalEntry[] = [];
  for (const line of legacyText.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw err("E_STATE_CONFLICT", "legacy journal.jsonl contains malformed entry; manual review required");
    }
    if (!Value.Check(JournalEntrySchema, parsed)) {
      throw err("E_STATE_CONFLICT",
        "legacy journal.jsonl contains entries that are not valid Neon journal entries. "
        + "This may happen when Railway and Neon share the same legacy journal file. "
        + "Migration: each provider now writes to its own path. "
        + "To recover, move Neon entries to neon-journal.jsonl and Railway entries to railway-journal.jsonl, "
        + "then retry.");
    }
    allEntries.push(parsed as JournalEntry);
  }

  // 4. Verify ownership via persisted Neon state — at least one planId must appear in state history
  const state = await readPersisted(cwd);
  const statePlanIds = extractStatePlanIds(state);
  const journalPlanIds = new Set(allEntries.map((e) => e.planId));
  const matchFound = statePlanIds.some((id: string) => journalPlanIds.has(id));

  if (!matchFound) {
    throw err("E_STATE_CONFLICT",
      "legacy journal.jsonl exists but no matching Neon state history found. "
      + "This file may belong to Railway or another provider. "
      + "Migration: each provider now writes to its own journal path. "
      + "To recover, verify ownership of the entries and move them to neon-journal.jsonl, then retry.");
  }

  // 5. Filter by planId/planDigest if provided
  let filtered = allEntries;
  if (planId) {
    filtered = filtered.filter((e) => e.planId === planId);
  }
  if (planDigest) {
    filtered = filtered.filter((e) => e.planDigest === planDigest);
  }
  return filtered;
}

async function readFileLines(path: string, planId?: string, planDigest?: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw err("E_STATE_CONFLICT", "journal contains malformed entry; manual review required");
    }
    if (!Value.Check(JournalEntrySchema, parsed)) {
      throw err("E_STATE_CONFLICT", "journal entry has invalid shape");
    }
    const entry = parsed as JournalEntry;
    if (planId && entry.planId !== planId) continue;
    if (planDigest && entry.planDigest !== planDigest) continue;
    entries.push(entry);
  }
  return entries;
}

/** Extract planIds from persisted state history. */
function extractStatePlanIds(state: unknown): string[] {
  if (!state || typeof state !== "object") return [];
  const s = state as Record<string, unknown>;
  if (!Array.isArray(s.history)) return [];
  return (s.history as Array<Record<string, unknown>>)
    .filter((h): h is { planId: string } => typeof h === "object" && h !== null && typeof h.planId === "string")
    .map((h) => h.planId);
}
