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
