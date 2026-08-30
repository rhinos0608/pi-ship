import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJournal, journalPath, readJournal } from "../../../src/providers/neon/journal.js";
import { err } from "../../../src/core/errors.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-neon-journal-"));
});

describe("Neon journal", () => {
  it("round-trips journal entry", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "ensureProject", status: "ok" });
    const entries = await readJournal(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0].step).toBe("ensureProject");
    expect(entries[0].status).toBe("ok");
  });

  it("append creates file and preserves multiple entries", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "ensureProject", status: "ok" });
    await appendJournal(tmp, { ts: "t2", planId: "p1", step: "ensureBranch", status: "start" });
    const all = await readJournal(tmp, "p1");
    expect(all).toHaveLength(2);
    expect(all[0].step).toBe("ensureProject");
    expect(all[1].step).toBe("ensureBranch");
  });

  it("filters by planId", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "a", status: "ok" });
    await appendJournal(tmp, { ts: "t2", planId: "p2", step: "b", status: "ok" });
    const p2Entries = await readJournal(tmp, "p2");
    expect(p2Entries).toHaveLength(1);
    expect(p2Entries[0].planId).toBe("p2");
  });

  it("returns all entries when planId omitted", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "a", status: "ok" });
    await appendJournal(tmp, { ts: "t2", planId: "p2", step: "b", status: "ok" });
    const all = await readJournal(tmp);
    expect(all).toHaveLength(2);
  });

  it("entries are newline-delimited JSON", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "s", status: "ok" });
    const raw = await readFile(journalPath(tmp), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim()).step).toBe("s");
  });

  it("round-trips ShipError as plain error record", async () => {
    await appendJournal(tmp, {
      ts: "t1",
      planId: "p1",
      step: "deploy",
      status: "fail",
      error: err("E_PROVIDER", "boom", true),
    });
    const entries = await readJournal(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBeDefined();
    expect(entries[0].error!.code).toBe("E_PROVIDER");
    expect(entries[0].error!.message).toBe("boom");
    expect(entries[0].error!.retryable).toBe(true);
  });

  it("returns empty array when journal file does not exist", async () => {
    const entries = await readJournal(tmp);
    expect(entries).toEqual([]);
  });

  it("rejects malformed JSON line", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(journalPath(tmp), "not-json\n", "utf8");
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects any malformed line even with valid entries", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "s", status: "ok" })}\n` +
        "garbage\n",
      "utf8",
    );
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects entry with invalid shape (missing required fields)", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1" })}\n`,
      "utf8",
    );
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects entry with extra unknown fields", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "s", status: "ok", extra: true })}\n`,
      "utf8",
    );
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects entry with invalid status", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "s", status: "invalid" })}\n`,
      "utf8",
    );
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });
});

// ── Legacy path migration tests ─────────────────────────────────────────────
// Uses fresh tmpdir per test to avoid pollution from shared `tmp`.
describe("Neon legacy path migration", () => {
  const LEGACY_JOURNAL = join(".pi-ship", "journal.jsonl");
  const STATE_JSON = join(".pi-ship", "state.json");

  /** Build a valid Neon state.json object with the given history planIds. */
  function neonStateWithHistory(planIds: string[]): Record<string, unknown> {
    return {
      provider: "neon", version: 1, branchIds: {}, connectionUris: {},
      history: planIds.map((id) => ({ planId: id, digest: `d-${id}`, status: "ok", at: "2026-01-01T00:00:00.000Z" })),
      restorePoints: [],
    };
  }

  it("reads entries from legacy path when new path absent (ownership verified)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-legacy-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    await writeFile(
      join(cwd, LEGACY_JOURNAL),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "deploy", status: "start" })}\n` +
      `${JSON.stringify({ ts: "t2", planId: "p1", step: "deploy", status: "ok", resourceRef: "branch-1" })}\n`,
      "utf8"
    );
    // State history has matching planId → ownership verified
    await writeFile(join(cwd, STATE_JSON), JSON.stringify(neonStateWithHistory(["p1"])), "utf8");

    const entries = await readJournal(cwd);
    expect(entries).toHaveLength(2);
    expect(entries[0].planId).toBe("p1");
    expect(entries[1].resourceRef).toBe("branch-1");
  });

  it("reads mixed Railway+Neon legacy entries when ownership verified", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-mixed-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    // Railway entry (no planDigest) + Neon entry (has planDigest) — both pass Neon schema
    await writeFile(
      join(cwd, LEGACY_JOURNAL),
      `${JSON.stringify({ ts: "t1", planId: "railway-p1", step: "deploy", status: "start" })}\n` +
      `${JSON.stringify({ ts: "t2", planId: "neon-p1", planDigest: "d1", step: "ensureProject", status: "ok" })}\n`,
      "utf8"
    );
    // State matches Neon planId → ownership verified
    await writeFile(join(cwd, STATE_JSON), JSON.stringify(neonStateWithHistory(["neon-p1"])), "utf8");

    const entries = await readJournal(cwd);
    expect(entries).toHaveLength(2);
    const planIds = entries.map((e) => e.planId);
    expect(planIds).toContain("railway-p1");
    expect(planIds).toContain("neon-p1");
  });

  it("returns empty array for fresh install (no files at all)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-fresh-"));
    await expect(readJournal(cwd)).resolves.toEqual([]);
  });

  it("adopts legacy entries when state history planId matches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-adopt-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    await writeFile(
      join(cwd, LEGACY_JOURNAL),
      `${JSON.stringify({ ts: "t1", planId: "adopted-plan", step: "deploy", status: "ok" })}\n`,
      "utf8"
    );
    await writeFile(join(cwd, STATE_JSON), JSON.stringify(neonStateWithHistory(["adopted-plan"])), "utf8");

    const entries = await readJournal(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].planId).toBe("adopted-plan");
  });

  it("fails closed when no matching planId in state history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-no-match-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    // Journal has planId "orphan" but state only knows about "other-plan"
    await writeFile(
      join(cwd, LEGACY_JOURNAL),
      `${JSON.stringify({ ts: "t1", planId: "orphan", step: "deploy", status: "ok" })}\n`,
      "utf8"
    );
    await writeFile(join(cwd, STATE_JSON), JSON.stringify(neonStateWithHistory(["other-plan"])), "utf8");

    await expect(readJournal(cwd)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("fails closed when state history is empty", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-neon-empty-history-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    await writeFile(
      join(cwd, LEGACY_JOURNAL),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "deploy", status: "ok" })}\n`,
      "utf8"
    );
    // State exists but history is empty → no ownership proof
    await writeFile(join(cwd, STATE_JSON), JSON.stringify(neonStateWithHistory([])), "utf8");

    await expect(readJournal(cwd)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });
});
