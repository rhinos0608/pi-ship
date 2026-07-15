import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJournal, journalPath, readJournal } from "../../../src/providers/railway/journal.js";
import { err } from "../../../src/core/errors.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-journal-"));
});

describe("journal", () => {
  it("round-trips ShipError message as plain enumerable error record", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "deploy", status: "fail", error: err("E_PROVIDER", "boom", true) });
    await expect(readJournal(tmp)).resolves.toMatchObject([{ error: { code: "E_PROVIDER", message: "boom", retryable: true } }]);
  });

  it("reads legacy fail entries whose Error message was not enumerable", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "deploy", status: "fail", error: { code: "E_PROVIDER", retryable: false } })}\n`,
      "utf8"
    );
    await expect(readJournal(tmp)).resolves.toMatchObject([
      { error: { code: "E_PROVIDER", message: "legacy error message unavailable", retryable: false } },
    ]);
  });
  it("append creates file and preserves entries", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "ensureProject", status: "ok" });
    await appendJournal(tmp, { ts: "t2", planId: "p1", step: "deploy", status: "start" });
    const all = await readJournal(tmp, "p1");
    expect(all).toHaveLength(2);
    expect(all[1].step).toBe("deploy");
  });

  it("filters by planId", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "a", status: "ok" });
    await appendJournal(tmp, { ts: "t2", planId: "p2", step: "b", status: "ok" });
    const p2 = await readJournal(tmp, "p2");
    expect(p2).toHaveLength(1);
    expect(p2[0].planId).toBe("p2");
  });

  it("entries are newline-delimited JSON", async () => {
    await appendJournal(tmp, { ts: "t1", planId: "p1", step: "s", status: "ok" });
    const raw = await readFile(journalPath(tmp), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim()).step).toBe("s");
  });

  it("rejects malformed JSON line (fail-closed)", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(journalPath(tmp), "not-json\n", "utf8");
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects when any line is malformed, even if other lines are valid", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "s", status: "ok" })}\n` +
        `garbage\n` +
        `${JSON.stringify({ ts: "t2", planId: "p1", step: "s2", status: "ok" })}\n`,
      "utf8"
    );
    await expect(readJournal(tmp, "p1")).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects entry with invalid shape", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "p1", step: "s", status: "ok" })}\n` +
        `${JSON.stringify({ ts: "t2" })}\n`,
      "utf8"
    );
    await expect(readJournal(tmp)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("rejects unknown fields and malformed nested errors before filtering", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(
      journalPath(tmp),
      `${JSON.stringify({ ts: "t1", planId: "other", step: "s", status: "fail", error: { code: "E_PROVIDER", retryable: false }, extra: true })}\n`,
      "utf8"
    );
    await expect(readJournal(tmp, "wanted")).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });
});
