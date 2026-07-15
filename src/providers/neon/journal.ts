import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { err, isShipError, type ShipError } from "../../core/errors.js";

export interface JournalEntry {
  ts: string;
  planId: string;
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
  step: Type.String(),
  status: Type.Union([Type.Literal("start"), Type.Literal("ok"), Type.Literal("fail")]),
  resourceRef: Type.Optional(Type.String()),
  error: Type.Optional(ErrorSchema),
}, { additionalProperties: false });

export function journalPath(cwd: string): string {
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

export async function readJournal(cwd: string, planId?: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(journalPath(cwd), "utf8");
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
    const normalized = normalizeLegacyError(parsed);
    if (!Value.Check(JournalEntrySchema, normalized)) {
      throw err("E_STATE_CONFLICT", "journal entry has invalid shape");
    }
    if (!planId || normalized.planId === planId) entries.push(normalized);
  }
  return entries;
}

function normalizeLegacyError(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const entry = value as Record<string, unknown>;
  if (!entry.error || typeof entry.error !== "object") return value;
  const errorRecord = entry.error as Record<string, unknown>;
  if (errorRecord.message !== undefined) return value;
  return {
    ...entry,
    error: { ...errorRecord, message: "legacy error message unavailable" },
  };
}
