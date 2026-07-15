import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendOperationEntry, computeEntryHash, operationJournalPath, readOperationJournal, type OperationJournalEntry } from "../../../src/providers/vercel/operation-journal.js";

describe("operation journal contract", () => {
  const entry = { version: 2 as const, ts: "2026-01-01", planId: "p", planDigest: "d", provider: "vercel" as const, domain: "app" as const, operationId: "o", kind: "deploy" as const, targetFingerprint: "t", requestFingerprint: "r", expectedStateFingerprint: "s", attempt: 1, status: "start" as const };
  it("requires positive integer attempt and validates before write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-operation-"));
    await expect(appendOperationEntry(cwd, { ...entry, attempt: 0 })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(readOperationJournal(cwd)).resolves.toEqual([]);
  });
  it("rejects unknown fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-operation-"));
    await expect(appendOperationEntry(cwd, { ...entry, extra: true } as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("accepts every strict journal variant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-operation-"));
    const variants = [
      { status: "start" },
      { status: "ok", resourceRef: "release", observedStateFingerprint: "s", releaseStatus: "queued", releaseUrl: "https://site.vercel.app" },
      { status: "fail", error: { code: "E_PROVIDER", message: "failed", retryable: false } },
      { status: "ambiguous", reason: "transport", safeMessage: "unknown" },
      { status: "ambiguous", reason: "conflict", safeMessage: "mismatch", resourceRef: "dpl_1" },
      { status: "reconciled", outcome: "matches_expected", observedStateFingerprint: "s", resourceRef: "release", releaseStatus: "ready", releaseUrl: "https://site.vercel.app" },
      { status: "reconciled", outcome: "not_applied", observedStateFingerprint: "absent" },
      { status: "reconciled", outcome: "conflict", observedStateFingerprint: "other" },
      { status: "reconciled", outcome: "unverified", reason: "rate_limited", safeMessage: "try later" },
    ] as const;
    for (let index = 0; index < variants.length; index += 1) {
      await appendOperationEntry(cwd, { ...entry, operationId: `o-${index}`, ...variants[index] } as never);
    }
    await expect(readOperationJournal(cwd)).resolves.toHaveLength(variants.length);
  });

  it("rejects invalid release status and empty release URL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-operation-"));
    await expect(appendOperationEntry(cwd, {
      ...entry,
      status: "ok",
      resourceRef: "release",
      observedStateFingerprint: "s",
      releaseStatus: "unknown-provider-state",
    } as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(appendOperationEntry(cwd, {
      ...entry,
      status: "reconciled",
      outcome: "matches_expected",
      resourceRef: "release",
      observedStateFingerprint: "s",
      releaseUrl: "",
    } as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("different planDigest produces different entry hash for otherwise identical entries", async () => {
    const base: Omit<OperationJournalEntry, "entryHash"> = { ...entry, previousHash: null } as Omit<OperationJournalEntry, "entryHash">;
    expect(computeEntryHash({ ...base, planDigest: "a" })).not.toBe(computeEntryHash({ ...base, planDigest: "b" }));
  });

  it("tampering persisted planDigest without recomputing hash fails chain validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-operation-"));
    await appendOperationEntry(cwd, { ...entry, planId: "p1", operationId: "o1" });
    await appendOperationEntry(cwd, { ...entry, planId: "p2", operationId: "o2" });
    const path = operationJournalPath(cwd);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.planDigest = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(readOperationJournal(cwd, { planId: "p2" })).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("validates the physical chain before filtering another plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-operation-"));
    await appendOperationEntry(cwd, { ...entry, planId: "p1", operationId: "o1" });
    await appendOperationEntry(cwd, { ...entry, planId: "p2", operationId: "o2" });
    const path = operationJournalPath(cwd);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.planId = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(readOperationJournal(cwd, { planId: "p2" })).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });
});
