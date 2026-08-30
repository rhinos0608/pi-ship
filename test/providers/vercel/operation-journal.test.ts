import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

// ── Legacy path migration tests ─────────────────────────────────────────────
describe("Vercel legacy path migration", () => {
  type VercelEntry = Extract<OperationJournalEntry, { provider: "vercel" }>;
  type VercelStartEntry = Extract<VercelEntry, { status: "start" }>;
  type VercelStartWithoutHash = Omit<VercelStartEntry, "entryHash">;
  /** Helper: build a chain-validated Vercel entry for writing directly to disk. */
  function makeVercelEntry(
    overrides: Partial<VercelStartWithoutHash> & { operationId: string; planId: string; planDigest?: string },
    previousHash: string | null,
  ): VercelStartEntry {
    const base: VercelStartWithoutHash = {
      version: 2 as const, ts: "2026-01-01T00:00:00.000Z",
      planDigest: "d1", provider: "vercel" as const, domain: "app" as const,
      kind: "deploy" as const, targetFingerprint: "t1", requestFingerprint: "r1",
      expectedStateFingerprint: "s1", attempt: 1, status: "start" as const,
      ...overrides, previousHash,
    };
    const entryHash = computeEntryHash(base);
    return { ...base, entryHash };
  }

  /** Helper: build a chain-validated Cloudflare entry for writing directly to disk. */
  function makeCloudflareEntry(
    overrides: Partial<Record<string, unknown>> & { operationId: string; planId: string; planDigest?: string },
    previousHash: string | null,
  ): Record<string, unknown> {
    const base = {
      version: 1, ts: "2026-01-01T00:00:00.000Z",
      planDigest: "d2", provider: "cloudflare",
      kind: "deploy", targetFingerprint: "tf1", requestFingerprint: "rf1",
      expectedStateFingerprint: "esf1", attempt: 1, status: "start",
      ...overrides, previousHash,
    };
    const entryHash = computeEntryHash(base);
    return { ...base, entryHash };
  }

  it("reads entries from legacy shared path when new provider-specific path does not exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vc-legacy-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    const entry1 = makeVercelEntry({ planId: "p1", operationId: "o1" }, null);

    // Write ONLY to legacy path — new path (.pi-ship/vercel-operation-journal.jsonl) absent
    await writeFile(join(cwd, ".pi-ship", "operation-journal.jsonl"), JSON.stringify(entry1) + "\n", "utf8");

    const entries = await readOperationJournal(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].planId).toBe("p1");
    expect(entries[0].operationId).toBe("o1");
  });

  it("filters own entries from mixed-provider legacy file (Vercel + Cloudflare interleaved)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vc-mixed-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    // Entry 1: Vercel
    const vc1 = makeVercelEntry({ planId: "vc-p1", operationId: "vc-o1" }, null);
    // Entry 2: Cloudflare (interleaved — chain must be valid across providers)
    const cf1 = makeCloudflareEntry({ planId: "cf-p1", operationId: "cf-o1" }, vc1.entryHash);
    // Entry 3: Vercel
    const vc2 = makeVercelEntry({ planId: "vc-p2", operationId: "vc-o2" }, cf1.entryHash as string);

    await writeFile(
      join(cwd, ".pi-ship", "operation-journal.jsonl"),
      [JSON.stringify(vc1), JSON.stringify(cf1), JSON.stringify(vc2)].join("\n") + "\n",
      "utf8"
    );

    const entries = await readOperationJournal(cwd);
    // Vercel reader validates full chain, then filters by Vercel schema only
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.provider === "vercel")).toBe(true);
    expect(entries.map((e) => e.planId)).toEqual(["vc-p1", "vc-p2"]);
  });

  it("returns empty array for fresh install (no legacy or new-path file)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vc-fresh-"));
    await expect(readOperationJournal(cwd)).resolves.toEqual([]);
  });
});
