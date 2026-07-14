import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJournal, journalPath, readJournal } from "../../src/core/journal.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-journal-"));
});

describe("journal", () => {
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
});
