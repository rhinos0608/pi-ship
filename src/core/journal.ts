import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ShipError } from "./errors.js";

export interface JournalEntry {
  ts: string;
  planId: string;
  step: string;
  status: "start" | "ok" | "fail";
  resourceRef?: string;
  error?: ShipError;
}

export function journalPath(cwd: string): string {
  return join(cwd, ".pi-ship", "journal.jsonl");
}

export async function appendJournal(cwd: string, entry: JournalEntry): Promise<void> {
  const path = journalPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export async function readJournal(cwd: string, planId?: string): Promise<JournalEntry[]> {
  const path = journalPath(cwd);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (!planId || parsed.planId === planId) {
        entries.push(parsed);
      }
    } catch {
      // skip corrupted lines
    }
  }
  return entries;
}
