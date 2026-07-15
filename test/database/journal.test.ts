import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { appendDatabaseJournal, readDatabaseJournal, assertDatabaseReplayAllowed, type DatabaseJournalEntry } from "../../src/database/journal.js";

const hex64 = "0000000000000000000000000000000000000000000000000000000000000000";
const hex64b = "1111111111111111111111111111111111111111111111111111111111111111";

function entry(overrides: Partial<DatabaseJournalEntry> = {}): Omit<DatabaseJournalEntry, "previousHash" | "hash"> {
  return {
    version: 1,
    planId: "plan-1",
    planDigest: hex64,
    targetFingerprint: hex64,
    providerFingerprint: hex64,
    manifestFingerprint: hex64,
    sqlFingerprint: hex64,
    paramFingerprint: hex64,
    environment: "development",
    risk: "write",
    statementCount: 1,
    status: "committed",
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("database journal", () => {
  it("rejects unknown fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await mkdir(join(cwd, ".pi-ship"), { recursive: true });
      const badLine = JSON.stringify({ ...entry(), messages: ["evil"], hash: hex64, previousHash: null });
      await writeFile(join(cwd, ".pi-ship", "database-journal.jsonl"), badLine + "\n");
      await expect(readDatabaseJournal(cwd)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects malformed JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await mkdir(join(cwd, ".pi-ship"), { recursive: true });
      await writeFile(join(cwd, ".pi-ship", "database-journal.jsonl"), "not-json\n");
      await expect(readDatabaseJournal(cwd)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects tampered hash chain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      const e1 = await appendDatabaseJournal(cwd, entry({ planId: "plan-1" }));
      const e2 = await appendDatabaseJournal(cwd, entry({ planId: "plan-2" }));
      await mkdir(join(cwd, ".pi-ship"), { recursive: true });
      // Corrupt e2's previousHash
      const filePath = join(cwd, ".pi-ship", "database-journal.jsonl");
      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n");
      const e2Parsed = JSON.parse(lines[1]!);
      e2Parsed.previousHash = "0000000000000000000000000000000000000000000000000000000000000000";
      e2Parsed.hash = undefined; // force recompute — but actually it won't match
      await writeFile(filePath, lines[0] + "\n" + JSON.stringify(e2Parsed) + "\n");
      await expect(readDatabaseJournal(cwd)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects earlier-line corruption even when requested plan differs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      const e1 = await appendDatabaseJournal(cwd, entry({ planId: "plan-1" }));
      await mkdir(join(cwd, ".pi-ship"), { recursive: true });
      // Corrupt first line
      const filePath = join(cwd, ".pi-ship", "database-journal.jsonl");
      const content = await readFile(filePath, "utf8");
      await writeFile(filePath, "{}\n" + content);
      // Reading whole file should fail
      await expect(readDatabaseJournal(cwd)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      // assertDatabaseReplayAllowed also fails because it reads full chain first
      await expect(assertDatabaseReplayAllowed(cwd, "plan-2", hex64b)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("requires error codes for failed outcomes and forbids them on committed outcomes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await expect(appendDatabaseJournal(cwd, entry({ status: "failed" }))).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(appendDatabaseJournal(cwd, entry({ status: "ambiguous" }))).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(appendDatabaseJournal(cwd, entry({ status: "started", errorCode: "E_EXECUTION_FAILED" }))).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(appendDatabaseJournal(cwd, entry({ status: "committed", errorCode: "E_EXECUTION_FAILED" }))).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("allows terminal failed for manual retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await appendDatabaseJournal(cwd, entry({ planId: "plan-1", status: "failed", errorCode: "E_EXECUTION_FAILED" }));
      await expect(assertDatabaseReplayAllowed(cwd, "plan-1", hex64)).resolves.toBeUndefined();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("blocks committed replay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await appendDatabaseJournal(cwd, entry({ planId: "plan-1", status: "committed" }));
      await expect(assertDatabaseReplayAllowed(cwd, "plan-1", hex64)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects dangling started", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await appendDatabaseJournal(cwd, entry({ planId: "plan-1", status: "started" }));
      await expect(assertDatabaseReplayAllowed(cwd, "plan-1", hex64)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("returns empty array for missing file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      await expect(readDatabaseJournal(cwd)).resolves.toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("validates chain on append", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journal-"));
    try {
      const e1 = await appendDatabaseJournal(cwd, entry({ planId: "plan-1", status: "started" }));
      expect(e1.previousHash).toBeNull();
      expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
      const e2 = await appendDatabaseJournal(cwd, entry({ planId: "plan-1", status: "committed" }));
      expect(e2.previousHash).toBe(e1.hash);
      expect(e2.hash).toMatch(/^[0-9a-f]{64}$/);
      const all = await readDatabaseJournal(cwd);
      expect(all).toHaveLength(2);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
